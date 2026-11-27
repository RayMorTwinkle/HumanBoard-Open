import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpAuthConfig } from "@humanboard/server-self-hosted/mcp-app";

import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[];
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: readonly {
      readonly type: "text";
      readonly text: string;
    }[];
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface ProjectCreated {
  readonly project_id: string;
  readonly current_space_id: string;
}

interface SpaceChanged {
  readonly space_id: string;
  readonly switched: boolean;
}

interface StatusData {
  readonly project: { readonly id: string; readonly name: string };
  readonly space: { readonly id: string; readonly name: string };
  readonly active_layer: string | null;
}

interface CaptureData {
  readonly based_on_layer: string;
  readonly has_uncommitted: boolean;
  readonly uncommitted: { readonly strokes: { readonly added: number } };
  readonly snapshot_id: string;
  readonly render: { readonly url: string };
}

interface ToolFailureData {
  readonly exitCode: number;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

const temporaryDirectories: string[] = [];
const runtimes: ServerRuntime[] = [];

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

async function startRuntime(
  name: string,
  options: { readonly mcpAuth?: McpAuthConfig } = {},
): Promise<ServerRuntime> {
  const root = await mkdtemp(join(tmpdir(), `humanboard-${name}-`));
  temporaryDirectories.push(root);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const runtime = await createServerRuntime({
    cwd,
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
    host: "127.0.0.1",
    port: await freePort(),
    ...(options.mcpAuth === undefined ? {} : { mcpAuth: options.mcpAuth }),
  });
  runtimes.push(runtime);
  return runtime;
}

async function rpc(
  runtime: ServerRuntime,
  payload: unknown,
  options: {
    readonly sessionId?: string;
    readonly token?: string;
  } = {},
): Promise<{ readonly response: Response; readonly body: JsonRpcResponse }> {
  const response = await fetch(`${runtime.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
      ...(options.sessionId === undefined
        ? {}
        : { "Mcp-Session-Id": options.sessionId }),
      ...(options.token === undefined
        ? {}
        : { Authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify(payload),
  });
  return {
    response,
    body: (await response.json()) as JsonRpcResponse,
  };
}

function toolCall(
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function callTool<T>(
  runtime: ServerRuntime,
  sessionId: string,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const { response, body } = await rpc(runtime, toolCall(name, args), {
    sessionId,
  });
  expect(response.status).toBe(200);
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(false);
  return body.result?.structuredContent as T;
}

async function callToolFailure(
  runtime: ServerRuntime,
  sessionId: string,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<ToolFailureData> {
  const { response, body } = await rpc(runtime, toolCall(name, args), {
    sessionId,
  });
  expect(response.status).toBe(200);
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBe(true);
  return body.result?.structuredContent as ToolFailureData;
}

async function registerFrontend(
  runtime: ServerRuntime,
  projectId: string,
  spaceId: string,
): Promise<{ readonly session_id: string }> {
  const response = await fetch(`${runtime.url}/api/frontend/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HumanBoard-Client": "1",
    },
    body: JSON.stringify({
      project_id: projectId,
      space_id: spaceId,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { readonly session_id: string };
}

async function waitForCaptureRequest(
  runtime: ServerRuntime,
  sessionId: string,
  timeoutMs: number,
): Promise<{ readonly request_id: string } | null> {
  const response = await fetch(
    `${runtime.url}/api/frontend/requests?session_id=${sessionId}&timeout=${timeoutMs}`,
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    readonly request: { readonly request_id: string } | null;
  };
  return payload.request;
}

function captureResponsePayload(
  sessionId: string,
  requestId: string,
  basedOnLayer: string,
): Readonly<Record<string, unknown>> {
  return {
    session_id: sessionId,
    request_id: requestId,
    based_on_layer: basedOnLayer,
    based_on_seq: 1,
    scene: {
      nodes: [],
      edges: [],
      strokes: [
        {
          id: "scoped-live-stroke",
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
      id: basedOnLayer,
      short_id: "L1",
      seq: 1,
      title: "Scoped capture",
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
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP mounted on human serve", () => {
  test("passes versioned MCP writes through the command parser into the scoped board", async () => {
    const runtime = await startRuntime("mcp-versions");
    const session = "board-editor";
    const project = await callTool<ProjectCreated>(
      runtime,
      session,
      "project",
      { action: "create", value: "Versions" },
    );
    const scope = {
      space: project.current_space_id,
      project: project.project_id,
    };
    const a = await callTool<
      import("../../core-engine/src/revisions/service").StudioState
    >(runtime, session, "board_state", scope);
    await callTool(runtime, session, "board_fork", {
      ...scope,
      branch: "agent",
      from: a.head,
    });
    const events: string[] = [];
    const unsubscribe = runtime.events.subscribe(
      (event) => events.push(event.layer_id),
      { spaceId: scope.space, all: true },
    );
    const saved = await callTool<{ head: string }>(
      runtime,
      session,
      "board_save",
      {
        ...scope,
        branch: "agent",
        head: a.head,
        title: "Agent change",
        scene: {
          ...a.scene,
          nodes: [
            ...a.scene.nodes,
            {
              id: "entry",
              kind: "job",
              title: "Check",
              rect: { x: 1, y: 2, w: 120, h: 90 },
            },
          ],
        },
      },
    );
    const pair = {
      ...scope,
      branch: "main",
      head: a.head,
      source: saved.head,
      sourceBranch: "agent",
    };
    const review = await callTool<
      import("../../core-engine/src/revisions/service").Review
    >(runtime, session, "board_review", pair);
    expect(review.changes[0]?.id).toBe("entry");
    const accepted = await callTool<{ head: string }>(
      runtime,
      session,
      "board_accept",
      pair,
    );
    await callTool(runtime, session, "board_accept", {
      ...pair,
      head: accepted.head,
    });
    unsubscribe();
    expect(events).toEqual([saved.head, accepted.head]);
  });

  test("keeps project and space switches isolated by Mcp-Session-Id", async () => {
    const runtime = await startRuntime("mcp-scope-isolation");

    const alpha = await callTool<ProjectCreated>(
      runtime,
      "session-alpha",
      "project",
      { action: "create", value: "Alpha" },
    );
    const beta = await callTool<ProjectCreated>(
      runtime,
      "session-beta",
      "project",
      { action: "create", value: "Beta" },
    );

    await callTool<ProjectCreated>(runtime, "session-alpha", "project", {
      action: "create",
      value: "Alpha Two",
    });
    await callTool<ProjectCreated>(runtime, "session-alpha", "project", {
      action: "switch",
      value: alpha.project_id,
    });
    const alphaRestored = await callTool<StatusData>(
      runtime,
      "session-alpha",
      "status",
    );
    const sideSpace = await callTool<SpaceChanged>(
      runtime,
      "session-alpha",
      "space",
      { action: "create", value: "Alpha Side" },
    );
    expect(sideSpace.switched).toBe(true);
    await callTool<SpaceChanged>(runtime, "session-alpha", "space", {
      action: "switch",
      value: alphaRestored.space.id,
    });

    const finalAlpha = await callTool<StatusData>(
      runtime,
      "session-alpha",
      "status",
    );
    const finalBeta = await callTool<StatusData>(
      runtime,
      "session-beta",
      "status",
    );

    expect(finalAlpha.project.id).toBe(alpha.project_id);
    expect(finalAlpha.space.id).toBe(alphaRestored.space.id);
    expect(finalBeta.project.id).toBe(beta.project_id);
    expect(finalBeta.space.id).toBe(beta.current_space_id);
  });

  test("captures through /mcp with the FrontendSessionHub mounted on human serve", async () => {
    const runtime = await startRuntime("mcp-capture");
    const created = await callTool<ProjectCreated>(
      runtime,
      "session-capture",
      "project",
      { action: "create", value: "Capture" },
    );
    const status = await callTool<StatusData>(
      runtime,
      "session-capture",
      "status",
    );
    if (status.active_layer === null) {
      throw new Error("Expected the new Space to have an active root Layer");
    }

    const registration = await fetch(`${runtime.url}/api/frontend/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        project_id: created.project_id,
        space_id: created.current_space_id,
      }),
    });
    expect(registration.status).toBe(200);
    const frontend = (await registration.json()) as { session_id: string };

    const poll = fetch(
      `${runtime.url}/api/frontend/requests?session_id=${frontend.session_id}&timeout=2000`,
    );
    await Bun.sleep(20);
    const capture = callTool<CaptureData>(
      runtime,
      "session-capture",
      "capture",
    );
    const requestResponse = await poll;
    expect(requestResponse.status).toBe(200);
    const request = (await requestResponse.json()) as {
      request: { request_id: string; timeout_ms: number };
    };
    expect(request.request.timeout_ms).toBe(2000);

    const uncommitted = {
      strokes: { added: 1, erased: 0 },
      nodes: { added: [], updated: [], moved: [], removed: [] },
      edges: { added: [], updated: [], removed: [] },
      assets: { added: [], moved: [], removed: [] },
    };
    const response = await fetch(`${runtime.url}/api/frontend/response`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        session_id: frontend.session_id,
        request_id: request.request.request_id,
        based_on_layer: status.active_layer,
        based_on_seq: 1,
        scene: {
          nodes: [],
          edges: [],
          strokes: [
            {
              id: "mcp-live-stroke",
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
          id: status.active_layer,
          short_id: "L1",
          seq: 1,
          title: "MCP capture",
          title_source: "human",
          kind: "root",
        },
        assets: [],
        has_uncommitted: true,
        uncommitted,
        captured_at: new Date().toISOString(),
      }),
    });
    expect((await response.json()) as { accepted: boolean }).toEqual({
      accepted: true,
    });

    const captured = await capture;
    expect(captured.based_on_layer).toBe(status.active_layer);
    expect(captured.has_uncommitted).toBe(true);
    expect(captured.uncommitted.strokes.added).toBe(1);
    expect(captured.render.url).toBe(
      `${runtime.url}/render/${captured.snapshot_id}.png`,
    );

    const render = await fetch(captured.render.url);
    expect(render.status).toBe(200);
    expect(render.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await render.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  test("resolves MCP capture scope and isolates live Spaces", async () => {
    const runtime = await startRuntime("mcp-capture-scope");
    const project = await callTool<ProjectCreated>(
      runtime,
      "session-scope",
      "project",
      { action: "create", value: "Scoped Capture" },
    );
    const mainStatus = await callTool<StatusData>(
      runtime,
      "session-scope",
      "status",
    );
    if (mainStatus.active_layer === null) {
      throw new Error("Expected main Space to have an active root Layer");
    }
    const side = await callTool<SpaceChanged>(
      runtime,
      "session-scope",
      "space",
      { action: "create", value: "Side" },
    );
    expect(side.switched).toBe(true);
    const sideStatus = await callTool<StatusData>(
      runtime,
      "session-scope",
      "status",
    );
    if (sideStatus.active_layer === null) {
      throw new Error("Expected side Space to have an active root Layer");
    }

    const mainFrontend = await registerFrontend(
      runtime,
      project.project_id,
      mainStatus.space.id,
    );
    const mainPoll = waitForCaptureRequest(
      runtime,
      mainFrontend.session_id,
      150,
    );
    await Bun.sleep(20);
    const wrongBinding = await callToolFailure(
      runtime,
      "session-scope",
      "capture",
    );
    expect(wrongBinding.error.code).toBe("E_LIVE_UNAVAILABLE");
    expect(await mainPoll).toBeNull();

    const sideFrontend = await registerFrontend(
      runtime,
      project.project_id,
      sideStatus.space.id,
    );
    const targetPoll = waitForCaptureRequest(
      runtime,
      mainFrontend.session_id,
      2000,
    );
    await Bun.sleep(10);
    const otherPoll = waitForCaptureRequest(
      runtime,
      sideFrontend.session_id,
      300,
    );
    await Bun.sleep(20);

    const capture = callTool<CaptureData>(runtime, "session-scope", "capture", {
      project: "Scoped Capture",
      space: mainStatus.space.name,
    });
    const targetRequest = await targetPoll;
    if (targetRequest === null) {
      throw new Error("Expected the target Space frontend to receive capture");
    }
    expect(await otherPoll).toBeNull();

    const response = await fetch(`${runtime.url}/api/frontend/response`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify(
        captureResponsePayload(
          mainFrontend.session_id,
          targetRequest.request_id,
          mainStatus.active_layer,
        ),
      ),
    });
    expect(await response.json()).toEqual({ accepted: true });
    const captured = await capture;
    expect(captured.based_on_layer).toBe(mainStatus.active_layer);

    const targetPollAgain = waitForCaptureRequest(
      runtime,
      mainFrontend.session_id,
      2000,
    );
    await Bun.sleep(20);
    const crossSpaceCapture = rpc(
      runtime,
      toolCall("capture", {
        project: "Scoped Capture",
        space: mainStatus.space.name,
      }),
      { sessionId: "session-scope" },
    );
    const targetRequestAgain = await targetPollAgain;
    if (targetRequestAgain === null) {
      throw new Error("Expected a second target capture request");
    }
    const crossSpaceResponse = await fetch(
      `${runtime.url}/api/frontend/response`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HumanBoard-Client": "1",
        },
        body: JSON.stringify(
          captureResponsePayload(
            mainFrontend.session_id,
            targetRequestAgain.request_id,
            sideStatus.active_layer,
          ),
        ),
      },
    );
    expect(await crossSpaceResponse.json()).toEqual({ accepted: true });
    const crossSpaceResult = await crossSpaceCapture;
    expect(crossSpaceResult.response.status).toBe(200);
    expect(crossSpaceResult.body.result?.isError).toBe(true);
    expect(
      (crossSpaceResult.body.result?.structuredContent as ToolFailureData).error
        .code,
    ).toBe("E_LAYER_NOT_FOUND");
  });

  test("keeps Bearer token scope checks on the mounted /mcp endpoint", async () => {
    const runtime = await startRuntime("mcp-auth", {
      mcpAuth: { token: "secret", scopes: ["read"] },
    });

    const missing = await rpc(runtime, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get("www-authenticate")).toBe("Bearer");

    const listed = await rpc(
      runtime,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { token: "secret" },
    );
    expect(listed.response.status).toBe(200);
    expect(listed.body.result?.tools?.map((tool) => tool.name)).toEqual([
      "status",
      "layers",
      "get",
      "diff",
      "capture",
      "inspect",
      "board_state",
      "board_review",
    ]);

    const write = await rpc(
      runtime,
      toolCall("draft", { patch: { add_strokes: [] } }),
      { token: "secret", sessionId: "session-read-only" },
    );
    expect(write.response.status).toBe(403);
    expect(write.body.error?.code).toBe(-32003);
    expect(
      (write.body.error?.data as { error?: { code?: string } }).error?.code,
    ).toBe("E_AUTH");
  });

  test("closes MCP session pools when the server stops", async () => {
    const runtime = await startRuntime("mcp-cleanup");
    await callTool<ProjectCreated>(runtime, "session-cleanup", "project", {
      action: "create",
      value: "Cleanup",
    });
    expect(runtime.mcpSessions.activeSessionCount()).toBe(1);

    await runtime.running.stop();

    expect(runtime.mcpSessions.activeSessionCount()).toBe(0);
    await runtime.running.stop();
    expect(runtime.mcpSessions.activeSessionCount()).toBe(0);
  });
});

test("MCP returns real PNG image blocks with structured board data", async () => {
  const runtime = await startRuntime("mcp-images");
  await callTool<ProjectCreated>(runtime, "image-session", "project", {
    action: "create",
    value: "Image Project",
  });
  const result = await rpc(runtime, toolCall("get", { format: "both" }), {
    sessionId: "image-session",
  });
  const content = result.body.result!.content as unknown as {
    type: string;
    data?: string;
    mimeType?: string;
  }[];
  const image = content.find((c) => c.type === "image");
  expect(image?.mimeType).toBe("image/png");
  expect(Buffer.from(image!.data!, "base64").subarray(1, 4).toString()).toBe(
    "PNG",
  );
  expect(result.body.result?.structuredContent).toBeDefined();
  const listed = await rpc(runtime, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  expect(listed.body.result!.tools!.some((t) => t.name === "connect")).toBe(
    false,
  );
});
