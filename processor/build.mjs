import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import model from "./model.json" with { type: "json" };

const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "reader-model-build-"));
try {
  const prepare = join(temporary, "prepare-model.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["src/prepare-model-cli.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: prepare,
  });
  const result = spawnSync(process.execPath, [prepare, join(root, "models")], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Failed to prepare the layout model");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts", "src/repair-text.ts", "src/model.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outdir: join(root, "dist"),
  outExtension: { ".js": ".mjs" },
});
const models = join(root, "dist/models");
await rm(models, { recursive: true, force: true });
await mkdir(models, { recursive: true });
const filename = `${model.name}-${model.revision}.onnx`;
await cp(join(root, "models", filename), join(models, filename));
await cp(join(root, "model-license"), models, { recursive: true });
