import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { prepareConnectedFiles } from "../../application-service/src/file-transfer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSceneToPNG } from "@humanboard/core-engine";
import { LocalAppService } from "../src/local-app-service";
import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";
import { runCli } from "../src/main";
const roots: string[] = [],
  runtimes: ServerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const hash = (bytes: Uint8Array) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
async function fixture(auth = false) {
  const root = await mkdtemp(join(tmpdir(), "humanboard-remote-assets-"));
  roots.push(root);
  const serverCwd = join(root, "server"),
    clientCwd = join(root, "client");
  await mkdir(serverCwd);
  await mkdir(clientCwd);
  const env = {
    HUMANBOARD_HOME: join(root, "server-data"),
    HUMAN_AUTO_TITLE: "off",
    ...(auth ? { HUMAN_AUTH_TOKEN: "upload-test-token" } : {}),
  };
  const local = await LocalAppService.create({ cwd: serverCwd, env });
  await local.execute({ kind: "init", injectSkill: false }, { output: "json" });
  local.close();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd: serverCwd,
    env,
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  const cliEnv = {
    HUMANBOARD_HOME: join(root, "client-data"),
    HUMANBOARD_SESSION: "remote-assets-client",
    HUMANBOARD_SERVER_URL: runtime.url,
    ...(auth ? { HUMAN_AUTH_TOKEN: "upload-test-token" } : {}),
  };
  const cli = async (argv: string[]) => {
    let stdout = "",
      stderr = "";
    const code = await runCli([...argv, "--json"], {
      cwd: clientCwd,
      env: cliEnv,
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
    });
    return {
      code,
      data: stdout ? JSON.parse(stdout) : null,
      error: stderr ? JSON.parse(stderr) : null,
    };
  };
  return { root, runtime, serverCwd, clientCwd, cli, cliEnv };
}
const png = (title: string) =>
  renderSceneToPNG({
    nodes: [
      {
        id: "source",
        kind: "note",
        title,
        rect: { x: 10, y: 10, w: 180, h: 80 },
      },
    ],
    edges: [],
    strokes: [],
    assets: [],
  });

test("connected CLI uploads the client's file, not a same-named server file, and preserves separate asset identities", async () => {
  const f = await fixture(),
    client = await png("client bytes"),
    server = await png("server bytes");
  await writeFile(join(f.clientCwd, "diagram.png"), client);
  await writeFile(join(f.serverCwd, "diagram.png"), server);
  const patch = {
    upsert_assets: [
      {
        source: { kind: "file", path: "diagram.png" },
        rect: { x: 50, y: 50, w: 180, h: 80 },
        z: 1,
      },
      {
        source: { kind: "file", path: "diagram.png" },
        rect: { x: 260, y: 50, w: 180, h: 80 },
        z: 2,
      },
    ],
  };
  await writeFile(join(f.clientCwd, "patch.json"), JSON.stringify(patch));
  const draft = await f.cli(["draft", "--merge", "patch.json"]);
  expect(draft.code).toBe(0);
  expect(draft.data.registered_assets).toHaveLength(2);
  const assets = draft.data.registered_assets;
  expect(assets[0].blob_hash).toBe(hash(client));
  expect(assets[1].blob_hash).toBe(hash(client));
  expect(assets[0].asset_id).not.toBe(assets[1].asset_id);
  expect(assets[0].display_no).not.toBe(assets[1].display_no);
  const committed = await f.cli(["commit", "-m", "remote file upload"]);
  expect(committed.code).toBe(0);
  const read = await f.cli([
    "get",
    committed.data.layer_id,
    "--format",
    "both",
  ]);
  expect(read.code).toBe(0);
  expect(read.data.assets).toHaveLength(2);
  const service = await f.runtime.pool.getDefault();
  expect((await service.readAssetImage(assets[0].asset_id)).data).toEqual(
    new Uint8Array(client),
  );
  expect(await readFile(join(f.serverCwd, "diagram.png"))).toEqual(
    Buffer.from(server),
  );
});

