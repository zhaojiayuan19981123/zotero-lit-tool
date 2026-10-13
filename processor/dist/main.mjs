// src/main.ts
import { createCanvas as createCanvas2, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import * as ort2 from "onnxruntime-node";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// src/detect.ts
import { createCanvas } from "@napi-rs/canvas";
import * as ort from "onnxruntime-node";

// src/reading-order.ts
function orderPageBlocks(blocks2) {
  const after = blocks2.map(() => []), incoming = blocks2.map(() => 0);
  for (let i = 0; i < blocks2.length; i++)
    for (let j = 0; j < blocks2.length; j++) {
      if (i === j) continue;
      const a = blocks2[i].bounds, b = blocks2[j].bounds;
      const shared = Math.max(
        0,
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      );
      if (shared / Math.min(a.width, b.width) >= 0.6 && a.y + a.height <= b.y) {
        after[i].push(j);
        incoming[j]++;
      }
    }
  const result = [], used = /* @__PURE__ */ new Set();
  while (result.length < blocks2.length) {
    const index = blocks2.findIndex((_, i) => !used.has(i) && incoming[i] === 0);
    if (index < 0) return blocks2;
    used.add(index);
    result.push(blocks2[index]);
    for (const next of after[index]) incoming[next]--;
  }
  return result;
}

// src/layout.ts
var labels = [
  "abstract",
  "algorithm",
  "aside_text",
  "chart",
  "content",
  "display_formula",
  "doc_title",
  "figure_title",
  "footer",
  "footer_image",
  "footnote",
  "formula_number",
  "header",
  "header_image",
  "image",
  "inline_formula",
  "number",
  "paragraph_title",
  "reference",
  "reference_content",
  "seal",
  "table",
  "text",
  "vertical_text",
  "vision_footnote"
];
var isAsset = (label) => ["chart", "image", "table", "display_formula", "inline_formula"].includes(
  label
);
function intersection(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function decodeRegions(data, width, height) {
  const boxes = [];
  for (let i = 0; i + 6 < data.length; i += 7) {
    const [cls, confidence, x1, y1, x2, y2, order] = Array.from(
      { length: 7 },
      (_, n) => Number(data[i + n])
    );
    if (![cls, confidence, x1, y1, x2, y2, order].every(Number.isFinite) || confidence < 0.5 || !labels[cls])
      continue;
    const x = Math.max(0, Math.min(1, x1 / width));
    const y = Math.max(0, Math.min(1, y1 / height));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(1, x2 / width) - x),
      height: Math.max(0, Math.min(1, y2 / height) - y)
    };
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (labels[cls] === "image" && bounds.width * bounds.height > 0.9) continue;
    boxes.push({ label: labels[cls], confidence, order, bounds });
  }
  const kept = [];
  for (const b of boxes.sort((a, b2) => b2.confidence - a.confidence)) {
    if (kept.some((a) => {
      const shared = intersection(a.bounds, b.bounds);
      const union2 = a.bounds.width * a.bounds.height + b.bounds.width * b.bounds.height - shared;
      return shared / union2 > (a.label === b.label ? 0.6 : 0.98);
    }))
      continue;
    kept.push(b);
  }
  return kept.sort((a, b) => a.order - b.order);
}
function assignText(regions, spans) {
  const texts = regions.map(() => []);
  const unmatched = [];
  for (const span of spans) {
    let best = -1, score = 0.2;
    regions.forEach((region, i) => {
      const overlap = intersection(region.bounds, span.bounds) / (span.bounds.width * span.bounds.height || 1);
      if (overlap > score) {
        score = overlap;
        best = i;
      }
    });
    if (best < 0) unmatched.push(span);
    else texts[best].push(span);
  }
  return {
    texts: texts.map(
      (t, i) => preformatted.has(regions[i].label) ? joinLines(t) : joinSpans(t)
    ),
    unmatched: joinSpans(unmatched)
  };
}
var preformatted = /* @__PURE__ */ new Set(["algorithm"]);
var sameLine = (a, b) => Math.abs(a.bounds.y - b.bounds.y) < Math.min(a.bounds.height, b.bounds.height) * 0.45;
var readingSort = (spans) => [...spans].sort(
  (a, b) => sameLine(a, b) ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y
);
function joinSpans(spans) {
  return readingSort(spans).map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
}
function joinLines(spans) {
  if (!spans.length) return "";
  const lines = [];
  for (const span of readingSort(spans)) {
    const line = lines.at(-1);
    if (line && sameLine(line[0], span)) line.push(span);
    else lines.push([span]);
  }
  const widths = spans.map((s) => s.bounds.width / Math.max(1, s.text.trim().length)).sort((a, b) => a - b);
  const char = widths[Math.floor(widths.length / 2)] || 1;
  const spaces = (gap, least) => " ".repeat(
    gap <= char * 0.15 ? 0 : Math.min(40, Math.max(least, Math.round(gap / char)))
  );
  const left = Math.min(...spans.map((s) => s.bounds.x));
  return lines.map((line) => {
    let text = spaces(line[0].bounds.x - left, 0), end = line[0].bounds.x;
    line.forEach((span, i) => {
      if (i) text += spaces(span.bounds.x - end, 1);
      text += span.text.replace(/\s+/g, " ").trim();
      end = Math.max(end, span.bounds.x + span.bounds.width);
    });
    return text.trimEnd();
  }).join("\n");
}
var mainCaption = /^(?:figure|fig\.?|table)\s*\d+[\s:.]/i;
function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y
  };
}
function readingRegions(raw, spans) {
  const regions = raw.filter((r) => r.label !== "inline_formula");
  const assigned = assignText(regions, spans);
  const entries = regions.map((r, i) => ({
    ...r,
    text: assigned.texts[i]
  }));
  const captions = entries.filter(
    (r) => r.label === "figure_title" && mainCaption.test(r.text)
  );
  const groups = /* @__PURE__ */ new Map();
  for (const asset of entries.filter(
    (r) => ["chart", "image", "table"].includes(r.label)
  )) {
    const b = asset.bounds;
    const eligible = captions.filter((c) => {
      if (asset.label === "table" !== /^table/i.test(c.text)) return false;
      const cb = c.bounds;
      const gap = asset.label === "table" ? Math.min(
        Math.abs(cb.y - b.y - b.height),
        Math.abs(b.y - cb.y - cb.height)
      ) : cb.y - b.y - b.height;
      const center = b.x + b.width / 2;
      if (gap < -0.01 || gap > 0.12 || center < cb.x - Math.min(0.12, cb.width / 4) || center > cb.x + cb.width + Math.min(0.12, cb.width / 4))
        return false;
      return !entries.some(
        (r) => r !== asset && r !== c && (r.label === "text" || r.label === "paragraph_title" || mainCaption.test(r.text)) && r.bounds.y > b.y + b.height && r.bounds.y + r.bounds.height < cb.y && center >= r.bounds.x && center <= r.bounds.x + r.bounds.width
      );
    }).sort(
      (a, z) => Math.abs(a.bounds.y - b.y - b.height) - Math.abs(z.bounds.y - b.y - b.height)
    );
    const caption = eligible[0];
    if (caption) groups.set(caption, [...groups.get(caption) ?? [], asset]);
  }
  const consumed = /* @__PURE__ */ new Set();
  const merged = [];
  for (const [caption, assets2] of groups) {
    let bounds = union([caption.bounds, ...assets2.map((a) => a.bounds)]);
    const parts = entries.filter(
      (r) => r.label === "figure_title" && !mainCaption.test(r.text) && intersection(r.bounds, bounds) / (r.bounds.width * r.bounds.height) > 0.8
    );
    const members = [...assets2, ...parts, caption];
    bounds = union(members.map((r) => r.bounds));
    members.forEach((r) => consumed.add(r));
    const text = assignText([{ ...assets2[0], bounds }], spans).texts[0];
    merged.push({
      ...assets2[0],
      bounds,
      text,
      caption: caption.text,
      order: Math.min(...members.map((r) => r.order)),
      confidence: Math.min(...assets2.map((r) => r.confidence)),
      members: members.map((r) => r.order)
    });
  }
  return orderPageBlocks(
    [...entries.filter((r) => !consumed.has(r)), ...merged].sort(
      (a, b) => a.order - b.order
    )
  );
}

