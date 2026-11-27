import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SyncPushPayload } from "@humanboard/core-engine";
import {
  createServerApp,
  FrontendSessionHub,
  type CommitEventSource,
} from "@humanboard/server-self-hosted";

import { CommitEventBus } from "../src/commit-event-bus";
import {
  captureCommandResult,
  executeApiCommand,
  ServicePool,
  watchLocalServer,
} from "../src/server-runtime";

const HOST = "127.0.0.1:4317";
const ORIGIN = "http://127.0.0.1:4317";
const temporaryDirectories: string[] = [];

interface Harness {
  readonly app: ReturnType<typeof createServerApp>;
  readonly cwd: string;
  readonly home: string;
  readonly cacheDir: string;
  readonly pool: ServicePool;
  readonly frontendHub: FrontendSessionHub;
}

function headers(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Host: HOST,
    Origin: ORIGIN,
    ...extra,
  };
}

async function harness(staticDir?: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-server-"));
  temporaryDirectories.push(root);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    HUMANBOARD_HOME: home,
    HUMANBOARD_DB: join(home, "humanboard.sqlite"),
    HUMANBOARD_BLOBS: join(home, "blobs"),
    HUMANBOARD_CACHE: join(home, "cache"),
    HUMANBOARD_SESSION: "server-integration-session",
  };
  const events = new CommitEventBus();
  const frontendHub = new FrontendSessionHub();
  const pool = new ServicePool(env, cwd, events);
  const defaultService = await pool.getDefault();
  const cacheDir = join(home, "cache");
  const app = createServerApp({
    host: "127.0.0.1",
    port: 4317,
    cacheDir,
    ...(staticDir === undefined ? {} : { staticDir }),
    frontendHub,
    setActiveLayer: async ({ space_id, layer_id }) => {
      const space = await defaultService.setActiveLayer(space_id, layer_id);
      return {
        space_id: space.id,
        active_layer_id: space.active_layer_id!,
      };
    },
    sync: {
      negotiate: (projectId, spaceId, have, refs) =>
        defaultService
          .getSyncService()
          .negotiate(projectId, spaceId, have, refs),
      pullLayer: (projectId, spaceId, layerId) =>
        defaultService.getSyncService().pullLayer(projectId, spaceId, layerId),
      applyPush: (projectId, spaceId, payload) =>
        defaultService
          .getSyncService()
          .applyPush(projectId, spaceId, payload as SyncPushPayload),
      readBlob: (hash) => defaultService.getSyncService().readBlob(hash),
    },
    events: events satisfies CommitEventSource,
    execute: (request) =>
      executeApiCommand(pool, request, {
        capture: (_captureRequest, global, service) =>
          captureCommandResult(
            frontendHub,
            cacheDir,
            `http://${HOST}`,
            service,
            global,
          ),
      }),
    resolveWatch: (query) =>
      defaultService.resolveWatchScope(
        {
          output: "json",
          ...(query.project === undefined ? {} : { project: query.project }),
          ...(query.space === undefined ? {} : { space: query.space }),
        },
        query.since,
      ),
  });
  return { app, cwd, home, cacheDir, pool, frontendHub };
}

async function postCommand(
  testHarness: Harness,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return testHarness.app.request(`http://${HOST}/api/command`, {
    method: "POST",
    headers: headers({
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
      ...extraHeaders,
    }),
    body: JSON.stringify(body),
  });
}

