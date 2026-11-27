import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelGenerationInput,
  ModelGenerationOutput,
  ModelProvider,
} from "@humanboard/core-engine";

import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";

const temporaryDirectories: string[] = [];

class TitleProvider implements ModelProvider {
  readonly calls: ModelGenerationInput[] = [];

  async generate(input: ModelGenerationInput): Promise<ModelGenerationOutput> {
    this.calls.push(input);
    const isImage = input.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url"),
    );
    return {
      content: JSON.stringify({
        title: isImage ? "自动截图标题" : "自动层标题",
      }),
      toolCalls: [],
      finishReason: "stop",
    };
  }
}

interface Fixture {
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-title-"));
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
      HUMANBOARD_SESSION: "background-title-session",
      HUMAN_AUTO_TITLE: "on",
      HUMAN_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
      HUMAN_MODEL_API_KEY: "test-key",
      HUMAN_AGENT_MODEL: "agent-model",
      HUMAN_VISION_MODEL: "vision-model",
      HUMAN_TEXT_MODEL: "text-model",
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

async function command<T>(
  runtime: ServerRuntime,
  argv: readonly string[],
  stdin?: string,
): Promise<T> {
  const response = await fetch(`${runtime.url}/api/command`, {
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

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for background title task");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("background title tasks", () => {
  test("titles pending Layers and newly registered images without blocking commands", async () => {
    const value = await fixture();
    const provider = new TitleProvider();
    const runtime = await createServerRuntime({
      cwd: value.cwd,
      env: value.env,
      host: "127.0.0.1",
      port: await freePort(),
      visionProvider: provider,
      textProvider: provider,
    });
    try {
      const initialized = await command<{
        project_id: string;
        space_id: string;
      }>(runtime, ["init", "--json"]);

      const pngPath = join(value.cwd, "shot.png");
      await writeFile(
        pngPath,
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
          0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
          0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
        ]),
      );
      const draft = await command<{
        registered_assets: Array<{ asset_id: string }>;
      }>(
        runtime,
        ["draft", "--merge", "-", "--json"],
        JSON.stringify({
          add_strokes: [
            {
              id: "background-stroke",
              tool: "pen",
              color: "#ff5b47",
              width: 2,
              points: [
                [10, 10],
                [20, 20],
              ],
            },
          ],
          upsert_assets: [
            {
              source: { kind: "file", path: "shot.png" },
              rect: { x: 40, y: 40, w: 100, h: 80 },
              z: 1,
            },
          ],
        }),
      );
      const assetId = draft.registered_assets[0]!.asset_id;
      const committed = await command<{
        layer_id: string;
        title: string;
        title_source: string;
      }>(runtime, ["commit", "--json"]);
      expect(committed.title).toBe("自动层标题");
      expect(committed.title_source).toBe("builtin");

      const service = await runtime.pool.getDefault();
      const titledLayer = await waitFor(async () => {
        const layers = await command<{
          layers: Array<{ id: string; title: string; title_source: string }>;
        }>(runtime, ["layers", "--json"]);
        return (
          layers.layers.find(
            (item) => item.id === committed.layer_id && item.title.length > 0,
          ) ?? null
        );
      });
      expect(titledLayer.title).toBe("自动层标题");
      expect(titledLayer.title_source).toBe("builtin");

      const titledAsset = await waitFor(async () => {
        const asset = await service.getAsset(assetId);
        return asset !== null && asset.title.length > 0 ? asset : null;
      });
      expect(titledAsset.title).toBe("自动截图标题");
      expect(titledAsset.title_source).toBe("builtin");

      const config = await fetch(`${runtime.url}/api/agent/config`).then(
        (response) =>
          response.json() as Promise<{
            titles: {
              queue: { completed: number; failed: number };
              recent: Array<{ status: string; task: string }>;
            };
          }>,
      );
      expect(config.titles.queue.completed).toBeGreaterThanOrEqual(2);
      expect(config.titles.queue.failed).toBe(0);
      expect(
        config.titles.recent.some(
          (event) => event.task === "image" && event.status === "completed",
        ),
      ).toBe(true);
    } finally {
      runtime.syncScheduler.dispose();
      await runtime.running.stop();
      await runtime.pool.closeAll();
    }
  });
});

test("commit waits at most three seconds, then the same title attempt completes in background", async () => {
  const value = await fixture();
  let release!: (output: ModelGenerationOutput) => void;
  let calls = 0;
  const provider: ModelProvider = {
    generate: async () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const runtime = await createServerRuntime({
    cwd: value.cwd,
    env: value.env,
    host: "127.0.0.1",
    port: await freePort(),
    textProvider: provider,
  });
  try {
    await command(runtime, ["init"]);
    await command(runtime, ["draft"]);
    const start = performance.now();
    const committed = await command<{
      layer_id: string;
      title: string;
      title_source: string;
      warnings: { code: string }[];
    }>(runtime, ["commit"]);
    expect(performance.now() - start).toBeGreaterThanOrEqual(2800);
    expect(performance.now() - start).toBeLessThan(4500);
    expect(committed.title_source).toBe("pending");
    expect(committed.warnings.some((w) => w.code === "W_TITLE_PENDING")).toBe(
      true,
    );
    expect(calls).toBe(1);
    release({
      content: JSON.stringify({ title: "超时后完成" }),
      toolCalls: [],
    });
    const titled = await waitFor(async () => {
      const data = await command<{ layer: { title: string } }>(runtime, [
        "get",
        committed.layer_id,
      ]);
      return data.layer.title ? data : null;
    });
    expect(titled.layer.title).toBe("超时后完成");
    expect(calls).toBe(1);
  } finally {
    release?.({ content: JSON.stringify({ title: "清理" }), toolCalls: [] });
    await runtime.stop();
  }
});