// src/model.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// model.json
var model_default = {
  name: "PP-DocLayoutV3-FP16",
  repository: "bu44er/PP-DocLayoutV3-FP16-ONNX",
  revision: "58dfa00ba1135e027817cbd5802f1f0df62aa5c0",
  file: "PP-DocLayoutV3-fp16.onnx",
  sha256: "8bb693ed3b5dcc1cf926b15d89dfe6abf62bc11cdd0afd33c8ffe039db6f8209",
  bytes: 67372587,
  output: "det"
};

// src/model.ts
var model = model_default;
var modelFilename = `${model.name}-${model.revision}.onnx`;
var bundledModelPath = fileURLToPath(
  new URL(`./models/${modelFilename}`, import.meta.url)
);
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyModel(path, expected = model) {
  if ((await stat(path)).size !== expected.bytes || await digest(path) !== expected.sha256)
    throw new Error("\u7248\u9762\u6A21\u578B\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u6784\u5EFA\u6216\u5B89\u88C5 Reader");
}
async function resolveModel(path = bundledModelPath) {
  try {
    await verifyModel(path);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("\u672A\u627E\u5230\u5185\u7F6E\u7248\u9762\u6A21\u578B\uFF0C\u8BF7\u91CD\u65B0\u6784\u5EFA\u6216\u5B89\u88C5 Reader");
    throw error;
  }
  return path;
}