async function readNdjsonLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error("watch stream ended before an NDJSON line");
    }
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      return buffer.slice(0, newline);
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("self-hosted Hono server", () => {
  test("commit event bus defaults to human commits and supports --all", () => {
    const bus = new CommitEventBus();
    const defaultEvents: string[] = [];
    const allEvents: string[] = [];
    const scopedEvents: string[] = [];
    bus.subscribe((event) => defaultEvents.push(event.author.kind));
    bus.subscribe((event) => allEvents.push(event.author.kind), { all: true });

    const base = {
      event: "layer_committed" as const,
      layer_id: "01M5H4QFEDB0X44RK6VWW58FCZ",
      project_id: "01M5H4QEZ3SN0ZSG290VS2AJSB",
      space_id: "01M5H4QF1X6ZAV7T51WCTBMTSC",
      seq: 2,
      short_id: "L2",
      parent_id: null,
      kind: "root",
      title: "",
      title_source: "pending",
      diff: { mode: "empty", summary: "" },
    };
    bus.subscribe((event) => scopedEvents.push(event.author.kind), {
      all: true,
      projectId: base.project_id,
      spaceId: base.space_id,
    });
    bus.publish({
      ...base,
      project_id: "other-project",
      space_id: "other-space",
      author: { kind: "human" },
    });
    bus.publish({ ...base, author: { kind: "cli" } });
    bus.publish({ ...base, seq: 3, author: { kind: "human" } });

    expect(defaultEvents).toEqual(["human", "human"]);
    expect(allEvents).toEqual(["human", "cli", "human"]);
    expect(scopedEvents).toEqual(["cli", "human"]);
  });

  test("serves health, enforces headers, and executes commands", async () => {
    const testHarness = await harness();
    try {
      const health = await testHarness.app.request(`http://${HOST}/health`, {
        headers: headers(),
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        ok: true,
        service: "humanboard",
        host: "127.0.0.1",
        port: 4317,
      });

      const badHost = await testHarness.app.request(`http://${HOST}/health`, {
        headers: headers({ Host: "evil.example:4317" }),
      });
      expect(badHost.status).toBe(403);
      expect(
        ((await badHost.json()) as { error: { code: string } }).error.code,
      ).toBe("E_AUTH");

      const badOrigin = await testHarness.app.request(`http://${HOST}/health`, {
        headers: headers({ Origin: "http://evil.example" }),
      });
      expect(badOrigin.status).toBe(403);

      const missingClientHeader = await postCommand(
        testHarness,
        { argv: ["init", "--json"] },
        { "X-HumanBoard-Client": "" },
      );
      expect(missingClientHeader.status).toBe(403);

      const wrongContentType = await testHarness.app.request(
        `http://${HOST}/api/command`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "text/plain",
            "X-HumanBoard-Client": "1",
          }),
          body: "{}",
        },
      );
      expect(wrongContentType.status).toBe(400);

      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      expect(init.status).toBe(200);
      const initBody = (await init.json()) as {
        exitCode: number;
        data: { created: boolean };
      };
      expect(initBody.exitCode).toBe(0);
      expect(initBody.data.created).toBe(true);

      const commandError = await postCommand(testHarness, {
        argv: ["commit", "--json"],
        cwd: testHarness.cwd,
      });
      const commandErrorBody = (await commandError.json()) as {
        exitCode: number;
        error: { code: string };
      };
      expect(commandErrorBody.exitCode).toBe(4);
      expect(commandErrorBody.error.code).toBe("E_NO_DRAFT");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("saves a draft patch from command stdin as a new layer", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      expect(((await init.json()) as { exitCode: number }).exitCode).toBe(0);

      const patch = JSON.stringify({
        add_strokes: [
          {
            id: "stdin-stroke",
            tool: "pen",
            color: "#ff5b47",
            width: 3.2,
            points: [
              [10, 20],
              [30, 40],
            ],
            pressure: [0.5, 0.6],
          },
        ],
      });
      const draft = await postCommand(testHarness, {
        argv: ["draft", "--merge", "-", "--json"],
        cwd: testHarness.cwd,
        stdin: patch,
      });
      const draftBody = (await draft.json()) as {
        exitCode: number;
        data: { draft_id: string };
      };
      expect(draftBody.exitCode).toBe(0);
      expect(draftBody.data.draft_id.length).toBe(26);

      const commit = await postCommand(testHarness, {
        argv: ["commit", "-m", "stdin patch", "--json"],
        cwd: testHarness.cwd,
      });
      expect(((await commit.json()) as { exitCode: number }).exitCode).toBe(0);

      const get = await postCommand(testHarness, {
        argv: ["get", "L2", "--format", "both", "--with-strokes", "--json"],
        cwd: testHarness.cwd,
      });
      const getBody = (await get.json()) as {
        data: { strokes: { items: Array<{ id: string }> } };
      };
      expect(getBody.data.strokes.items.map((stroke) => stroke.id)).toEqual([
        "stdin-stroke",
      ]);

      const status = await postCommand(testHarness, {
        argv: ["status", "--json"],
        cwd: testHarness.cwd,
      });
      const statusBody = (await status.json()) as {
        data: { total_layers: number; layers: Array<{ short_id: string }> };
      };
      expect(statusBody.data.total_layers).toBe(2);
      expect(statusBody.data.layers.at(-1)?.short_id).toBe("L2");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("writes the frontend active layer and rejects invalid refs", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: {
          space_id: string;
          space: { active_layer_id: string };
        };
      };
      const firstLayerId = initBody.data.space.active_layer_id;
      const spaceId = initBody.data.space_id;

      const patch = JSON.stringify({
        add_strokes: [
          {
            id: "active-layer-stroke",
            tool: "pen",
            color: "#ff5b47",
            width: 3.2,
            points: [
              [10, 20],
              [30, 40],
            ],
          },
        ],
      });
      const draft = await postCommand(testHarness, {
        argv: ["draft", "--merge", "-", "--json"],
        cwd: testHarness.cwd,
        stdin: patch,
      });
      expect(((await draft.json()) as { exitCode: number }).exitCode).toBe(0);
      const commit = await postCommand(testHarness, {
        argv: ["commit", "-m", "second layer", "--json"],
        cwd: testHarness.cwd,
      });
      const commitBody = (await commit.json()) as {
        data: { layer_id: string };
      };
      const secondLayerId = commitBody.data.layer_id;

      const selectFirst = await testHarness.app.request(
        `http://${HOST}/api/frontend/active-layer`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            space_id: spaceId,
            layer_id: firstLayerId,
          }),
        },
      );
      expect(selectFirst.status).toBe(200);
      expect(await selectFirst.json()).toEqual({
        space_id: spaceId,
        active_layer_id: firstLayerId,
      });

      const selectSecond = await testHarness.app.request(
        `http://${HOST}/api/frontend/active-layer`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            space_id: spaceId,
            layer_id: secondLayerId,
          }),
        },
      );
      expect(selectSecond.status).toBe(200);

      const status = await postCommand(testHarness, {
        argv: ["status", "--json"],
        cwd: testHarness.cwd,
      });
      const statusBody = (await status.json()) as {
        data: { active_layer: string | null };
      };
      expect(statusBody.data.active_layer).toBe(secondLayerId);

      const invalidLayer = await testHarness.app.request(
        `http://${HOST}/api/frontend/active-layer`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            space_id: spaceId,
            layer_id: "missing-layer",
          }),
        },
      );
      expect(invalidLayer.status).toBe(404);
      expect(
        ((await invalidLayer.json()) as { error: { code: string } }).error.code,
      ).toBe("E_LAYER_NOT_FOUND");

      const invalidSpace = await testHarness.app.request(
        `http://${HOST}/api/frontend/active-layer`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            space_id: "missing-space",
            layer_id: secondLayerId,
          }),
        },
      );
      expect(invalidSpace.status).toBe(404);
      expect(
        ((await invalidSpace.json()) as { error: { code: string } }).error.code,
      ).toBe("E_SPACE_NOT_FOUND");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("enforces security boundaries on every frontend write", async () => {
    const testHarness = await harness();
    try {
      const endpoints = [
        {
          path: "/api/frontend/session",
          body: { project_id: "project", space_id: "space" },
        },
        {
          path: "/api/frontend/response",
          body: {},
        },
        {
          path: "/api/frontend/active-layer",
          body: {},
        },
      ] as const;

      for (const endpoint of endpoints) {
        const missingClient = await testHarness.app.request(
          `http://${HOST}${endpoint.path}`,
          {
            method: "POST",
            headers: headers({ "Content-Type": "application/json" }),
            body: JSON.stringify(endpoint.body),
          },
        );
        expect(missingClient.status).toBe(403);
        expect(
          (await missingClient.json()) as {
            error: { code: string; message: string };
          },
        ).toMatchObject({
          error: {
            code: "E_AUTH",
            message: "X-HumanBoard-Client: 1 is required",
          },
        });

        const missingContentType = await testHarness.app.request(
          `http://${HOST}${endpoint.path}`,
          {
            method: "POST",
            headers: headers({ "X-HumanBoard-Client": "1" }),
            body: JSON.stringify(endpoint.body),
          },
        );
        expect(missingContentType.status).toBe(400);
        expect(
          (await missingContentType.json()) as {
            error: { code: string; message: string };
          },
        ).toMatchObject({
          error: {
            code: "E_USAGE",
            message: "Content-Type must be application/json",
          },
        });

        const oversized = await testHarness.app.request(
          `http://${HOST}${endpoint.path}`,
          {
            method: "POST",
            headers: headers({
              "Content-Type": "application/json",
              "X-HumanBoard-Client": "1",
            }),
            body: JSON.stringify({
              ...endpoint.body,
              padding: "x".repeat(1024 * 1024),
            }),
          },
        );
        expect(oversized.status).toBe(413);
        expect(
          (await oversized.json()) as {
            error: { code: string; message: string };
          },
        ).toMatchObject({
          error: {
            code: "E_USAGE",
            message: "Request body is too large",
          },
        });
      }
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("serves sync negotiate, push, layer pull, and blob reads", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: {
          project_id: string;
          space_id: string;
          space: { active_layer_id: string };
        };
      };
      const projectId = initBody.data.project_id;
      const spaceId = initBody.data.space_id;
      const firstLayerId = initBody.data.space.active_layer_id;

      const patch = JSON.stringify({
        add_strokes: [
          {
            id: "sync-route-stroke",
            tool: "pen",
            color: "#ff5b47",
            width: 3.2,
            points: [
              [10, 20],
              [30, 40],
            ],
          },
        ],
      });
      const draft = await postCommand(testHarness, {
        argv: ["draft", "--merge", "-", "--json"],
        cwd: testHarness.cwd,
        stdin: patch,
      });
      expect(((await draft.json()) as { exitCode: number }).exitCode).toBe(0);
      const commit = await postCommand(testHarness, {
        argv: ["commit", "-m", "sync route layer", "--json"],
        cwd: testHarness.cwd,
      });
      const commitBody = (await commit.json()) as {
        data: { layer_id: string };
      };
      const secondLayerId = commitBody.data.layer_id;

      const negotiate = await testHarness.app.request(
        `http://${HOST}/sync/negotiate`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            project_id: projectId,
            space_id: spaceId,
            have: [firstLayerId],
            refs: { blobs: [] },
          }),
        },
      );
      expect(negotiate.status).toBe(200);
      expect(await negotiate.json()).toMatchObject({
        missing: [secondLayerId],
      });

      const service = await testHarness.pool.getDefault();
      const pushed = await service
        .getSyncService()
        .push(projectId, spaceId, [secondLayerId]);
      const push = await testHarness.app.request(`http://${HOST}/sync/push`, {
        method: "POST",
        headers: headers({
          "Content-Type": "application/json",
          "X-HumanBoard-Client": "1",
        }),
        body: JSON.stringify(pushed),
      });
      expect(push.status).toBe(200);
      expect(await push.json()).toMatchObject({
        accepted: [secondLayerId],
        rejected: [],
      });

      const pull = await testHarness.app.request(
        `http://${HOST}/layers/${secondLayerId}?project_id=${encodeURIComponent(projectId)}&space_id=${encodeURIComponent(spaceId)}`,
        { headers: headers() },
      );
      expect(pull.status).toBe(200);
      expect(await pull.json()).toMatchObject({
        project_id: projectId,
        space_id: spaceId,
        layer: { id: secondLayerId },
      });

      const blob = Buffer.from("sync-route-blob");
      const hash = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
      const blobDir = join(testHarness.home, "blobs", hash.slice(7, 9));
      await mkdir(blobDir, { recursive: true });
      await writeFile(join(blobDir, hash.slice(9)), blob);
      const blobResponse = await testHarness.app.request(
        `http://${HOST}/blobs/${hash}`,
        { headers: headers() },
      );
      expect(blobResponse.status).toBe(200);
      expect(Buffer.from(await blobResponse.arrayBuffer()).toString()).toBe(
        "sync-route-blob",
      );

      const missingHeader = await testHarness.app.request(
        `http://${HOST}/sync/negotiate`,
        {
          method: "POST",
          headers: headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            project_id: projectId,
            space_id: spaceId,
            have: [],
          }),
        },
      );
      expect(missingHeader.status).toBe(403);
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("serves the built UI and falls back when dist is missing", async () => {
    const dist = await mkdtemp(join(tmpdir(), "humanboard-static-"));
    temporaryDirectories.push(dist);
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(
      join(dist, "index.html"),
      '<!doctype html><div id="root">HumanBoard UI</div>',
      "utf8",
    );
    await writeFile(
      join(dist, "assets", "app.js"),
      "console.log('humanboard')",
      "utf8",
    );
    const testHarness = await harness(dist);
    try {
      const index = await testHarness.app.request(`http://${HOST}/`, {
        headers: headers(),
      });
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("HumanBoard UI");

      const asset = await testHarness.app.request(
        `http://${HOST}/assets/app.js`,
        { headers: headers() },
      );
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
      expect(await asset.text()).toContain("humanboard");
    } finally {
      await testHarness.pool.closeAll();
    }

    const missing = await harness();
    try {
      const root = await missing.app.request(`http://${HOST}/`, {
        headers: headers(),
      });
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("HumanBoard UI is not built");
    } finally {
      await missing.pool.closeAll();
    }
  });

  test("capture returns E_LIVE_UNAVAILABLE without a frontend", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      expect(((await init.json()) as { exitCode: number }).exitCode).toBe(0);
      const response = await postCommand(testHarness, {
        argv: ["capture", "--json"],
        cwd: testHarness.cwd,
      });
      const body = (await response.json()) as {
        exitCode: number;
        error: { code: string };
      };
      expect(body.exitCode).toBe(6);
      expect(body.error.code).toBe("E_LIVE_UNAVAILABLE");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("capture asks the registered frontend for a live Scene", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: {
          project_id: string;
          space_id: string;
          space: { active_layer_id: string };
        };
      };
      const registration = await testHarness.app.request(
        `http://${HOST}/api/frontend/session`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            project_id: initBody.data.project_id,
            space_id: initBody.data.space_id,
          }),
        },
      );
      const session = (await registration.json()) as { session_id: string };

      const poll = testHarness.app.request(
        `http://${HOST}/api/frontend/requests?session_id=${session.session_id}&timeout=2000`,
        { headers: headers() },
      );
      await Bun.sleep(20);
      const capture = postCommand(testHarness, {
        argv: ["capture", "--json"],
        cwd: testHarness.cwd,
      });
      const pollResponse = await poll;
      const pollBody = (await pollResponse.json()) as {
        request: { request_id: string; timeout_ms: number };
      };
      expect(pollBody.request.timeout_ms).toBe(2000);

      const uncommitted = {
        strokes: { added: 1, erased: 0 },
        nodes: { added: [], updated: [], moved: [], removed: [] },
        edges: { added: [], updated: [], removed: [] },
        assets: { added: [], moved: [], removed: [] },
      };
      const response = await testHarness.app.request(
        `http://${HOST}/api/frontend/response`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            session_id: session.session_id,
            request_id: pollBody.request.request_id,
            based_on_layer: initBody.data.space.active_layer_id,
            based_on_seq: 1,
            scene: {
              nodes: [],
              edges: [],
              strokes: [
                {
                  id: "live-stroke",
                  tool: "pen",
                  color: "#ff5b47",
                  width: 3.2,
                  points: [
                    [10, 20],
                    [40, 50],
                  ],
                },
              ],
              assets: [],
            },
            layer: {
              id: initBody.data.space.active_layer_id,
              short_id: "L1",
              seq: 1,
              title: "live layer",
              title_source: "human",
              kind: "root",
            },
            assets: [],
            has_uncommitted: true,
            uncommitted,
            captured_at: new Date().toISOString(),
          }),
        },
      );
      expect(((await response.json()) as { accepted: boolean }).accepted).toBe(
        true,
      );

      const captureBody = (await (await capture).json()) as {
        exitCode: number;
        data: {
          based_on_layer: string;
          has_uncommitted: boolean;
          uncommitted: typeof uncommitted;
          snapshot_id: string;
          render: { url: string };
        };
      };
      expect(captureBody.exitCode).toBe(0);
      expect(captureBody.data.based_on_layer).toBe(
        initBody.data.space.active_layer_id,
      );
      expect(captureBody.data.has_uncommitted).toBe(true);
      expect(captureBody.data.uncommitted.strokes.added).toBe(1);
      expect(captureBody.data.render.url).toContain(
        `/render/${captureBody.data.snapshot_id}.png`,
      );
      expect(
        existsSync(
          join(
            testHarness.cacheDir,
            "renders",
            `${captureBody.data.snapshot_id}.png`,
          ),
        ),
      ).toBe(true);
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("rejects invalid frontend capture Scenes", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: {
          project_id: string;
          space_id: string;
          space: { active_layer_id: string };
        };
      };
      const registration = await testHarness.app.request(
        `http://${HOST}/api/frontend/session`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            project_id: initBody.data.project_id,
            space_id: initBody.data.space_id,
          }),
        },
      );
      const session = (await registration.json()) as { session_id: string };
      const poll = testHarness.app.request(
        `http://${HOST}/api/frontend/requests?session_id=${session.session_id}&timeout=2000`,
        { headers: headers() },
      );
      await Bun.sleep(20);
      const capture = postCommand(testHarness, {
        argv: ["capture", "--json"],
        cwd: testHarness.cwd,
      });
      const pollBody = (await (await poll).json()) as {
        request: { request_id: string };
      };
      const payload = {
        session_id: session.session_id,
        request_id: pollBody.request.request_id,
        based_on_layer: initBody.data.space.active_layer_id,
        based_on_seq: 1,
        scene: {
          nodes: [],
          edges: [],
          strokes: [
            {
              id: "validated-live-stroke",
              tool: "pen",
              color: "#ff5b47",
              width: 3.2,
              points: [
                [10, 20],
                [40, 50],
              ],
            },
          ],
          assets: [],
        },
        layer: {
          id: initBody.data.space.active_layer_id,
          short_id: "L1",
          seq: 1,
          title: "validated live layer",
          title_source: "human",
          kind: "root",
        },
        assets: [],
        has_uncommitted: true,
        uncommitted: {
          strokes: { added: 1, erased: 0 },
          nodes: { added: [], updated: [], moved: [], removed: [] },
          edges: { added: [], updated: [], removed: [] },
          assets: { added: [], moved: [], removed: [] },
        },
        captured_at: new Date().toISOString(),
      };
      const invalid = await testHarness.app.request(
        `http://${HOST}/api/frontend/response`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            ...payload,
            scene: {
              ...payload.scene,
              unexpected: true,
            },
          }),
        },
      );
      expect(invalid.status).toBe(400);
      expect(
        (await invalid.json()) as {
          error: { code: string; message: string };
        },
      ).toMatchObject({
        error: {
          code: "E_USAGE",
          message: "Invalid frontend capture payload",
        },
      });

      const valid = await testHarness.app.request(
        `http://${HOST}/api/frontend/response`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify(payload),
        },
      );
      expect(await valid.json()).toEqual({ accepted: true });
      const captureBody = (await (await capture).json()) as {
        exitCode: number;
        data: { scene: { strokes: Array<{ id: string }> } };
      };
      expect(captureBody.exitCode).toBe(0);
      expect(captureBody.data.scene.strokes.map((item) => item.id)).toEqual([
        "validated-live-stroke",
      ]);
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("rejects command bodies over 1 MB", async () => {
    const testHarness = await harness();
    try {
      const response = await postCommand(testHarness, {
        argv: ["status"],
        padding: "x".repeat(1024 * 1024 + 1),
      });
      expect(response.status).toBe(413);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("E_USAGE");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("serves cached PNGs and blocks traversal", async () => {
    const testHarness = await harness();
    try {
      const renderDir = join(testHarness.home, "cache", "renders");
      await mkdir(renderDir, { recursive: true });
      await writeFile(join(renderDir, "ok.png"), Buffer.from("png"));
      await writeFile(join(testHarness.home, "secret.txt"), "secret", "utf8");

      const ok = await testHarness.app.request(`http://${HOST}/render/ok.png`, {
        headers: headers(),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(ok.headers.get("cache-control")).toBe("private, no-cache");
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("png");

      const traversal = await testHarness.app.request(
        `http://${HOST}/render/%2e%2e%2fsecret.txt`,
        { headers: headers() },
      );
      expect(traversal.status).toBe(400);
      expect(
        ((await traversal.json()) as { error: { code: string } }).error.code,
      ).toBe("E_USAGE");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("serves cached inspect PNGs and blocks traversal", async () => {
    const testHarness = await harness();
    try {
      const inspectDir = join(testHarness.home, "cache", "inspect");
      await mkdir(inspectDir, { recursive: true });
      await writeFile(join(inspectDir, "ok.png"), Buffer.from("inspect-png"));
      await writeFile(join(testHarness.home, "secret.txt"), "secret", "utf8");

      const ok = await testHarness.app.request(
        `http://${HOST}/inspect/ok.png`,
        { headers: headers() },
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe(
        "inspect-png",
      );

      const traversal = await testHarness.app.request(
        `http://${HOST}/inspect/%2e%2e%2fsecret.txt`,
        { headers: headers() },
      );
      expect(traversal.status).toBe(400);
      expect(
        ((await traversal.json()) as { error: { code: string } }).error.code,
      ).toBe("E_USAGE");
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("emits a layer_committed event to NDJSON watch subscribers", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      expect(init.status).toBe(200);
      const initBody = (await init.json()) as {
        exitCode: number;
        data: { project_id: string; space_id: string };
      };
      expect(initBody.exitCode).toBe(0);

      const scenePath = join(testHarness.cwd, "scene.json");
      await writeFile(
        scenePath,
        JSON.stringify({
          nodes: [
            {
              id: "n1",
              kind: "service",
              title: "API",
              rect: { x: 10, y: 10, w: 100, h: 60 },
            },
          ],
          edges: [],
          strokes: [],
          assets: [],
        }),
        "utf8",
      );
      const draft = await postCommand(testHarness, {
        argv: ["draft", "--file", "scene.json", "--json"],
        cwd: testHarness.cwd,
      });
      expect(((await draft.json()) as { exitCode: number }).exitCode).toBe(0);

      const watch = await testHarness.app.request(
        `http://${HOST}/api/watch?all=true&timeout=15&project=${encodeURIComponent(initBody.data.project_id)}&space=${encodeURIComponent(initBody.data.space_id)}`,
        { headers: headers() },
      );
      expect(watch.status).toBe(200);
      expect(watch.headers.get("content-type")).toContain(
        "application/x-ndjson",
      );
      const reader = watch.body!.getReader();
      const firstLine = readNdjsonLine(reader);

      const commit = await postCommand(testHarness, {
        argv: ["commit", "-m", "新增 API", "--json"],
        cwd: testHarness.cwd,
      });
      const commitBody = (await commit.json()) as {
        exitCode: number;
        data: { layer_id: string; content_hash: string };
      };
      expect(commitBody.exitCode).toBe(0);

      const get = await postCommand(testHarness, {
        argv: ["get", "L2", "--format", "both", "--json"],
        cwd: testHarness.cwd,
      });
      const getBody = (await get.json()) as {
        exitCode: number;
        data: { content_hash: string; render: { url: string } };
      };
      expect(getBody.exitCode).toBe(0);
      expect(getBody.data.content_hash).toBe(commitBody.data.content_hash);
      const rendered = await testHarness.app.request(getBody.data.render.url, {
        headers: headers(),
      });
      expect(rendered.status).toBe(200);
      expect(new Uint8Array(await rendered.arrayBuffer()).slice(0, 4)).toEqual(
        new Uint8Array([137, 80, 78, 71]),
      );

      const diff = await postCommand(testHarness, {
        argv: ["diff", "L1", "L2", "--visual", "--json"],
        cwd: testHarness.cwd,
      });
      const diffBody = (await diff.json()) as {
        exitCode: number;
        data: {
          visual: {
            bounds: unknown;
            highlight: { url: string; bounds: unknown };
          };
        };
      };
      expect(diffBody.exitCode).toBe(0);
      expect(diffBody.data.visual.highlight.bounds).toEqual(
        diffBody.data.visual.bounds,
      );
      const highlight = await testHarness.app.request(
        diffBody.data.visual.highlight.url,
        { headers: headers() },
      );
      expect(highlight.status).toBe(200);
      expect(highlight.headers.get("content-type")).toBe("image/png");

      const event = JSON.parse(await firstLine) as {
        event: string;
        project_id: string;
        space_id: string;
        seq: number;
        short_id: string;
        author: { kind: string };
        diff: { mode: string };
      };
      expect(event.event).toBe("layer_committed");
      expect(event.project_id).toBe(initBody.data.project_id);
      expect(event.space_id).toBe(initBody.data.space_id);
      expect(event.seq).toBe(2);
      expect(event.short_id).toBe("L2");
      expect(event.author.kind).toBe("cli");
      expect(event.diff.mode).toBe("transform");
      await reader.cancel();

      const replay = await testHarness.app.request(
        `http://${HOST}/api/watch?since=L1&all=true&timeout=0`,
        { headers: headers() },
      );
      const replayLines = (await replay.text()).trim().split("\n");
      const replayed = JSON.parse(replayLines[0]!) as {
        event: string;
        seq: number;
      };
      expect(replayed.event).toBe("layer_committed");
      expect(replayed.seq).toBe(2);
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("closes the stroke save, watch wake, and live capture loop", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: {
          project_id: string;
          space_id: string;
          space: { active_layer_id: string };
        };
      };

      const watch = await testHarness.app.request(
        `http://${HOST}/api/watch?all=true&timeout=15&project=${encodeURIComponent(initBody.data.project_id)}&space=${encodeURIComponent(initBody.data.space_id)}`,
        { headers: headers() },
      );
      const reader = watch.body!.getReader();
      const eventLine = readNdjsonLine(reader);

      const stroke = {
        id: "browser-loop-stroke",
        tool: "pen",
        color: "#ff5b47",
        width: 3.2,
        points: [
          [10, 20],
          [40, 50],
        ],
      };
      const draft = await postCommand(testHarness, {
        argv: ["draft", "--merge", "-", "--json"],
        cwd: testHarness.cwd,
        stdin: JSON.stringify({ add_strokes: [stroke] }),
      });
      expect(((await draft.json()) as { exitCode: number }).exitCode).toBe(0);
      const commit = await postCommand(testHarness, {
        argv: ["commit", "-m", "保存笔迹", "--json"],
        cwd: testHarness.cwd,
      });
      const commitBody = (await commit.json()) as {
        data: { layer_id: string; seq: number; short_id: string };
      };

      const event = JSON.parse(await eventLine) as {
        event: string;
        layer_id: string;
        seq: number;
        author: { kind: string };
      };
      expect(event).toMatchObject({
        event: "layer_committed",
        layer_id: commitBody.data.layer_id,
        seq: 2,
        author: { kind: "cli" },
      });
      await reader.cancel();

      const savedLayer = await postCommand(testHarness, {
        argv: ["get", "L2", "--format", "both", "--with-strokes", "--json"],
        cwd: testHarness.cwd,
      });
      const savedLayerBody = (await savedLayer.json()) as {
        exitCode: number;
        data: {
          layer: { id: string; seq: number };
          strokes: { items: Array<{ id: string }> };
        };
      };
      expect(savedLayerBody.exitCode).toBe(0);
      expect(savedLayerBody.data.layer).toMatchObject({
        id: commitBody.data.layer_id,
        seq: 2,
      });
      expect(
        savedLayerBody.data.strokes.items.map((item) => item.id),
      ).toContain("browser-loop-stroke");

      const registration = await testHarness.app.request(
        `http://${HOST}/api/frontend/session`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            project_id: initBody.data.project_id,
            space_id: initBody.data.space_id,
          }),
        },
      );
      const session = (await registration.json()) as { session_id: string };
      const poll = testHarness.app.request(
        `http://${HOST}/api/frontend/requests?session_id=${session.session_id}&timeout=2000`,
        { headers: headers() },
      );
      await Bun.sleep(20);
      const capture = postCommand(testHarness, {
        argv: ["capture", "--json"],
        cwd: testHarness.cwd,
      });
      const pollBody = (await (await poll).json()) as {
        request: { request_id: string };
      };
      const liveStroke = {
        id: "live-uncommitted-stroke",
        tool: "highlighter",
        color: "#ffe45e",
        width: 8,
        points: [
          [50, 60],
          [80, 90],
        ],
      };
      const response = await testHarness.app.request(
        `http://${HOST}/api/frontend/response`,
        {
          method: "POST",
          headers: headers({
            "Content-Type": "application/json",
            "X-HumanBoard-Client": "1",
          }),
          body: JSON.stringify({
            session_id: session.session_id,
            request_id: pollBody.request.request_id,
            based_on_layer: commitBody.data.layer_id,
            based_on_seq: commitBody.data.seq,
            scene: {
              nodes: [],
              edges: [],
              strokes: [stroke, liveStroke],
              assets: [],
            },
            layer: {
              id: commitBody.data.layer_id,
              short_id: commitBody.data.short_id,
              seq: commitBody.data.seq,
              title: "保存笔迹",
              title_source: "agent",
              kind: "derive",
            },
            assets: [],
            has_uncommitted: true,
            uncommitted: {
              strokes: { added: 1, erased: 0 },
              nodes: { added: [], updated: [], moved: [], removed: [] },
              edges: { added: [], updated: [], removed: [] },
              assets: { added: [], moved: [], removed: [] },
            },
            captured_at: new Date().toISOString(),
          }),
        },
      );
      expect(((await response.json()) as { accepted: boolean }).accepted).toBe(
        true,
      );
      const captureBody = (await (await capture).json()) as {
        exitCode: number;
        data: {
          based_on_layer: string;
          has_uncommitted: boolean;
          uncommitted: { strokes: { added: number } };
          scene: { strokes: Array<{ id: string }> };
          snapshot_id: string;
        };
      };
      expect(captureBody.exitCode).toBe(0);
      expect(captureBody.data.based_on_layer).toBe(commitBody.data.layer_id);
      expect(captureBody.data.has_uncommitted).toBe(true);
      expect(captureBody.data.uncommitted.strokes.added).toBe(1);
      expect(captureBody.data.scene.strokes.map((item) => item.id)).toEqual([
        "browser-loop-stroke",
        "live-uncommitted-stroke",
      ]);
      expect(
        existsSync(
          join(
            testHarness.cacheDir,
            "renders",
            `${captureBody.data.snapshot_id}.png`,
          ),
        ),
      ).toBe(true);
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("returns E_WATCH_TIMEOUT as a final NDJSON error line", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      expect(((await init.json()) as { exitCode: number }).exitCode).toBe(0);
      const response = await testHarness.app.request(
        `http://${HOST}/api/watch?all=true&timeout=0`,
        { headers: headers() },
      );
      expect(response.status).toBe(200);
      const lines = (await response.text()).trim().split("\n");
      expect(JSON.parse(lines.at(-1)!)).toEqual({
        error: {
          code: "E_WATCH_TIMEOUT",
          message: "watch timed out after 0s",
          details: { timeout_s: 0 },
        },
      });
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("watch filters commits by project and space", async () => {
    const testHarness = await harness();
    try {
      const init = await postCommand(testHarness, {
        argv: ["init", "--json"],
        cwd: testHarness.cwd,
      });
      const initBody = (await init.json()) as {
        data: { project_id: string; space_id: string };
      };
      const scenePath = join(testHarness.cwd, "scope-scene.json");
      await writeFile(
        scenePath,
        JSON.stringify({
          nodes: [
            {
              id: "n1",
              kind: "service",
              title: "Scope",
              rect: { x: 0, y: 0, w: 100, h: 60 },
            },
          ],
          edges: [],
          strokes: [],
          assets: [],
        }),
        "utf8",
      );

      // This tests scope filtering, not rendering speed; allow both real PNG drafts.
      const watch = await testHarness.app.request(
        `http://${HOST}/api/watch?all=true&timeout=15&project=${encodeURIComponent(initBody.data.project_id)}&space=${encodeURIComponent(initBody.data.space_id)}`,
        { headers: headers() },
      );
      const reader = watch.body!.getReader();
      const firstLine = readNdjsonLine(reader);

      await postCommand(testHarness, {
        argv: ["project", "create", "other", "--json"],
        cwd: testHarness.cwd,
      });
      await postCommand(testHarness, {
        argv: ["draft", "--file", "scope-scene.json", "--json"],
        cwd: testHarness.cwd,
      });
      await postCommand(testHarness, {
        argv: ["commit", "-m", "other project", "--json"],
        cwd: testHarness.cwd,
      });

      await postCommand(testHarness, {
        argv: ["project", "switch", initBody.data.project_id, "--json"],
        cwd: testHarness.cwd,
      });
      await postCommand(testHarness, {
        argv: ["draft", "--file", "scope-scene.json", "--json"],
        cwd: testHarness.cwd,
      });
      await postCommand(testHarness, {
        argv: ["commit", "-m", "target project", "--json"],
        cwd: testHarness.cwd,
      });

      const event = JSON.parse(await firstLine) as {
        project_id: string;
        space_id: string;
        title: string;
      };
      expect(event.project_id).toBe(initBody.data.project_id);
      expect(event.space_id).toBe(initBody.data.space_id);
      expect(event.title).toBe("target project");
      await reader.cancel();
    } finally {
      await testHarness.pool.closeAll();
    }
  });

  test("CLI watch client forwards NDJSON from a running server", async () => {
    const event = {
      event: "layer_committed",
      layer_id: "01M5H4QFEDB0X44RK6VWW58FCZ",
      project_id: "01M5H4QEZ3SN0ZSG290VS2AJSB",
      seq: 2,
      short_id: "L2",
      parent_id: "01M5H4QF219CD8C6VY987ETWAF",
      kind: "derive",
      title: "API",
      title_source: "agent",
      author: { kind: "cli" },
      diff: { mode: "ast", summary: "节点 +1" },
    };
    let requestedUrl = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requestedUrl = request.url;
        const path = new URL(request.url).pathname;
        if (path === "/health") {
          return Response.json({ ok: true, service: "humanboard" });
        }
        if (path !== "/api/watch") {
          return new Response("not found", { status: 404 });
        }
        return new Response(`${JSON.stringify(event)}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      },
    });
    try {
      let stdout = "";
      let stderr = "";
      const exitCode = await watchLocalServer({
        env: {
          HUMANBOARD_SERVER_URL: `http://127.0.0.1:${server.port}`,
        },
        project: "payments",
        space: "state-machine",
        all: true,
        timeoutSeconds: 1,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout.trim())).toEqual(event);
      expect(new URL(requestedUrl).searchParams.get("project")).toBe(
        "payments",
      );
      expect(new URL(requestedUrl).searchParams.get("space")).toBe(
        "state-machine",
      );
    } finally {
      await server.stop(true);
    }
  });

  test("CLI watch client maps the server timeout line to exit 124", async () => {
    const timeoutLine = {
      error: {
        code: "E_WATCH_TIMEOUT",
        message: "watch timed out after 0.1s",
        details: { timeout_s: 0.1 },
      },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/health") {
          return Response.json({ ok: true, service: "humanboard" });
        }
        return new Response(`${JSON.stringify(timeoutLine)}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      },
    });
    try {
      let stdout = "";
      let stderr = "";
      const exitCode = await watchLocalServer({
        env: {
          HUMANBOARD_SERVER_URL: `http://127.0.0.1:${server.port}`,
        },
        all: true,
        timeoutSeconds: 0.1,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(124);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error.code).toBe("E_WATCH_TIMEOUT");
    } finally {
      await server.stop(true);
    }
  });
});
