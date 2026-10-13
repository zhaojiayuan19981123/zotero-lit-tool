// src/repair-text.ts
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

// src/model.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

// src/reading-order.ts
function orderPageBlocks(blocks) {
  const after = blocks.map(() => []), incoming = blocks.map(() => 0);
  for (let i = 0; i < blocks.length; i++)
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      const a = blocks[i].bounds, b = blocks[j].bounds;
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
  while (result.length < blocks.length) {
    const index = blocks.findIndex((_, i) => !used.has(i) && incoming[i] === 0);
    if (index < 0) return blocks;
    used.add(index);
    result.push(blocks[index]);
    for (const next of after[index]) incoming[next]--;
  }
  return result;
}

// src/layout.ts
function intersection(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
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

// src/repair.ts
async function repairTextBlocks(pdf, blocks) {
  const repaired = [], unmatched = /* @__PURE__ */ new Map();
  const pages = [...new Set(blocks.map((b) => b.page))].sort((a, b) => a - b);
  for (const number of pages) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      2,
      Math.sqrt(4e6 / (viewport.width * viewport.height))
    );
    const original = blocks.filter((b) => b.page === number);
    const spans = await extractTextSpans(page, scale);
    if (!spans.length) {
      repaired.push(...orderPageBlocks(original));
      continue;
    }
    const assigned = assignText(
      original.map((b) => ({ ...b, confidence: 1, order: 0 })),
      spans
    );
    repaired.push(
      ...orderPageBlocks(
        original.map((b, i) => ({ ...b, text: assigned.texts[i] }))
      )
    );
    if (assigned.unmatched) unmatched.set(number, assigned.unmatched);
    page.cleanup();
  }
  return { blocks: repaired, unmatched };
}

// src/repair-text.ts
// ★ Node 20 / Electron 33 兼容：pdf.js（含 legacy 构建）在 getDocument 时会调用
//   Promise.withResolvers —— 该 API 由 V8 12.4 / Node 22 引入，Node 20 运行时里不存在。
//   缺了它会在打开 PDF 的瞬间抛 "Promise.withResolvers is not a function"。
//   这里补一个语义一致的实现，只在缺失时生效，Node 22+ 完全不受影响。
//   改这里时记得同步 processor/src/repair-text.ts。
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
// ★ 同一类问题：pdf.js 的 worker 片段用 ArrayBuffer.prototype.transferToFixedLength 把打包好的
//   字体信息缩到实际长度（`const buffer = new ArrayBuffer(n); ... buffer.transferToFixedLength(off)`）。
//   该 API 由 V8 11.4 引入，Node 20 的 V8 11.3 还没有；缺失时 getOperatorList 会抛
//   "... is not a function"，页面渲染拿不到像素 → 识别结果全为 0。
//   退化为「按需复制」，对本用途语义等价（上游不依赖原缓冲被 detach）。
if (typeof ArrayBuffer.prototype.transferToFixedLength !== "function") {
  ArrayBuffer.prototype.transferToFixedLength = function transferToFixedLength(newLength) {
    const length = Number.isInteger(newLength) ? newLength : this.byteLength;
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(this.byteLength, length)));
    return out;
  };
}
if (typeof ArrayBuffer.prototype.transfer !== "function") {
  ArrayBuffer.prototype.transfer = function transfer(newLength) {
    const length = Number.isInteger(newLength) ? newLength : this.byteLength;
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(this.byteLength, length)));
    return out;
  };
}
// ★ process.getBuiltinModule 是 Node 22.3 才加入的 API（属 **Node 核心**，不是 V8 —— 所以
//   Electron 33 内置的 Node 20 同样没有）。pdf.js 在给页面里的内嵌图片造 canvas 时会调它
//   （NodeCanvasFactory._createCanvas），缺失时遇到带内嵌图的页面就抛
//   "process.getBuiltinModule is not a function"。用 createRequire 给一个等价实现。
if (typeof process.getBuiltinModule !== "function") {
  const compatRequire = createRequire(import.meta.url);
  process.getBuiltinModule = function getBuiltinModule(id) {
    return compatRequire(id.startsWith("node:") ? id : "node:" + id);
  };
}
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
var { values } = parseArgs({
  options: {
    input: { type: "string" },
    manifest: { type: "string" },
    output: { type: "string" }
  }
});
if (!values.input || !values.manifest || !values.output)
  throw new Error(
    "Usage: --input PDF --manifest manifest.json --output EMPTY_DIRECTORY"
  );
var input = resolve(values.input);
var output = resolve(values.output);
var manifest = JSON.parse(
  await readFile(resolve(values.manifest), "utf8")
);
if (await digest(input) !== manifest.inputSHA256)
  throw new Error("PDF hash does not match the cached layout");
await mkdir(output, { recursive: true, mode: 448 });
if ((await readdir(output)).length)
  throw new Error(
    "Output must be empty; no existing files will be overwritten"
  );
var require2 = createRequire(import.meta.url);
var assets = dirname(require2.resolve("pdfjs-dist/package.json"));
var { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
var task = getDocument({
  data: new Uint8Array(await readFile(input)),
  cMapUrl: join(assets, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + "/",
  wasmUrl: join(assets, "wasm") + "/",
  useSystemFonts: true
});
try {
  const pdf = await task.promise;
  if (pdf.numPages !== manifest.pages)
    throw new Error("PDF page count does not match cached layout");
  const repaired = await repairTextBlocks(pdf, manifest.blocks);
  const changed = repaired.blocks.filter(
    (b) => b.text !== manifest.blocks.find((old) => old.id === b.id)?.text
  ).map((b) => b.id);
  const sections = [];
  for (let page = 1; page <= manifest.pages; page++) {
    sections.push(`<!-- page:${page} -->`);
    for (const b of repaired.blocks.filter((b2) => b2.page === page)) {
      if (b.image)
        sections.push(
          `<!-- block:${b.id} type:${b.label} -->
[${b.label}: ${b.id}](${b.image})`
        );
      else if (b.text)
        sections.push(
          `<!-- block:${b.id} -->
${b.label === "doc_title" ? "# " : b.label === "paragraph_title" ? "## " : ""}${b.text}`
        );
    }
    if (repaired.unmatched.has(page))
      sections.push(
        `<!-- unmatched-text page:${page} -->
${repaired.unmatched.get(page)}`
      );
  }
  await writeFile(join(output, "paper.md"), sections.join("\n\n") + "\n", {
    flag: "wx",
    mode: 384
  });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      { ...manifest, blocks: repaired.blocks, textExtractionVersion: 2 },
      null,
      2
    ) + "\n",
    { flag: "wx", mode: 384 }
  );
  console.log(
    JSON.stringify({
      blocks: repaired.blocks.length,
      changed: changed.length,
      changedIds: changed,
      output
    })
  );
} finally {
  await task.destroy();
}