// src/detect.ts
var size = 800;
async function detectRegions(session2, page) {
  const input2 = createCanvas(size, size), context = input2.getContext("2d");
  context.drawImage(page, 0, 0, size, size);
  const rgba = context.getImageData(0, 0, size, size).data;
  const area = size * size;
  const rgb = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    rgb[i] = rgba[i * 4] / 255;
    rgb[i + area] = rgba[i * 4 + 1] / 255;
    rgb[i + 2 * area] = rgba[i * 4 + 2] / 255;
  }
  const result = await session2.run(
    {
      image: new ort.Tensor("float32", rgb, [1, 3, size, size]),
      im_shape: new ort.Tensor(
        "float32",
        new Float32Array([size, size]),
        [1, 2]
      ),
      scale_factor: new ort.Tensor("float32", new Float32Array([1, 1]), [1, 2])
    },
    [model.output]
  );
  try {
    return decodeRegions(result[model.output].data, size, size);
  } finally {
    for (const tensor of Object.values(result)) tensor.dispose();
  }
}

// ../../packages/reader-core/src/pdf-text.ts
function pdfFontAscent(style) {
  const ascent = style?.ascent, descent = style?.descent;
  if (typeof ascent === "number" && Number.isFinite(ascent) && ascent > 0)
    return ascent;
  if (typeof descent === "number" && Number.isFinite(descent) && descent < 0 && descent > -1)
    return 1 + descent;
  return 0.8;
}

// src/text.ts
async function extractTextSpans(page, scale = 1) {
  const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  const content = await page.getTextContent();
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const transform = Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(transform[2], transform[3]);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    return [
      {
        text: item.str,
        bounds: {
          x: transform[4] / width,
          y: (transform[5] - h * ascent) / height,
          width: Math.abs(item.width * scale) / width,
          height: h / height
        }
      }
    ];
  });
}

