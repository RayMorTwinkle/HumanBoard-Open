import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_CANVAS_TOOL_NAME,
  type ModelGenerationInput,
  type ModelGenerationOutput,
  type ModelProvider,
} from "@humanboard/core-engine";

import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";

const temporaryDirectories: string[] = [];

class MockProvider implements ModelProvider {
  readonly calls: ModelGenerationInput[] = [];

  async generate(input: ModelGenerationInput): Promise<ModelGenerationOutput> {
    this.calls.push(input);
    const last = [...input.messages].reverse().find((m) => m.role === "tool");
    if (last?.content && String(last.content).includes('"saved":true'))
      return { content: "已提交 HTTP 转化", toolCalls: [] };
    if (last)
      return {
        content: null,
        toolCalls: [
          {
            id: "commit-http",
            name: "humanboard_commit",
            arguments: JSON.stringify({ title: "HTTP 转化" }),
          },
        ],
      };
    return {
      content: null,
      toolCalls: [
        {
          id: "call-http",
          name: AGENT_CANVAS_TOOL_NAME,
          arguments: JSON.stringify({
            kind: "transform",
            patch: {
              upsert_nodes: [
                {
                  id: "http-node",
                  kind: "note",
                  title: "HTTP node",
                  rect: { x: 100, y: 100, w: 140, h: 70 },
                },
              ],
            },
          }),
        },
      ],
      finishReason: "tool_calls",
    };
  }
}

interface Fixture {
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

interface RuntimeHandle {
  readonly runtime: ServerRuntime;
  stopped: boolean;
}

async function fixture(configured: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-agent-http-"));
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
      HUMANBOARD_SESSION: "agent-http-session",
      ...(configured
        ? {
            HUMAN_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
            HUMAN_MODEL_API_KEY: "test-key",
            HUMAN_AGENT_MODEL: "agent-model",
            HUMAN_VISION_MODEL: "vision-model",
            HUMAN_TEXT_MODEL: "text-model",
          }
        : {}),
    },
  };
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

async function start(
  value: Fixture,
  provider?: ModelProvider,
): Promise<RuntimeHandle> {
  return {
    runtime: await createServerRuntime({
      cwd: value.cwd,
      env: value.env,
      host: "127.0.0.1",
      port: await freePort(),
      ...(provider === undefined ? {} : { agentProvider: provider }),
    }),
    stopped: false,
  };
}

