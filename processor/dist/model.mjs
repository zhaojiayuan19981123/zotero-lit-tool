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
export {
  bundledModelPath,
  digest,
  model,
  modelFilename,
  resolveModel,
  verifyModel
};