// src/main.ts
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
var { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
var require2 = createRequire(import.meta.url);
var assets = dirname(require2.resolve("pdfjs-dist/package.json"));
var pdfRequire = createRequire(require2.resolve("pdfjs-dist/package.json"));
if (pdfRequire.resolve("@napi-rs/canvas") !== require2.resolve("@napi-rs/canvas"))
  throw new Error("PDF.js \u548C\u5904\u7406\u5668\u7684\u539F\u751F Canvas \u7248\u672C\u5FC5\u987B\u4E00\u81F4\uFF0C\u8BF7\u91CD\u65B0\u5B89\u88C5\u4F9D\u8D56");
var { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    model: { type: "string" },
    // Books parse one chapter at a time; omitted bounds cover the document.
    "from-page": { type: "string" },
    "to-page": { type: "string" },
    debug: { type: "boolean", default: false }
  }
});
if (!values.input || !values.output)
  throw new Error(
    "Usage: --input PDF --output DIRECTORY [--from-page N] [--to-page N] [--model FILE] [--debug]"
  );
var pageBound = (value) => {
  if (value === void 0) return void 0;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) throw new Error("\u9875\u7801\u65E0\u6548");
  return page;
};
var fromPage = pageBound(values["from-page"]);
var toPage = pageBound(values["to-page"]);
var input = resolve(values.input);
var output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 448 });
if ((await readdir(output)).length)
  throw new Error("\u8F93\u51FA\u76EE\u5F55\u5FC5\u987B\u4E3A\u7A7A\uFF0C\u907F\u514D\u8986\u76D6\u5DF2\u6709\u89E3\u6790\u7A3F\u6216\u7528\u6237\u4FEE\u8BA2");