async function stop(handle: RuntimeHandle): Promise<void> {
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
): Promise<T> {
  const response = await fetch(`${handle.runtime.url}/api/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
    },
    body: JSON.stringify({ argv }),
  });
  const body = (await response.json()) as {
    readonly exitCode: number;
    readonly data?: T;
    readonly error?: unknown;
  };
  if (body.exitCode !== 0 || body.data === undefined) {
    throw new Error(`Command failed: ${JSON.stringify(body.error)}`);
  }
  return body.data;
}

async function init(handle: RuntimeHandle): Promise<{
  readonly project_id: string;
  readonly space_id: string;
}> {
  return command(handle, ["init", "--json"]);
}

async function rootLayer(handle: RuntimeHandle): Promise<string> {
  const data = await command<{
    readonly layers: Array<{ readonly id: string }>;
  }>(handle, ["layers", "--json"]);
  return data.layers[0]!.id;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("built-in agent HTTP API", () => {
  test("reports model configuration and commits an agent chat result", async () => {
    const value = await fixture(true);
    const provider = new MockProvider();
    const handle = await start(value, provider);
    try {
      const scope = await init(handle);
      const baseLayerId = await rootLayer(handle);
      const configResponse = await fetch(
        `${handle.runtime.url}/api/agent/config`,
      );
      expect(configResponse.status).toBe(200);
      const config = (await configResponse.json()) as {
        agent: { configured: boolean; model: string };
        vision: { configured: boolean; model: string };
        text: { configured: boolean; model: string };
        titles: {
          enabled: boolean;
          queue: { completed: number; failed: number };
        };
      };
      expect(config.agent).toMatchObject({
        configured: true,
        model: "agent-model",
      });
      expect(config.vision).toMatchObject({
        configured: true,
        model: "vision-model",
      });
      expect(config.text).toMatchObject({
        configured: true,
        model: "text-model",
      });
      expect(config.titles.enabled).toBe(true);

      const response = await fetch(`${handle.runtime.url}/api/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HumanBoard-Client": "1",
        },
        body: JSON.stringify({
          project_id: scope.project_id,
          space_id: scope.space_id,
          base_layer_id: baseLayerId,
          message: "把当前草图变成逻辑图",
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        readonly assistant_message: string;
        readonly result_layer_id: string;
        readonly kind: string;
        readonly diff: { readonly mode: string };
      };
      expect(result.kind).toBe("transform");
      expect(result.assistant_message).toContain("HTTP 转化");
      expect(result.diff.mode).toBe("transform");
      expect(provider.calls).toHaveLength(3);

      const layer = await command<{
        layer: { id: string; kind: string; parent_id: string };
      }>(handle, ["get", result.result_layer_id, "--json"]);
      expect(layer.layer).toMatchObject({
        id: result.result_layer_id,
        kind: "transform",
        parent_id: baseLayerId,
      });

      const historyResponse = await fetch(
        `${handle.runtime.url}/api/agent/history?project_id=${encodeURIComponent(scope.project_id)}&space_id=${encodeURIComponent(scope.space_id)}`,
      );
      expect(historyResponse.status).toBe(200);
      const history = (await historyResponse.json()) as {
        session_id: string;
        messages: Array<{
          seq: number;
          role: string;
          content: string;
        }>;
      };
      expect(history.session_id.length).toBe(26);
      expect(history.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(history.messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(history.messages[0]?.content).toBe("把当前草图变成逻辑图");
    } finally {
      await stop(handle);
    }
  });

  test("returns E_USAGE with model_unconfigured when agent model is absent", async () => {
    const value = await fixture(false);
    const handle = await start(value);
    try {
      const scope = await init(handle);
      const baseLayerId = await rootLayer(handle);
      const config = (await fetch(
        `${handle.runtime.url}/api/agent/config`,
      ).then((response) => response.json())) as {
        agent: { configured: boolean; missing_env: readonly string[] };
      };
      expect(config.agent.configured).toBe(false);
      expect(config.agent.missing_env).toContain("HUMAN_AGENT_MODEL");

      const response = await fetch(`${handle.runtime.url}/api/agent/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HumanBoard-Client": "1",
        },
        body: JSON.stringify({
          project_id: scope.project_id,
          space_id: scope.space_id,
          base_layer_id: baseLayerId,
          message: "hello",
        }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        readonly error: {
          readonly code: string;
          readonly details: {
            readonly model_unconfigured: boolean;
            readonly env: string;
          };
        };
      };
      expect(body.error.code).toBe("E_USAGE");
      expect(body.error.details).toMatchObject({
        model_unconfigured: true,
        env: "HUMAN_AGENT_MODEL",
      });
    } finally {
      await stop(handle);
    }
  });
});

test("a text-only Agent turn does not emit a commit and stores a null result", async () => {
  const value = await fixture(true);
  const handle = await start(value, {
    generate: async () => ({
      content: "可以先讨论，我没有修改画板。",
      toolCalls: [],
    }),
  });
  try {
    const scope = await init(handle),
      base = await rootLayer(handle);
    let commits = 0;
    const unsubscribe = handle.runtime.events.subscribe(
      () => {
        commits++;
      },
      { all: true },
    );
    const response = await fetch(`${handle.runtime.url}/api/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        project_id: scope.project_id,
        space_id: scope.space_id,
        base_layer_id: base,
        message: "先解释，不改图",
      }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      result_layer_id: string | null;
      assistant_message: string;
      tool_trace: unknown[];
    };
    expect(data.result_layer_id).toBeNull();
    expect(data.assistant_message).toContain("没有修改");
    expect(commits).toBe(0);
    const history = (await fetch(
      `${handle.runtime.url}/api/agent/history?project_id=${scope.project_id}&space_id=${scope.space_id}`,
    ).then((r) => r.json())) as {
      messages: { result_layer_id: string | null }[];
    };
    expect(history.messages.at(-1)?.result_layer_id).toBeNull();
    unsubscribe();
  } finally {
    await stop(handle);
  }
});