function counts(root: string) {
  const db = new Database(join(root, "server-data/humanboard.sqlite"), {
    readonly: true,
  });
  try {
    return Object.fromEntries(
      ["assets", "layers", "drafts"].map((table) => [
        table,
        (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
          .n,
      ]),
    );
  } finally {
    db.close();
  }
}
const headers = {
  "Content-Type": "application/json",
  "X-HumanBoard-Client": "1",
};

test("files larger than the command JSON limit use binary upload, and aliases hide client paths", async () => {
  const f = await fixture();
  const original = await png("large client image"),
    image = Buffer.concat([original, Buffer.alloc(1200 * 1024)]);
  const filename = "客户端 独有图.png";
  await writeFile(join(f.clientCwd, filename), image);
  const patch = {
    upsert_assets: [
      {
        source: { kind: "file", path: filename },
        rect: { x: 80, y: 50, w: 180, h: 80 },
        z: 1,
      },
    ],
  };
  let uploads = 0;
  const prepared = await prepareConnectedFiles(
    JSON.stringify(patch),
    f.clientCwd,
    async (id, data) => {
      uploads++;
      expect(id).toBe(hash(image));
      expect(data.length).toBe(image.length);
    },
  );
  expect(uploads).toBe(1);
  expect(prepared.stdin).not.toContain(filename);
  expect(prepared.stdin).not.toContain(f.clientCwd);
  expect(Object.keys(prepared.fileBlobs)).toEqual(["upload:1"]);
  await writeFile(join(f.clientCwd, "large-patch.json"), JSON.stringify(patch));
  const draft = await f.cli(["draft", "--merge", "large-patch.json"]);
  expect(draft.code).toBe(0);
  expect(draft.data.registered_assets[0].blob_hash).toBe(hash(image));
  const service = await f.runtime.pool.getDefault();
  expect(
    (await service.readAssetImage(draft.data.registered_assets[0].asset_id))
      .data.length,
  ).toBe(image.length);
});

test("staging validates authentication and hashes without registering assets; invalid drafts do not register them either", async () => {
  const f = await fixture(true),
    image = await png("private upload"),
    id = hash(image),
    before = counts(f.root);
  const uploadUrl = f.runtime.url + "/api/uploads/" + encodeURIComponent(id);
  const binary = {
    "Content-Type": "application/octet-stream",
    "X-HumanBoard-Client": "1",
    Authorization: "Bearer upload-test-token",
  };
  expect(
    (
      await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(image),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: binary.Authorization,
        },
        body: new Uint8Array(image),
      })
    ).status,
  ).toBe(403);
  const mismatch = await fetch(
    f.runtime.url + "/api/uploads/" + "sha256:" + "0".repeat(64),
    { method: "PUT", headers: binary, body: new Uint8Array(image) },
  );
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json()).error.code).toBe("E_HASH_MISMATCH");
  const staged = await fetch(uploadUrl, {
    method: "PUT",
    headers: binary,
    body: new Uint8Array(image),
  });
  expect(staged.status).toBe(200);
  expect(await staged.json()).toEqual({ blob_hash: id });
  expect(counts(f.root)).toEqual(before);
  const send = async (patch: unknown, file_blobs: Record<string, string>) =>
    fetch(f.runtime.url + "/api/command", {
      method: "POST",
      headers: { ...headers, Authorization: binary.Authorization },
      body: JSON.stringify({
        argv: ["draft", "--merge", "-", "--json"],
        stdin: JSON.stringify(patch),
        file_blobs,
      }),
    }).then((r) => r.json());
  const invalid = await send(
    {
      upsert_nodes: [
        {
          id: "bad",
          kind: "service",
          title: "invalid",
          rect: { x: 0, y: 0, w: 180, h: 60 },
        },
      ],
      upsert_edges: [
        {
          id: "bad-edge",
          from: { node_id: "bad", side: "right", offset: 2 },
          to: { node_id: "bad", side: "left", offset: 0.5 },
        },
      ],
      upsert_assets: [
        {
          source: { kind: "file", path: "upload:1" },
          rect: { x: 0, y: 0, w: 180, h: 80 },
          z: 1,
        },
      ],
    },
    { "upload:1": id },
  );
  expect(invalid.exitCode).not.toBe(0);
  expect(counts(f.root)).toEqual(before);
  await writeFile(join(f.serverCwd, "server-only.png"), image);
  const missing = await send(
    {
      upsert_assets: [
        {
          source: { kind: "file", path: "server-only.png" },
          rect: { x: 0, y: 0, w: 180, h: 80 },
          z: 1,
        },
      ],
    },
    {},
  );
  expect(missing.exitCode).not.toBe(0);
  expect(missing.error.message).toContain("no uploaded content");
  expect(counts(f.root)).toEqual(before);
});

test("chunked uploads stop at the file byte limit before blob storage", async () => {
  const f = await fixture(),
    before = counts(f.root);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await f.runtime.running.app.request(
    new Request(f.runtime.url + "/api/uploads/sha256:" + "0".repeat(64), {
      method: "PUT",
      headers: {
        Host: new URL(f.runtime.url).host,
        "Content-Type": "application/octet-stream",
        "X-HumanBoard-Client": "1",
      },
      body: stream,
    }),
  );
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(counts(f.root)).toEqual(before);
});

test("standalone CLI process uploads stdin patch files without creating a local database", async () => {
  const f = await fixture(),
    image = await png("subprocess client");
  await writeFile(join(f.clientCwd, "client-only.png"), image);
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "draft",
      "--merge",
      "-",
      "--json",
    ],
    {
      cwd: f.clientCwd,
      env: { ...process.env, ...f.cliEnv },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    JSON.stringify({
      upsert_assets: [
        {
          source: { kind: "file", path: "client-only.png" },
          rect: { x: 80, y: 60, w: 180, h: 80 },
          z: 1,
        },
      ],
    }),
  );
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(result.registered_assets[0].blob_hash).toBe(hash(image));
  expect(
    await Bun.file(join(f.root, "client-data/humanboard.sqlite")).exists(),
  ).toBe(false);
  expect((await f.cli(["commit", "-m", "stdin subprocess upload"])).code).toBe(
    0,
  );
});
