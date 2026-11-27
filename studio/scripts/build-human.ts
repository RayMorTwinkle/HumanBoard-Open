import { createHash } from "node:crypto";
import { HUMANBOARD_VERSION } from "../packages/application-service/src/cli-info";
import { buildStandalone } from "./standalone-support";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
const root = resolve(import.meta.dir, "..");
const output = resolve(
  process.argv[2] ??
    join(
      root,
      "dist",
      `human-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
    ),
);
const ui = join(root, "packages/canvas-ui/dist"),
  generated = join(root, "artifacts/standalone-build");
await mkdir(generated, { recursive: true });
await mkdir(resolve(output, ".."), { recursive: true });
const files = await readdir(ui, { recursive: true, withFileTypes: true });
const assets = files
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();
if (!assets.some((file) => relative(ui, file) === "index.html"))
  throw new Error("Build the Canvas UI before packaging");
const imports = assets.map(
  (path, index) =>
    `import asset${index} from ${JSON.stringify(path)} with {type:"file"};`,
);
const entries = assets
  .map(
    (path, index) => [relative(ui, path).replaceAll("\\", "/"), index] as const,
  )
  .map(
    ([name, index]) =>
      `${JSON.stringify(name === "index.html" ? "/" : "/" + name)}:asset${index}`,
  );
const entry = join(generated, "entry.ts");
await writeFile(
  entry,
  [
    ...imports,
    `import {configurePackagedAssets} from ${JSON.stringify(join(root, "packages/application-service/src/runtime-assets.ts"))};`,
    `import {runCli} from ${JSON.stringify(join(root, "packages/cli/src/main.ts"))};`,
    `configurePackagedAssets({${entries.join(",")}});`,
    `process.exitCode=await runCli(process.argv.slice(2),{autoStart:true,cliCommand:[process.execPath]});`,
  ].join("\n"),
);
await buildStandalone(entry, output);
const binary = new Uint8Array(await Bun.file(output).arrayBuffer());
const embeddedAssets = await Promise.all(
  assets.map(async (path) => ({
    route:
      relative(ui, path) === "index.html"
        ? "/"
        : "/" + relative(ui, path).replaceAll("\\", "/"),
    sha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
      .digest("hex"),
  })),
);
await writeFile(
  output + ".manifest.json",
  JSON.stringify(
    {
      format_version: 1,
      product: "HumanBoard",
      version: HUMANBOARD_VERSION,
      build_kind: "development",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      bytes: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
      assets: embeddedAssets,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  JSON.stringify({
    binary: output,
    platform: process.platform,
    arch: process.arch,
    embeddedUiFiles: assets.length,
  }),
);
