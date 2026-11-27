import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerApp } from "@humanboard/server-self-hosted";
import { CommitEventBus } from "../src/commit-event-bus";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("packaged static map serves only embedded public files with correct cache and MIME", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-static-map-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  const html = join(root, "index.html"),
    js = join(root, "app.js"),
    privateAsset = join(root, "assets/unmapped.css");
  await writeFile(html, '<div id="root">packaged</div>');
  await writeFile(js, 'console.log("packaged")');
  await writeFile(privateAsset, "PRIVATE_UNMAPPED");
  const app = createServerApp({
    cacheDir: root,
    host: "127.0.0.1",
    port: 4317,
    staticDir: root,
    staticAssets: { "/": html, "/assets/app.js": js },
    events: new CommitEventBus(),
    execute: async () => ({ exitCode: 0 }),
  });
  const request = (path: string) =>
    app.request(
      new Request("http://127.0.0.1:4317" + path, {
        headers: { Host: "127.0.0.1:4317" },
      }),
    );
  const home = await request("/");
  expect(home.status).toBe(200);
  expect(home.headers.get("content-type")).toContain("text/html");
  expect(home.headers.get("cache-control")).toBe("no-cache");
  expect(await home.text()).toContain("packaged");
  const script = await request("/assets/app.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(script.headers.get("cache-control")).toContain("immutable");
  const missing = await request("/assets/unmapped.css");
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain("PRIVATE_UNMAPPED");
  const traversal = await request("/assets/%2e%2e%2findex.html");
  expect(traversal.status).toBe(400);
});

test("help and version do not initialize data or auto-start a server", async () => {
  const { runCli } = await import("../src/main");
  const root = await mkdtemp(join(tmpdir(), "humanboard-read-only-info-"));
  roots.push(root);
  const home = join(root, "must-not-be-created");
  for (const args of [["--help"], ["--version", "--json"]]) {
    let stdout = "";
    const code = await runCli(args, {
      cwd: root,
      env: { HUMANBOARD_HOME: home },
      autoStart: true,
      stdout: (value) => (stdout += value),
    });
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  }
  expect(await Bun.file(join(home, "humanboard.sqlite")).exists()).toBe(false);
  expect(await Bun.file(join(home, "server-runtime.json")).exists()).toBe(
    false,
  );
});
