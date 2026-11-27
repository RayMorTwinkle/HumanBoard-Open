import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  OWNER_ID,
  renderSceneToPNG,
  SqliteStorageAdapter,
  type ModelProvider,
} from "@humanboard/core-engine";

import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";
import { LocalAppService } from "../src/local-app-service";
import {
  RemoteSyncClient,
  pullRemoteToLocal,
  pushLocalToRemote,
} from "../src/sync-client";

const temporaryDirectories: string[] = [];

interface RuntimeFixture {
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

interface RuntimeHandle {
  readonly runtime: ServerRuntime;
  stopped: boolean;
}

interface CommandResultBody<T> {
  readonly exitCode: number;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(20);
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("probe");
    },
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) {
    throw new Error("Probe server did not expose a port");
  }
  return port;
}

async function fixture(name: string): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), `humanboard-${name}-`));
  temporaryDirectories.push(root);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    cwd,
    home,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HUMANBOARD_HOME: home,
      HUMANBOARD_DB: join(home, "humanboard.sqlite"),
      HUMANBOARD_BLOBS: join(home, "blobs"),
      HUMANBOARD_CACHE: join(home, "cache"),
      HUMANBOARD_SESSION: `${name}-session`,
    },
  };
}

async function startRuntime(
  fixture: RuntimeFixture,
  options: {
    readonly syncDebounceMs?: number;
    readonly syncPollMs?: number;
    readonly agentProvider?: ModelProvider;
  } = {},
): Promise<RuntimeHandle> {
  const runtime = await createServerRuntime({
    cwd: fixture.cwd,
    env: fixture.env,
    host: "127.0.0.1",
    port: await freePort(),
    syncPollMs: options.syncPollMs,
    agentProvider: options.agentProvider,
    ...(options.syncDebounceMs === undefined
      ? {}
      : { syncDebounceMs: options.syncDebounceMs }),
  });
  return { runtime, stopped: false };
}

async function stopRuntime(handle: RuntimeHandle): Promise<void> {
  if (handle.stopped) {
    return;
  }
  handle.stopped = true;
  handle.runtime.syncScheduler.dispose();
  await handle.runtime.running.stop();
  await handle.runtime.pool.closeAll();
}

