import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { model, verifyModel } from "./model";

// Build-time only: the runtime worker never imports this module.
export async function prepareModel(
  directory: string,
  source?: string,
  expected = model,
) {
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${expected.name}-${expected.revision}.onnx`);
  try {
    await verifyModel(target, expected);
    return target;
  } catch (error) {
    // A bad cache is an error, not a reason to silently overwrite it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const part = `${target}.${randomUUID()}.part`;
  try {
    if (source) {
      await verifyModel(source, expected);
      await copyFile(source, part);
    } else {
      console.log(`Preparing ${expected.name} (${expected.bytes} bytes)`);
      const response = await fetch(
        `https://huggingface.co/${expected.repository}/resolve/${expected.revision}/${expected.file}`,
        { signal: AbortSignal.timeout(300_000) },
      );
      if (!response.ok || !response.body)
        throw new Error(`模型下载失败：HTTP ${response.status}`);
      const file = await open(part, "wx", 0o600);
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.length;
          if (bytes > expected.bytes) throw new Error("模型文件过大");
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(
              chunk,
              offset,
              chunk.length - offset,
            );
            if (!bytesWritten) throw new Error("模型保存失败");
            offset += bytesWritten;
          }
        }
        await file.sync();
      } finally {
        await reader.cancel().catch(() => {});
        await file.close();
      }
    }
    await verifyModel(part, expected);
    await rename(part, target);
    return target;
  } finally {
    await rm(part, { force: true });
  }
}