await mkdir(join(output, "assets"), { recursive: true, mode: 448 });
var modelPath = await resolveModel(values.model && resolve(values.model));
var session = await ort2.InferenceSession.create(modelPath, {
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  executionProviders: ["cpu"]
});
var file = await readFile(input);
if (file.byteLength > 100 * 1024 * 1024) throw new Error("PDF \u8D85\u8FC7 100 MB");
var loading = getDocument({
  data: new Uint8Array(file),
  useSystemFonts: true,
  cMapUrl: join(assets, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + "/",
  wasmUrl: join(assets, "wasm") + "/"
});
var blocks = [];
var warnings = [];
var incompletePages = [];
var sections = [];
var timings = [];
var start = performance.now();
try {
  const pdf = await loading.promise;
  if (pdf.numPages > 1e3) throw new Error("PDF \u8D85\u8FC7\u672C\u8F6E\u5904\u7406\u4E0A\u9650\uFF081000 \u9875\uFF09");
  const first = fromPage ?? 1, last = Math.min(toPage ?? pdf.numPages, pdf.numPages);
  if (first > last) throw new Error("\u9875\u7801\u8303\u56F4\u65E0\u6548");
  const metadata = await pdf.getMetadata();
  for (let number = first; number <= last; number++) {
    const pageStart = performance.now();
    const page = await pdf.getPage(number);
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(
      2,
      Math.sqrt(4e6 / (original.width * original.height))
    );
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas2(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const context = canvas.getContext("2d");
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: "white"
    }).promise;
    const regions = await detectRegions(session, canvas);
    const spans = await extractTextSpans(page, scale);
    if (!spans.length) incompletePages.push(number);
    if (!spans.length)
      warnings.push(`\u7B2C ${number} \u9875\u65E0\u53EF\u63D0\u53D6\u6587\u5B57\uFF1B\u5C1A\u672A\u63A5\u5165 OCR\uFF0C\u6B63\u6587\u4E0D\u5B8C\u6574\u3002`);
    const composed = readingRegions(regions, spans);
    const assigned = assignText(composed, spans);
    const pageBlocks = composed.map((region, i) => ({
      ...region,
      id: `p${number}-b${i + 1}`,
      page: number,
      text: assigned.texts[i]
    }));
    for (const block of pageBlocks) {
      if (!isAsset(block.label)) continue;
      const b = block.bounds;
      const x = Math.max(0, Math.floor(b.x * canvas.width) - 3), y = Math.max(0, Math.floor(b.y * canvas.height) - 3);
      const width = Math.min(
        canvas.width - x,
        Math.ceil(b.width * canvas.width) + 6
      );
      const height = Math.min(
        canvas.height - y,
        Math.ceil(b.height * canvas.height) + 6
      );
      const crop = createCanvas2(width, height);
      crop.getContext("2d").drawImage(canvas, x, y, width, height, 0, 0, width, height);
      block.image = `assets/${block.id}.png`;
      await writeFile(join(output, block.image), crop.toBuffer("image/png"), {
        mode: 384
      });
    }
    blocks.push(...pageBlocks);
    sections.push(`<!-- page:${number} -->`);
    for (const block of pageBlocks) {
      if (block.image)
        sections.push(
          `<!-- block:${block.id} type:${block.label} -->
[${block.label}: ${block.id}](${block.image})`
        );
      else if (block.text)
        sections.push(
          `<!-- block:${block.id} -->
${block.label === "doc_title" ? "# " : block.label === "paragraph_title" ? "## " : ""}${block.text}`
        );
    }
    if (assigned.unmatched) {
      sections.push(
        `<!-- unmatched-text page:${number} -->
${assigned.unmatched}`
      );
      warnings.push(`\u7B2C ${number} \u9875\u6709\u672A\u5F52\u5165\u7248\u9762\u5757\u7684\u6587\u5B57\uFF0C\u5DF2\u4FDD\u7559\u3002`);
    }
    if (values.debug) {
      await writeFile(
        join(output, `page-${number}.png`),
        canvas.toBuffer("image/png"),
        { mode: 384 }
      );
      context.lineWidth = 2;
      context.font = "16px sans-serif";
      for (const block of pageBlocks) {
        const b = block.bounds;
        context.strokeStyle = isAsset(block.label) ? "#e11d48" : "#2563eb";
        context.strokeRect(
          b.x * canvas.width,
          b.y * canvas.height,
          b.width * canvas.width,
          b.height * canvas.height
        );
        context.fillStyle = context.strokeStyle;
        context.fillText(
          `${block.id} ${block.label} ${block.confidence.toFixed(2)}`,
          b.x * canvas.width,
          Math.max(16, b.y * canvas.height)
        );
      }
      await writeFile(
        join(output, `layout-${number}.png`),
        canvas.toBuffer("image/png"),
        { mode: 384 }
      );
    }
    timings.push({
      page: number,
      milliseconds: Math.round(performance.now() - pageStart),
      regions: regions.length,
      assets: pageBlocks.filter((b) => b.image).length
    });
    process.stdout.write(
      JSON.stringify({
        event: "page",
        ...timings.at(-1),
        total: pdf.numPages
      }) + "\n"
    );
    page.cleanup();
  }
  const manifest = {
    schemaVersion: 1,
    textExtractionVersion: 2,
    inputSHA256: await digest(input),
    model,
    pages: pdf.numPages,
    // Present only for a page range; a full parse covers every page.
    ...fromPage || toPage ? {
      parsedPages: Array.from(
        { length: last - first + 1 },
        (_, i) => first + i
      )
    } : {},
    metadata: metadata.info,
    blocks,
    warnings,
    incompletePages,
    timings,
    elapsedMilliseconds: Math.round(performance.now() - start),
    peakRSSBytes: process.resourceUsage().maxRSS * 1024
  };
  await writeFile(join(output, "paper.md"), sections.join("\n\n") + "\n", {
    mode: 384
  });
  await writeFile(
    join(output, "manifest.json.part"),
    JSON.stringify(manifest, null, 2),
    { mode: 384 }
  );
  await rename(
    join(output, "manifest.json.part"),
    join(output, "manifest.json")
  );
  process.stdout.write(
    JSON.stringify({
      event: "done",
      pages: pdf.numPages,
      assets: blocks.filter((b) => b.image).length,
      elapsedMilliseconds: manifest.elapsedMilliseconds,
      peakRSSBytes: manifest.peakRSSBytes
    }) + "\n"
  );
} finally {
  await loading.destroy();
  await session.release();
}
