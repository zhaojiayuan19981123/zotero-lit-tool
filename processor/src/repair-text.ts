// Offline repair: produce a reviewable candidate; never modify the source cache.
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { digest } from "./model";
import { repairTextBlocks, type CachedBlock } from "./repair";
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
