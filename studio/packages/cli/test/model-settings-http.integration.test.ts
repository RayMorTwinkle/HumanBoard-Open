import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";
const headers = {
  "Content-Type": "application/json",
  "X-HumanBoard-Client": "1",
};
const homes: string[] = [];
const runtimes: ServerRuntime[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function start(home?: string) {
  home ??= await mkdtemp(join(tmpdir(), "humanboard-model-http-"));
  if (!homes.includes(home)) homes.push(home);
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd: home,
    env: {
      HUMANBOARD_HOME: join(home, "data"),
      HUMANBOARD_SESSION: "model-settings-test",
      HUMAN_AUTO_TITLE: "off",
    },
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  return { runtime, home };
}
async function post(runtime: ServerRuntime, path: string, body: unknown) {
  return fetch(runtime.url + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
async function configure(runtime: ServerRuntime, body: unknown) {
  const r = await post(runtime, "/api/agent/models", body);
  expect(r.status).toBe(200);
  return r.json();
}
async function cmd(runtime: ServerRuntime, argv: string[], stdin?: string) {
  const r = await post(runtime, "/api/command", {
    argv: [...argv, "--json"],
    stdin,
  });
  const data = await r.json();
  expect(data.exitCode).toBe(0);
  return data.data;
}
async function init(runtime: ServerRuntime) {
  await cmd(runtime, ["init"]);
  await cmd(
    runtime,
    ["draft", "--stdin"],
    JSON.stringify({ nodes: [], edges: [], assets: [], strokes: [] }),
  );
  await cmd(runtime, ["commit", "-m", "settings root"]);
  return (await runtime.pool.getDefault()).resolveWatchScope({
    output: "json",
  });
}

test("HTTP model settings are protected, private, persistent and immediately usable without restarting", async () => {
  const calls: { model: string; key: string }[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      calls.push({
        model: body.model,
        key: req.headers.get("Authorization") ?? "",
      });
      return Response.json({
        choices: [
          {
            message: { content: `模型 ${body.model} 已连接` },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  servers.push(provider);
  const { runtime, home } = await start();
  const scope = await init(runtime);
  const body = {
    role: "agent",
    model: "model-first",
    base_url: `http://127.0.0.1:${provider.port}/v1`,
    api_key: "PRIVATE_HTTP_KEY",
    enabled: true,
  };
  const denied = await fetch(runtime.url + "/api/agent/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(denied.status).toBe(403);
  const configured = await configure(runtime, body);
  expect(configured.agent.configured).toBe(true);
  expect(JSON.stringify(configured)).not.toContain("PRIVATE_HTTP_KEY");
  const response = await post(runtime, "/api/agent/chat", {
    ...scope,
    message: "首次配置后聊天",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).assistant_message).toBe(
    "模型 model-first 已连接",
  );
  await configure(runtime, {
    role: "agent",
    model: "model-second",
    api_key: "",
  });
  expect(
    (
      await (
        await post(runtime, "/api/agent/chat", {
          ...scope,
          message: "切换模型后聊天",
        })
      ).json()
    ).assistant_message,
  ).toBe("模型 model-second 已连接");
  expect(calls).toEqual([
    { model: "model-first", key: "Bearer PRIVATE_HTTP_KEY" },
    { model: "model-second", key: "Bearer PRIVATE_HTTP_KEY" },
  ]);
  expect(
    (await stat(join(home, "data/model-settings.json"))).mode & 0o777,
  ).toBe(0o600);
  await runtime.stop();
  runtimes.splice(runtimes.indexOf(runtime), 1);
  const restarted = (await start(home)).runtime;
  const restored = await fetch(restarted.url + "/api/agent/config");
  expect(restored.headers.get("cache-control")).toBe("no-store");
  const publicConfig = await restored.json();
  expect(publicConfig.agent.model).toBe("model-second");
  expect(JSON.stringify(publicConfig)).not.toContain("PRIVATE_HTTP_KEY");
  await configure(restarted, {
    role: "agent",
    enabled: false,
    clear_api_key: true,
  });
  const disabled = await post(restarted, "/api/agent/chat", {
    ...scope,
    message: "停用后不能生成",
  });
  expect(disabled.status).toBe(409);
  expect(calls).toHaveLength(2);
  expect(
    await readFile(join(home, "data/model-settings.json"), "utf8"),
  ).not.toContain("PRIVATE_HTTP_KEY");
});

test("changing model settings during a tool round pins every step to the original provider", async () => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const calls: { model: string; key: string }[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        model: string;
        messages: { role: string }[];
      };
      calls.push({
        model: body.model,
        key: req.headers.get("Authorization") ?? "",
      });
      if (calls.length === 1) {
        entered();
        await gate;
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "layers-first",
                    type: "function",
                    function: { name: "humanboard_layers", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: { content: `回答来自 ${body.model}` },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  servers.push(provider);
  const { runtime } = await start();
  const scope = await init(runtime),
    endpoint = `http://127.0.0.1:${provider.port}/v1`;
  await configure(runtime, {
    role: "agent",
    model: "model-a",
    base_url: endpoint,
    api_key: "KEY_A",
    enabled: true,
  });
  const pending = post(runtime, "/api/agent/chat", {
    ...scope,
    message: "查历史后再回答",
  });
  await enteredPromise;
  try {
    await configure(runtime, {
      role: "agent",
      model: "model-b",
      api_key: "KEY_B",
    });
  } finally {
    release();
  }
  const completed = await (await pending).json();
  expect(completed.status).toBe("completed");
  expect(completed.assistant_message).toBe("回答来自 model-a");
  expect(completed.tool_trace[0].status).toBe("completed");
  expect(
    (
      await (
        await post(runtime, "/api/agent/chat", { ...scope, message: "新回合" })
      ).json()
    ).assistant_message,
  ).toBe("回答来自 model-b");
  expect(calls).toEqual([
    { model: "model-a", key: "Bearer KEY_A" },
    { model: "model-a", key: "Bearer KEY_A" },
    { model: "model-b", key: "Bearer KEY_B" },
  ]);
});

test("configuring title models resumes pending images and layers that had no model", async () => {
  const calls: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      calls.push(body.model);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title:
                  body.model === "image-title-model"
                    ? "热更新图片标题"
                    : "热更新层标题",
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  servers.push(provider);
  const { runtime, home } = await start();
  await init(runtime);
  await post(runtime, "/api/agent/settings", { auto_title: true });
  const { writeFile } = await import("node:fs/promises");
  const pngPath = join(home, "shot.png");
  await writeFile(
    pngPath,
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
    ]),
  );
  const draft = await cmd(
    runtime,
    ["draft", "--merge", "-"],
    JSON.stringify({
      upsert_nodes: [
        {
          id: "title-node",
          kind: "service",
          title: "标题验收",
          rect: { x: 50, y: 50, w: 180, h: 80 },
        },
      ],
      upsert_assets: [
        {
          source: { kind: "file", path: pngPath },
          rect: { x: 250, y: 50, w: 100, h: 100 },
          z: 1,
        },
      ],
    }),
  );
  const committed = await cmd(runtime, ["commit"]);
  expect(calls).toHaveLength(0);
  const endpoint = `http://127.0.0.1:${provider.port}/v1`;
  await configure(runtime, {
    role: "vision",
    enabled: true,
    model: "image-title-model",
    base_url: endpoint,
    api_key: "IMAGE_TEST_KEY",
  });
  const service = await runtime.pool.getDefault();
  const pendingLayerCount = (await service.pendingTitleCandidates()).layers
    .length;
  await configure(runtime, {
    role: "text",
    enabled: true,
    model: "layer-title-model",
    base_url: endpoint,
    api_key: "TEXT_TEST_KEY",
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const asset = await service.getAsset(draft.registered_assets[0].asset_id);
    const layer = await cmd(runtime, ["get", committed.layer_id]);
    if (
      asset?.title === "热更新图片标题" &&
      layer.layer.title === "热更新层标题"
    )
      break;
    await Bun.sleep(20);
  }
  expect(
    (await service.getAsset(draft.registered_assets[0].asset_id))?.title,
  ).toBe("热更新图片标题");
  expect((await cmd(runtime, ["get", committed.layer_id])).layer.title).toBe(
    "热更新层标题",
  );
  expect(calls.filter((m) => m === "image-title-model")).toHaveLength(1);
  expect(calls.filter((m) => m === "layer-title-model")).toHaveLength(
    pendingLayerCount,
  );
  const total = calls.length;
  await configure(runtime, { role: "text", model: "layer-title-model" });
  expect(calls).toHaveLength(total);
});