test("exposes a running turn, rejects concurrent chat, and cancels without committing", async () => {
  const value = await fixture(true);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handle = await start(value, {
    generate: async (input) => {
      input.onTextDelta?.("已收到你的问题，正在检查。 ");
      input.onTextDelta?.("本轮尚未完成。");
      entered();
      return new Promise((_, reject) => {
        const abort = () => reject(new Error("request aborted"));
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  try {
    const scope = await init(handle);
    const base = await rootLayer(handle);
    const headers = {
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
    };
    const body = JSON.stringify({
      ...scope,
      base_layer_id: base,
      message: "测试停止",
    });
    const pending = fetch(`${handle.runtime.url}/api/agent/chat`, {
      method: "POST",
      headers,
      body,
    });
    await ready;
    const runUrl = `${handle.runtime.url}/api/agent/run?project_id=${scope.project_id}&space_id=${scope.space_id}`;
    const active = (await fetch(runUrl).then((r) => r.json())) as {
      run: { step: number; phase: string };
    };
    expect(active.run).toMatchObject({
      step: 1,
      phase: "thinking",
      partial_message: "已收到你的问题，正在检查。 本轮尚未完成。",
    });
    const duplicate = await fetch(`${handle.runtime.url}/api/agent/chat`, {
      method: "POST",
      headers,
      body,
    });
    expect(duplicate.status).toBe(400);
    const denied = await fetch(`${handle.runtime.url}/api/agent/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scope),
    });
    expect(denied.status).toBe(403);
    const cancelled = await fetch(`${handle.runtime.url}/api/agent/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify(scope),
    }).then((r) => r.json());
    expect(cancelled).toEqual({ cancelled: true });
    const result = (await pending.then((r) => r.json())) as {
      status: string;
      result_layer_id: string | null;
    };
    expect(result.status).toBe("cancelled");
    expect(result.result_layer_id).toBeNull();
    expect(await fetch(runUrl).then((r) => r.json())).toEqual({ run: null });
    const layers = await command<{ layers: unknown[] }>(handle, [
      "layers",
      "--json",
    ]);
    expect(layers.layers).toHaveLength(1);
  } finally {
    await stop(handle);
  }
});

test("built-in capture shares the frontend channel and reads unsaved Scene only when called", async () => {
  const value = await fixture(true);
  const calls: ModelGenerationInput[] = [];
  const handle = await start(value, {
    generate: async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        expect(JSON.stringify(input.messages)).not.toContain("image_url");
        return {
          content: null,
          toolCalls: [
            { id: "live-read", name: "humanboard_capture", arguments: "{}" },
          ],
        };
      }
      expect(JSON.stringify(input.messages)).toContain("未保存的现场");
      expect(JSON.stringify(input.messages)).toContain(
        "data:image/png;base64,",
      );
      return { content: "我看到了未保存的现场。", toolCalls: [] };
    },
  });
  try {
    const scope = await init(handle),
      base = await rootLayer(handle);
    const front = handle.runtime.frontendHub.register(scope);
    const request = handle.runtime.frontendHub.waitForRequest(front.session_id);
    const response = fetch(`${handle.runtime.url}/api/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        ...scope,
        base_layer_id: base,
        message: "看看当前的现场，先不修改",
      }),
    });
    const capture = await request;
    expect(capture).not.toBeNull();
    handle.runtime.frontendHub.respond(front.session_id, capture!.request_id, {
      based_on_layer: base,
      based_on_seq: 1,
      scene: {
        nodes: [
          {
            id: "unsaved",
            kind: "note",
            title: "未保存的现场",
            rect: { x: 100, y: 100, w: 160, h: 80 },
          },
        ],
        edges: [],
        assets: [],
        strokes: [],
      },
      layer: { id: base },
      assets: [],
      has_uncommitted: true,
      uncommitted: {},
      captured_at: new Date().toISOString(),
    });
    const data = (await response.then((r) => r.json())) as {
      status: string;
      result_layer_id: string | null;
    };
    expect(data.status).toBe("completed");
    expect(data.result_layer_id).toBeNull();
    expect(
      (await command<{ layers: unknown[] }>(handle, ["layers", "--json"]))
        .layers,
    ).toHaveLength(1);
  } finally {
    await stop(handle);
  }
});

test("automatic title preference is validated, persisted and restored after restart", async () => {
  const value = await fixture(true);
  const handle = await start(value, new MockProvider());
  try {
    await init(handle);
    const missingHeader = await fetch(
      `${handle.runtime.url}/api/agent/settings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_title: false }),
      },
    );
    expect(missingHeader.status).toBe(403);
    const response = await fetch(`${handle.runtime.url}/api/agent/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({ auto_title: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ auto_title: false });
    await stop(handle);
    const restarted = await start(value, new MockProvider());
    try {
      const config = (await fetch(
        `${restarted.runtime.url}/api/agent/config`,
      ).then((r) => r.json())) as { titles: { enabled: boolean } };
      expect(config.titles.enabled).toBe(false);
    } finally {
      await stop(restarted);
    }
  } finally {
    await stop(handle);
  }
});
