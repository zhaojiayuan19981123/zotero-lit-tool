import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import specification from "../model.json";

export const model = specification;
export const modelFilename = `${model.name}-${model.revision}.onnx`;
export const bundledModelPath = fileURLToPath(
  new URL(`./models/${modelFilename}`, import.meta.url),
);

export async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyModel(path: string, expected = model) {
  if (
    (await stat(path)).size !== expected.bytes ||
    (await digest(path)) !== expected.sha256
  )
    throw new Error("版面模型校验失败，请重新构建或安装 Reader");
}

// Resolve relative to the worker, independent of cwd and the user's library.
// A broken installation must fail locally, never download a replacement.
export async function resolveModel(path = bundledModelPath) {
  try {
    await verifyModel(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("未找到内置版面模型，请重新构建或安装 Reader");
    throw error;
  }
  return path;
}