async function command<T>(
  handle: RuntimeHandle,
  argv: readonly string[],
  stdin?: string,
): Promise<T> {
  const response = await fetch(`${handle.runtime.url}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
    },
    body: JSON.stringify({
      argv,
      ...(stdin === undefined ? {} : { stdin }),
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as CommandResultBody<T>;
  if (body.exitCode !== 0) {
    throw new Error(
      `Command ${argv.join(" ")} failed: ${body.error?.code ?? "unknown"} ${body.error?.message ?? ""}`,
    );
  }
  if (body.data === undefined) {
    throw new Error(`Command ${argv.join(" ")} returned no data`);
  }
  return body.data;
}

async function seedPeer(
  fixture: RuntimeFixture,
  projectId: string,
  spaceId: string,
): Promise<void> {
  const databasePath = fixture.env.HUMANBOARD_DB!;
  const storage = new SqliteStorageAdapter({ databasePath });
  const createdAt = "2026-10-22T00:00:00.000Z";
  try {
    await storage.createProject({
      id: projectId,
      name: "sync-peer",
      root: fixture.cwd,
      owner_id: OWNER_ID,
      created_at: createdAt,
    });
    await storage.createSpace({
      id: spaceId,
      project_id: projectId,
      name: "main",
      active_layer_id: null,
      owner_id: OWNER_ID,
      created_at: createdAt,
    });
  } finally {
    storage.close();
  }
  await writeFile(
    join(fixture.cwd, ".humanboard"),
    `${JSON.stringify({ project_id: projectId, space_id: spaceId }, null, 2)}\n`,
    "utf8",
  );
}

async function initProject(
  handle: RuntimeHandle,
): Promise<{ project_id: string; space_id: string }> {
  return command<{ project_id: string; space_id: string }>(handle, [
    "init",
    "--json",
  ]);
}

async function commitPatch(
  handle: RuntimeHandle,
  patch: unknown,
  title: string,
): Promise<{ layer_id: string }> {
  await command(
    handle,
    ["draft", "--merge", "-", "--json"],
    JSON.stringify(patch),
  );
  return command<{ layer_id: string }>(handle, [
    "commit",
    "-m",
    title,
    "--json",
  ]);
}

async function rootLayerId(handle: RuntimeHandle): Promise<string> {
  const layers = await command<{ layers: Array<{ id: string }> }>(handle, [
    "layers",
    "--json",
  ]);
  const root = layers.layers[0];
  if (root === undefined) {
    throw new Error("Initialized Space has no root layer");
  }
  return root.id;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("remote sync over HTTP", () => {
  test("two individually valid 20 MiB blobs sync through the real default HTTP body limit", async () => {
    const f = await fixture("large-sync"),
      server = await startRuntime(f);
    try {
      const scope = await initProject(server);
      const client = new RemoteSyncClient({ serverUrl: server.runtime.url });
      const blobs = [1, 2].map((value) => {
        const bytes = Buffer.alloc(20 * 1024 * 1024, value);
        return {
          hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
          data_base64: bytes.toString("base64"),
        };
      });
      const result = await client.pushRemote({
        ...scope,
        layers: [],
        blobs,
        meta: [],
      });
      expect(result.rejected).toEqual([]);
      for (const blob of blobs)
        expect((await client.pullRemoteBlob(blob.hash)).length).toBe(
          20 * 1024 * 1024,
        );
    } finally {
      await stopRuntime(server);
    }
  });

  test("a conflicting Space is reported without blocking synchronization of a later healthy Space", async () => {
    const af = await fixture("scope-isolation-a"),
      bf = await fixture("scope-isolation-b");
    const a = await startRuntime(af),
      b = await startRuntime(bf);
    try {
      const scope = await initProject(a);
      const bad = await command<{ space_id: string }>(a, [
        "space",
        "create",
        "conflict",
        "--json",
      ]);
      const good = await command<{ space_id: string }>(a, [
        "space",
        "create",
        "healthy",
        "--json",
      ]);
      const goodRoot = await rootLayerId(a);
      const otherProject = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
      const storage = new SqliteStorageAdapter({
        databasePath: bf.env.HUMANBOARD_DB!,
      });
      try {
        await storage.createProject({
          id: otherProject,
          name: "other",
          root: null,
          owner_id: OWNER_ID,
          created_at: "2026-10-22T00:00:00.000Z",
        });
        await storage.createSpace({
          id: bad.space_id,
          project_id: otherProject,
          name: "unrelated",
          active_layer_id: null,
          owner_id: OWNER_ID,
          created_at: "2026-10-22T00:00:00.000Z",
        });
      } finally {
        storage.close();
      }
      await writeFile(
        join(af.home, "config.json"),
        JSON.stringify({ server_url: b.runtime.url, token: "" }),
      );
      await a.runtime.projectSync.set(scope.project_id, true);
      await a.runtime.projectSync.flush(scope.project_id);
      expect(
        (await a.runtime.projectSync.get(scope.project_id)).error,
      ).toContain(bad.space_id);
      const remote = await b.runtime.pool.getDefault();
      expect(
        (
          await remote
            .getSyncService()
            .inventory(scope.project_id, good.space_id)
        ).layer_ids,
      ).toEqual([goodRoot]);
      expect(
        (await remote.syncScopes(otherProject)).map((s) => s.space_id),
      ).toEqual([bad.space_id]);
    } finally {
      await stopRuntime(a);
      await stopRuntime(b);
    }
  });

  test("first push bootstraps remote identities and project sync includes subsequently created Spaces", async () => {
    const af = await fixture("push-bootstrap-a"),
      bf = await fixture("push-bootstrap-b");
    const a = await startRuntime(af),
      b = await startRuntime(bf);
    try {
      const scope = await initProject(a),
        root = await rootLayerId(a);
      const local = await a.runtime.pool.getDefault(),
        remote = await b.runtime.pool.getDefault();
      const client = new RemoteSyncClient({ serverUrl: b.runtime.url });
      expect(await remote.syncScopes()).toEqual([]);
      const first = await pushLocalToRemote(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(first.response.rejected).toEqual([]);
      expect(first.response.accepted).toEqual([root]);
      const inventory = await remote
        .getSyncService()
        .inventory(scope.project_id, scope.space_id);
      expect(inventory.active_layer_id).toBe(root);
      expect(
        (
          await pushLocalToRemote(
            local,
            client,
            scope.project_id,
            scope.space_id,
          )
        ).response.accepted,
      ).toEqual([]);

      const created = await command<{ space_id: string }>(a, [
        "space",
        "create",
        "new-local",
        "--json",
      ]);
      const newRoot = await rootLayerId(a);
      await writeFile(
        join(af.home, "config.json"),
        JSON.stringify({ server_url: b.runtime.url, token: "" }),
      );
      await a.runtime.projectSync.set(scope.project_id, true);
      await a.runtime.projectSync.flush(scope.project_id);
      expect(
        (await a.runtime.projectSync.get(scope.project_id)).error,
      ).toBeNull();
      expect(
        (
          await remote
            .getSyncService()
            .inventory(scope.project_id, created.space_id)
        ).layer_ids,
      ).toEqual([newRoot]);
      expect(
        (
          await remote
            .getSyncService()
            .inventory(scope.project_id, scope.space_id)
        ).layer_ids,
      ).toEqual([root]);
    } finally {
      await stopRuntime(a);
      await stopRuntime(b);
    }
  });

  test("chat history pulls into the first replica and the next Agent turn uses it, then pushes back once", async () => {
    const fa = await fixture("chat-sync-a"),
      fb = await fixture("chat-sync-b");
    for (const f of [fa, fb])
      Object.assign(f.env, {
        HUMAN_AGENT_MODEL: "sync-fixture",
        HUMAN_MODEL_API_KEY: "fixture-only",
        HUMAN_MODEL_BASE_URL: "http://fixture.invalid/v1",
      });
    const a = await startRuntime(fa, {
      agentProvider: {
        generate: async () => ({
          content: "第一端已记住 SYNC_CONTEXT_731",
          toolCalls: [],
        }),
      },
    });
    let b: RuntimeHandle | undefined;
    const local = await LocalAppService.create({ cwd: fb.cwd, env: fb.env });
    try {
      const scope = await initProject(a),
        base = await rootLayerId(a);
      const chat = async (h: RuntimeHandle, message: string) => {
        const r = await fetch(h.runtime.url + "/api/agent/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          },
          body: JSON.stringify({ ...scope, base_layer_id: base, message }),
        });
        expect(r.status).toBe(200);
        return r.json();
      };
      await chat(a, "记住 SYNC_CONTEXT_731，先讨论不改图。");
      const client = new RemoteSyncClient({ serverUrl: a.runtime.url });
      const pulled = await pullRemoteToLocal(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(pulled.response.messages_imported).toBe(2);
      let sawImportedContext = false;
      b = await startRuntime(fb, {
        syncPollMs: 60000,
        agentProvider: {
          generate: async (input) => {
            sawImportedContext = JSON.stringify(input.messages).includes(
              "第一端已记住 SYNC_CONTEXT_731",
            );
            return { content: "根据上次讨论继续。", toolCalls: [] };
          },
        },
      });
      await chat(b, "接着上次的讨论。");
      expect(sawImportedContext).toBe(true);
      const pushed = await pushLocalToRemote(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(pushed.payload.chat?.messages).toHaveLength(2);
      expect(pushed.response.messages_imported).toBe(2);
      expect(pushed.payload.layers).toHaveLength(0);
      const again = await pushLocalToRemote(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(again.payload.chat?.messages).toHaveLength(0);
      expect(again.response.messages_imported).toBe(0);
      const history = await fetch(
        a.runtime.url + "/api/agent/history?" + new URLSearchParams(scope),
      ).then((r) => r.json());
      expect(history.messages.map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      await writeFile(
        join(fb.home, "config.json"),
        JSON.stringify({ server_url: a.runtime.url, token: "" }),
      );
      await b.runtime.projectSync.set(scope.project_id, true);
      await b.runtime.projectSync.flush(scope.project_id);
      await chat(b, "开启同步后，纯聊天也应立即回传。");
      await waitFor(
        async () =>
          (
            await fetch(
              a.runtime.url +
                "/api/agent/history?" +
                new URLSearchParams(scope),
            ).then((r) => r.json())
          ).messages.length === 6,
      );
      await b.runtime.projectSync.set(scope.project_id, false);
      expect(
        (
          await local
            .getSyncService()
            .inventory(scope.project_id, scope.space_id)
        ).layer_ids,
      ).toHaveLength(1);
    } finally {
      local.close();
      if (b) await stopRuntime(b);
      await stopRuntime(a);
    }
  });
  test("a real CLI pulls an empty local replica with its image, ink and binding", async () => {
    const remoteFixture = await fixture("replica-cli-source"),
      destination = await fixture("replica-cli-empty");
    const remote = await startRuntime(remoteFixture);
    try {
      const scope = await initProject(remote);
      const image = await renderSceneToPNG({
        nodes: [
          {
            id: "image",
            kind: "note",
            title: "副本图片",
            rect: { x: 10, y: 10, w: 180, h: 80 },
          },
        ],
        edges: [],
        assets: [],
        strokes: [],
      });
      const file = join(remoteFixture.cwd, "source.png");
      await writeFile(file, image);
      const saved = await commitPatch(
        remote,
        {
          upsert_assets: [
            {
              source: { kind: "file", path: file },
              rect: { x: 80, y: 80, w: 180, h: 100 },
              z: 1,
            },
          ],
          add_strokes: [
            {
              id: "human-mark",
              tool: "pen",
              color: "#ff5b47",
              width: 3,
              points: [
                [90, 90],
                [140, 130],
              ],
            },
          ],
        },
        "含图片和笔迹的远端方案",
      );
      await (
        await remote.runtime.pool.getDefault()
      ).setActiveLayer(scope.space_id, saved.layer_id);
      const args = [
        process.execPath,
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "sync",
        "pull",
        "--project",
        scope.project_id,
        "--space",
        scope.space_id,
        "--json",
      ];
      const p = Bun.spawn(args, {
        cwd: destination.cwd,
        env: { ...destination.env, HUMANBOARD_SERVER_URL: remote.runtime.url },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out).accepted).toHaveLength(2);
      const local = await LocalAppService.create({
        cwd: destination.cwd,
        env: destination.env,
      });
      try {
        const result = await local.execute(
          {
            kind: "get",
            layer: saved.layer_id,
            format: "both",
            withStrokes: true,
          },
          { output: "json" },
        );
        const data = result.data as {
          assets: { asset_id: string; blob_hash: `sha256:${string}` }[];
          strokes: { count: number };
          layer: { id: string };
        };
        expect(data.layer.id).toBe(saved.layer_id);
        expect(data.assets).toHaveLength(1);
        expect(data.strokes.count).toBe(1);
        expect(
          await local.getSyncService().readBlob(data.assets[0]!.blob_hash),
        ).toEqual(new Uint8Array(image));
        expect(
          (
            await local
              .getSyncService()
              .inventory(scope.project_id, scope.space_id)
          ).active_layer_id,
        ).toBe(saved.layer_id);
        const project = await local.execute(
          { kind: "project", action: "ls" },
          { output: "json" },
        );
        expect((project.data as any).projects[0].root).toBeNull();
      } finally {
        local.close();
      }
    } finally {
      await stopRuntime(remote);
    }
  });
  test("first pull into an empty data directory creates matching identities and remains incremental", async () => {
    const remoteFixture = await fixture("replica-source"),
      localFixture = await fixture("replica-empty");
    const remote = await startRuntime(remoteFixture);
    const local = await LocalAppService.create({
      cwd: localFixture.cwd,
      env: localFixture.env,
    });
    try {
      const scope = await initProject(remote);
      const first = await commitPatch(
        remote,
        {
          upsert_nodes: [
            {
              id: "replicated",
              kind: "note",
              title: "首份跨端副本",
              rect: { x: 120, y: 100, w: 200, h: 80 },
            },
          ],
        },
        "远端已保存方案",
      );
      await (
        await remote.runtime.pool.getDefault()
      ).setActiveLayer(scope.space_id, first.layer_id);
      expect(await local.syncScopes()).toEqual([]);
      const client = new RemoteSyncClient({ serverUrl: remote.runtime.url });
      const pulled = await pullRemoteToLocal(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(pulled.response.rejected).toEqual([]);
      expect(pulled.response.accepted).toHaveLength(2);
      const inventory = await local
        .getSyncService()
        .inventory(scope.project_id, scope.space_id);
      expect(inventory.layer_ids).toContain(first.layer_id);
      expect(inventory.active_layer_id).toBe(first.layer_id);
      const read = await local.execute(
        {
          kind: "get",
          layer: first.layer_id,
          format: "ast",
          withStrokes: true,
        },
        { project: scope.project_id, space: scope.space_id, output: "json" },
      );
      expect((read.data as any).ast.nodes[0].title).toBe("首份跨端副本");
      const again = await pullRemoteToLocal(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(again.response.accepted).toEqual([]);
      const next = await commitPatch(
        remote,
        {
          upsert_nodes: [
            {
              id: "next",
              kind: "note",
              title: "后续增量",
              rect: { x: 420, y: 100, w: 180, h: 80 },
            },
          ],
        },
        "第二次增量",
      );
      const incremental = await pullRemoteToLocal(
        local,
        client,
        scope.project_id,
        scope.space_id,
      );
      expect(incremental.response.accepted).toEqual([next.layer_id]);
      expect(
        (
          await local
            .getSyncService()
            .inventory(scope.project_id, scope.space_id)
        ).active_layer_id,
      ).toBe(first.layer_id);
    } finally {
      local.close();
      await stopRuntime(remote);
    }
  });
  test("pushes from A, pulls into B through the blob endpoint, and is idempotent", async () => {
    const aFixture = await fixture("sync-a");
    const bFixture = await fixture("sync-b");
    const a = await startRuntime(aFixture);
    let b: RuntimeHandle | null = null;
    try {
      const scope = await initProject(a);
      const rootId = await rootLayerId(a);

      const imagePath = join(aFixture.cwd, "asset.png");
      await writeFile(
        imagePath,
        renderSceneToPNG({ nodes: [], edges: [], strokes: [], assets: [] }),
      );
      const committed = await commitPatch(
        a,
        {
          add_strokes: [
            {
              id: "sync-http-stroke",
              tool: "pen",
              color: "#ff5b47",
              width: 3.2,
              points: [
                [10, 20],
                [30, 40],
              ],
            },
          ],
          upsert_assets: [
            {
              source: { kind: "file", path: imagePath },
              rect: { x: 80, y: 60, w: 160, h: 120 },
              z: 1,
            },
          ],
        },
        "sync over http",
      );

      await seedPeer(bFixture, scope.project_id, scope.space_id);
      b = await startRuntime(bFixture);

      const aService = await a.runtime.pool.getDefault();
      const bService = await b.runtime.pool.getDefault();
      const pulled = await pullRemoteToLocal(
        bService,
        new RemoteSyncClient({ serverUrl: a.runtime.url }),
        scope.project_id,
        scope.space_id,
      );
      expect(pulled.negotiation.missing).toEqual([rootId, committed.layer_id]);
      expect(pulled.negotiation.blobs).toHaveLength(1);
      expect(pulled.response.rejected).toEqual([]);
      expect(pulled.response.accepted).toEqual([rootId, committed.layer_id]);

      const get = await command<{
        layer: { id: string };
        assets: Array<{ display_no: string }>;
      }>(b, ["get", committed.layer_id, "--json"]);
      expect(get.layer.id).toBe(committed.layer_id);
      expect(get.assets).toHaveLength(1);
      expect(get.assets[0]?.display_no).toBe("001");

      const diff = await command<{ mode: string; base: { id: string } }>(b, [
        "diff",
        rootId,
        committed.layer_id,
        "--json",
      ]);
      expect(diff.base.id).toBe(rootId);
      expect(["mixed", "visual"]).toContain(diff.mode);

      const pushed = await pushLocalToRemote(
        aService,
        new RemoteSyncClient({ serverUrl: b.runtime.url }),
        scope.project_id,
        scope.space_id,
      );
      expect(pushed.response.rejected).toEqual([]);
      expect(pushed.response.accepted).toEqual([]);
      expect(pushed.payload.layers).toEqual([]);
      expect(pushed.payload.blobs).toEqual([]);

      const pushedAgain = await pushLocalToRemote(
        aService,
        new RemoteSyncClient({ serverUrl: b.runtime.url }),
        scope.project_id,
        scope.space_id,
      );
      expect(pushedAgain.response.rejected).toEqual([]);
      expect(pushedAgain.response.accepted).toEqual([]);
      expect(pushedAgain.payload.layers).toEqual([]);
      expect(pushedAgain.payload.blobs).toEqual([]);
      const inventory = await bService
        .getSyncService()
        .inventory(scope.project_id, scope.space_id);
      expect(inventory.layer_ids).toEqual([rootId, committed.layer_id]);
      expect(inventory.blob_hashes).toEqual(pulled.negotiation.blobs);
    } finally {
      await stopRuntime(a);
      if (b !== null) {
        await stopRuntime(b);
      }
    }
  });

  test("pushes only remote-missing Layers and embeds only missing blobs", async () => {
    const aFixture = await fixture("incremental-sync-a");
    const bFixture = await fixture("incremental-sync-b");
    const a = await startRuntime(aFixture);
    let b: RuntimeHandle | null = null;
    try {
      const scope = await initProject(a);
      const rootId = await rootLayerId(a);
      const existingImagePath = join(aFixture.cwd, "existing.png");
      const missingImagePath = join(aFixture.cwd, "missing.png");
      await writeFile(
        existingImagePath,
        renderSceneToPNG({
          nodes: [
            {
              id: "existing-image",
              kind: "note",
              title: "Existing",
              rect: { x: 0, y: 0, w: 160, h: 90 },
            },
          ],
          edges: [],
          strokes: [],
          assets: [],
        }),
      );
      await writeFile(
        missingImagePath,
        renderSceneToPNG({
          nodes: [
            {
              id: "missing-image",
              kind: "note",
              title: "Missing",
              rect: { x: 0, y: 0, w: 160, h: 90 },
            },
          ],
          edges: [],
          strokes: [],
          assets: [],
        }),
      );

      const first = await commitPatch(
        a,
        {
          upsert_assets: [
            {
              source: { kind: "file", path: existingImagePath },
              rect: { x: 20, y: 20, w: 160, h: 90 },
              z: 1,
            },
          ],
        },
        "existing blob",
      );

      await seedPeer(bFixture, scope.project_id, scope.space_id);
      b = await startRuntime(bFixture);
      const aService = await a.runtime.pool.getDefault();
      const bService = await b.runtime.pool.getDefault();
      const initial = await pushLocalToRemote(
        aService,
        new RemoteSyncClient({ serverUrl: b.runtime.url }),
        scope.project_id,
        scope.space_id,
      );
      expect(initial.response.accepted).toEqual([rootId, first.layer_id]);

      const second = await commitPatch(
        a,
        {
          upsert_assets: [
            {
              source: { kind: "file", path: existingImagePath },
              rect: { x: 220, y: 20, w: 160, h: 90 },
              z: 2,
            },
            {
              source: { kind: "file", path: missingImagePath },
              rect: { x: 420, y: 20, w: 160, h: 90 },
              z: 3,
            },
          ],
        },
        "incremental blobs",
      );

      const incremental = await pushLocalToRemote(
        aService,
        new RemoteSyncClient({ serverUrl: b.runtime.url }),
        scope.project_id,
        scope.space_id,
      );
      expect(incremental.response.rejected).toEqual([]);
      expect(incremental.response.accepted).toEqual([second.layer_id]);
      expect(incremental.payload.layers.map((entry) => entry.layer.id)).toEqual(
        [second.layer_id],
      );
      expect(
        incremental.payload.layers.some(
          (entry) =>
            entry.layer.id === rootId || entry.layer.id === first.layer_id,
        ),
      ).toBe(false);

      const remoteBlobHashes = new Set(
        initial.payload.blobs.map((blob) =>
          typeof blob === "string" ? blob : blob.hash,
        ),
      );
      const layerAssetHashes = [
        ...new Set(
          incremental.payload.layers[0]!.assets.flatMap((asset) =>
            asset.blob_hash === null ? [] : [asset.blob_hash],
          ),
        ),
      ];
      expect(layerAssetHashes).toHaveLength(2);
      const existingHash = layerAssetHashes.find((hash) =>
        remoteBlobHashes.has(hash),
      );
      const missingHash = layerAssetHashes.find(
        (hash) => !remoteBlobHashes.has(hash),
      );
      expect(existingHash).toBeDefined();
      expect(missingHash).toBeDefined();

      const blobsByHash = new Map(
        incremental.payload.blobs.map((blob) => [
          typeof blob === "string" ? blob : blob.hash,
          blob,
        ]),
      );
      expect(blobsByHash.get(existingHash!)).toBe(existingHash!);
      expect(blobsByHash.get(missingHash!)).toMatchObject({
        hash: missingHash,
        data_base64: expect.any(String),
      });

      const inventory = await bService
        .getSyncService()
        .inventory(scope.project_id, scope.space_id);
      expect(inventory.layer_ids).toEqual([
        rootId,
        first.layer_id,
        second.layer_id,
      ]);
    } finally {
      await stopRuntime(a);
      if (b !== null) {
        await stopRuntime(b);
      }
    }
  });

  test("debounces automatic push and keeps commits successful when sync fails", async () => {
    const aFixture = await fixture("auto-sync-a");
    const bFixture = await fixture("auto-sync-b");
    const a = await startRuntime(aFixture, { syncDebounceMs: 20 });
    let b: RuntimeHandle | null = null;
    try {
      const scope = await initProject(a);
      await seedPeer(bFixture, scope.project_id, scope.space_id);
      b = await startRuntime(bFixture);

      await writeFile(
        join(aFixture.home, "config.json"),
        `${JSON.stringify({
          server_url: b.runtime.url,
          token: "",
        })}\n`,
        "utf8",
      );

      await a.runtime.projectSync.set(scope.project_id, true);
      const committed = await commitPatch(
        a,
        {
          add_strokes: [
            {
              id: "auto-sync-stroke",
              tool: "pen",
              color: "#ff5b47",
              width: 3.2,
              points: [
                [5, 6],
                [7, 8],
              ],
            },
          ],
        },
        "auto sync",
      );
      const bService = await b.runtime.pool.getDefault();
      await waitFor(async () => {
        const inventory = await bService
          .getSyncService()
          .inventory(scope.project_id, scope.space_id);
        return inventory.layer_ids.includes(committed.layer_id);
      });
      expect(a.runtime.syncScheduler.failures).toEqual([]);

      await stopRuntime(b);
      const failedCommit = await commitPatch(
        a,
        {
          add_strokes: [
            {
              id: "auto-sync-failure-stroke",
              tool: "pen",
              color: "#ff5b47",
              width: 3.2,
              points: [
                [9, 10],
                [11, 12],
              ],
            },
          ],
        },
        "auto sync failure",
      );
      expect(failedCommit.layer_id.length).toBeGreaterThan(0);
      await waitFor(() => a.runtime.syncScheduler.failures.length > 0);
      expect(a.runtime.syncScheduler.failures[0]?.code).toBe("E_CONNECT");
    } finally {
      await stopRuntime(a);
      if (b !== null) {
        await stopRuntime(b);
      }
    }
  });
});

test("Project sync is opt-in, automatically pulls later remote commits, and preserves the active view", async () => {
  const af = await fixture("auto-pull-a"),
    bf = await fixture("auto-pull-b");
  const a = await startRuntime(af);
  let b: RuntimeHandle | null = null;
  try {
    const scope = await initProject(a);
    const root = await rootLayerId(a);
    await seedPeer(bf, scope.project_id, scope.space_id);
    await writeFile(
      join(bf.home, "config.json"),
      JSON.stringify({ server_url: a.runtime.url, token: "" }),
    );
    b = await startRuntime(bf, { syncPollMs: 40 });
    const service = await b.runtime.pool.getDefault();
    expect((await b.runtime.projectSync.get(scope.project_id)).cloud_sync).toBe(
      false,
    );
    expect(
      (
        await service
          .getSyncService()
          .inventory(scope.project_id, scope.space_id)
      ).layer_ids,
    ).toEqual([]);
    await b.runtime.projectSync.set(scope.project_id, true);
    await waitFor(async () =>
      (
        await service
          .getSyncService()
          .inventory(scope.project_id, scope.space_id)
      ).layer_ids.includes(root),
    );
    await service.setActiveLayer(scope.space_id, root);
    const changed = await commitPatch(
      a,
      {
        upsert_nodes: [
          {
            id: "from-remote",
            kind: "note",
            title: "远端新方案",
            rect: { x: 100, y: 100, w: 180, h: 80 },
          },
        ],
      },
      "远端新增方案",
    );
    await waitFor(async () =>
      (
        await service
          .getSyncService()
          .inventory(scope.project_id, scope.space_id)
      ).layer_ids.includes(changed.layer_id),
    );
    expect(
      (
        await service
          .getSyncService()
          .inventory(scope.project_id, scope.space_id)
      ).active_layer_id,
    ).toBe(root);
    expect(
      (await b.runtime.projectSync.get(scope.project_id)).error,
    ).toBeNull();
    await b.runtime.projectSync.set(scope.project_id, false);
    expect((await b.runtime.projectSync.get(scope.project_id)).cloud_sync).toBe(
      false,
    );
  } finally {
    if (b) await stopRuntime(b);
    await stopRuntime(a);
  }
});
