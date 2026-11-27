import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";

/** JSDOM's CSS is a filesystem resource, so include its exact installed contents. */
function embeddedDomResources(): BunPlugin {
  return {
    name: "humanboard-dom-resources",
    setup(build) {
      build.onResolve(
        { filter: /^humanboard-jsdom-worker-resource$/ },
        ({ importer }) => ({
          path: resolve(dirname(importer), "xhr-sync-worker.js"),
          namespace: "humanboard-jsdom-resource",
        }),
      );
      build.onLoad(
        { filter: /.*/, namespace: "humanboard-jsdom-resource" },
        ({ path }) => ({
          contents: `import resource from ${JSON.stringify(path)} with {type:"file"}; export default resource;`,
          loader: "js",
          resolveDir: dirname(path),
        }),
      );
      build.onLoad(
        {
          filter: /[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/,
        },
        async ({ path }) => {
          const source = await readFile(path, "utf8");
          const expression = 'require.resolve("./xhr-sync-worker.js")';
          if (!source.includes(expression))
            throw new Error(
              "Installed JSDOM worker path loader changed; update the standalone resource adapter",
            );
          // HumanBoard parses inert HTML; the worker is never executed, but its path must resolve.
          return {
            contents: source.replace(
              expression,
              'require("humanboard-jsdom-worker-resource").default',
            ),
            loader: "js",
          };
        },
      );
      build.onLoad(
        {
          filter:
            /[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/,
        },
        async ({ path }) => {
          const source = await readFile(path, "utf8");
          const css = await readFile(
            resolve(dirname(path), "../../../browser/default-stylesheet.css"),
            "utf8",
          );
          const expression =
            /fs\.readFileSync\(\s*path\.resolve\(__dirname,\s*["']\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css["']\),\s*\{\s*encoding:\s*["']utf-8["']\s*\}\s*\)/;
          if (!expression.test(source))
            throw new Error(
              "Installed JSDOM stylesheet loader changed; update the standalone resource adapter",
            );
          return {
            contents: source.replace(expression, JSON.stringify(css)),
            loader: "js",
          };
        },
      );
    },
  };
}
export async function buildStandalone(entry: string, outfile: string) {
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      outfile,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
      autoloadDotenv: true,
    },
    minify: true,
    env: "disable",
    plugins: [embeddedDomResources()],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Standalone build failed");
  return result;
}
