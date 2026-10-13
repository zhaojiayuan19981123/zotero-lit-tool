// Offline repair: produce a reviewable candidate; never modify the source cache.
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { digest } from "./model";
import { repairTextBlocks, type CachedBlock } from "./repair";
// ★ Node 20 / Electron 33 兼容：pdf.js（含 legacy 构建）在 getDocument 时会调用
//   Promise.withResolvers —— 该 API 由 V8 12.4 / Node 22 引入，Node 20 运行时里不存在。
//   缺了它会在打开 PDF 的瞬间抛 "Promise.withResolvers is not a function"。
//   这里补一个语义一致的实现，只在缺失时生效，Node 22+ 完全不受影响。
//   esbuild 产出的 dist/repair-text.mjs 里同步保留了同一段。
if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function withResolvers() {
    let resolve: (value: unknown) => void = () => {};
    let reject: (reason?: unknown) => void = () => {};
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
if (typeof (ArrayBuffer.prototype as any).transferToFixedLength !== "function") {
  (ArrayBuffer.prototype as any).transferToFixedLength = function transferToFixedLength(newLength?: number) {
    const length = Number.isInteger(newLength) ? (newLength as number) : this.byteLength;
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(this.byteLength, length)));
    return out;
  };
}
if (typeof (ArrayBuffer.prototype as any).transfer !== "function") {
  (ArrayBuffer.prototype as any).transfer = function transfer(newLength?: number) {
    const length = Number.isInteger(newLength) ? (newLength as number) : this.byteLength;
    const out = new ArrayBuffer(length);
    new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(this.byteLength, length)));
    return out;
  };
}
// ★ process.getBuiltinModule 是 Node 22.3 才加入的 API（属 **Node 核心**，不是 V8 —— 所以
//   Electron 33 内置的 Node 20 同样没有）。pdf.js 在给页面里的内嵌图片造 canvas 时会调它
//   （NodeCanvasFactory._createCanvas），缺失时遇到带内嵌图的页面就抛
//   "process.getBuiltinModule is not a function"。用 createRequire 给一个等价实现。
if (typeof (process as any).getBuiltinModule !== "function") {
  const compatRequire = createRequire(import.meta.url);
  (process as any).getBuiltinModule = function getBuiltinModule(id: string) {
    return compatRequire(id.startsWith("node:") ? id : "node:" + id);
  };
}
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    manifest: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.input || !values.manifest || !values.output)
  throw new Error(
    "Usage: --input PDF --manifest manifest.json --output EMPTY_DIRECTORY",
  );
const input = resolve(values.input),
  output = resolve(values.output);
const manifest = JSON.parse(
  await readFile(resolve(values.manifest), "utf8"),
) as { inputSHA256: string; pages: number; blocks: CachedBlock[] };
if ((await digest(input)) !== manifest.inputSHA256)
  throw new Error("PDF hash does not match the cached layout");
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length)
  throw new Error(
    "Output must be empty; no existing files will be overwritten",
  );
const require = createRequire(import.meta.url),
  assets = dirname(require.resolve("pdfjs-dist/package.json"));
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = getDocument({
  data: new Uint8Array(await readFile(input)),
  cMapUrl: join(assets, "cmaps") + "/",
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + "/",
  wasmUrl: join(assets, "wasm") + "/",
  useSystemFonts: true,
});
try {
  const pdf = await task.promise;
  if (pdf.numPages !== manifest.pages)
    throw new Error("PDF page count does not match cached layout");
  const repaired = await repairTextBlocks(pdf, manifest.blocks);
  const changed = repaired.blocks
    .filter(
      (b) => b.text !== manifest.blocks.find((old) => old.id === b.id)?.text,
    )
    .map((b) => b.id);
  const sections: string[] = [];
  for (let page = 1; page <= manifest.pages; page++) {
    sections.push(`<!-- page:${page} -->`);
    for (const b of repaired.blocks.filter((b) => b.page === page)) {
      if (b.image)
        sections.push(
          `<!-- block:${b.id} type:${b.label} -->\n[${b.label}: ${b.id}](${b.image})`,
        );
      else if (b.text)
        sections.push(
          `<!-- block:${b.id} -->\n${b.label === "doc_title" ? "# " : b.label === "paragraph_title" ? "## " : ""}${b.text}`,
        );
    }
    if (repaired.unmatched.has(page))
      sections.push(
        `<!-- unmatched-text page:${page} -->\n${repaired.unmatched.get(page)}`,
      );
  }
  await writeFile(join(output, "paper.md"), sections.join("\n\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      { ...manifest, blocks: repaired.blocks, textExtractionVersion: 2 },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      blocks: repaired.blocks.length,
      changed: changed.length,
      changedIds: changed,
      output,
    }),
  );
} finally {
  await task.destroy();
}
