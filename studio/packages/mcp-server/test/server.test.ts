import { describe, expect, test } from "bun:test";

import {
  createMcpApp,
  type McpCommandRequest,
  type McpCommandResult,
} from "../src/server";

const HOST = "127.0.0.1:4318";
const ORIGIN = "http://127.0.0.1:4318";

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: {
    readonly tools?: readonly { readonly name: string }[];
    readonly serverInfo?: { readonly name: string };
    readonly instructions?: string;
    readonly content?: readonly {
      readonly type: "text";
      readonly text: string;
    }[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

function headers(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Host: HOST,
    Origin: ORIGIN,
    "Content-Type": "application/json",
    "X-HumanBoard-Client": "1",
    ...extra,
  };
}

async function rpc(
  app: ReturnType<typeof createMcpApp>,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return app.request(`http://${HOST}/mcp`, {
    method: "POST",
    headers: headers(extraHeaders),
    body: JSON.stringify(body),
  });
}

function toolCall(
  id: number,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: "tools/call";
  readonly params: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
} {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

describe("MCP server", () => {
  test("rejects non-loopback binding without a token", () => {
    expect(() =>
      createMcpApp({
        host: "0.0.0.0",
        execute: async () => ({ exitCode: 0, data: {} }),
      }),
    ).toThrow("Bearer token");
    expect(() =>
      createMcpApp({
        host: "0.0.0.0",
        auth: { token: "secret", scopes: ["read"] },
        execute: async () => ({ exitCode: 0, data: {} }),
      }),
    ).not.toThrow();
  });

  test("initializes, lists tools, and calls a tool", async () => {
    const calls: McpCommandRequest[] = [];
    const execute = async (
      request: McpCommandRequest,
    ): Promise<McpCommandResult> => {
      calls.push(request);
      return { exitCode: 0, data: { ok: true } };
    };
    const app = createMcpApp({ execute });

    const initialize = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeTruthy();
    const initializeBody = (await initialize.json()) as JsonRpcResponse;
    expect(initializeBody.result?.serverInfo?.name).toBe("humanboard-mcp");
    expect(initializeBody.result?.instructions).toContain("watch");

    const initializeWithSession = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 11,
        method: "initialize",
        params: {},
      },
      { "Mcp-Session-Id": "session-init" },
    );
    expect(initializeWithSession.headers.get("mcp-session-id")).toBe(
      "session-init",
    );

    const list = await rpc(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as JsonRpcResponse;
    const names = listBody.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([
      "status",
      "layers",
      "get",
      "diff",
      "draft",
      "commit",
      "capture",
      "inspect",
      "project",
      "space",
      "board_state",
      "board_fork",
      "board_save",
      "board_review",
      "board_accept",
      "board_revert",
    ]);
    expect(names).not.toContain("watch");

    const call = await rpc(app, toolCall(3, "status"), {
      "Mcp-Session-Id": "session-read",
    });
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as JsonRpcResponse;
    expect(callBody.result?.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionId: "session-read",
      argv: ["status", "--json"],
    });
  });

  test("requires Mcp-Session-Id for draft and commit and forwards it", async () => {
    const calls: McpCommandRequest[] = [];
    const app = createMcpApp({
      execute: async (request) => {
        calls.push(request);
        return { exitCode: 0, data: { accepted: true } };
      },
    });

    const missing = await rpc(
      app,
      toolCall(1, "draft", {
        patch: { add_strokes: [] },
      }),
    );
    const missingBody = (await missing.json()) as JsonRpcResponse;
    expect(missingBody.result?.isError).toBe(true);
    const missingPayload = JSON.parse(
      missingBody.result?.content?.[0]?.text ?? "{}",
    ) as { error?: { code?: string } };
    expect(missingPayload.error?.code).toBe("E_USAGE");
    expect(calls).toHaveLength(0);

    const patch = { add_strokes: [] };
    const draft = await rpc(
      app,
      toolCall(2, "draft", { parent: "L1", patch }),
      { "Mcp-Session-Id": "session-write" },
    );
    expect(draft.status).toBe(200);
    expect(calls[0]).toEqual({
      sessionId: "session-write",
      argv: ["draft", "--parent", "L1", "--merge", "-", "--json"],
      stdin: JSON.stringify(patch),
    });

    const commit = await rpc(
      app,
      toolCall(3, "commit", { message: "mcp title" }),
      { "Mcp-Session-Id": "session-write" },
    );
    expect(commit.status).toBe(200);
    expect(calls[1]).toEqual({
      sessionId: "session-write",
      argv: ["commit", "-m", "mcp title", "--json"],
    });
  });

  test("enforces Bearer token scopes", async () => {
    const app = createMcpApp({
      auth: { token: "secret", scopes: ["read"] },
      execute: async () => ({ exitCode: 0, data: { ok: true } }),
    });

    const missingAuth = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(missingAuth.status).toBe(401);
    expect(missingAuth.headers.get("www-authenticate")).toBe("Bearer");

    const list = await rpc(
      app,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { Authorization: "Bearer secret" },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as JsonRpcResponse;
    const names = listBody.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([
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
      app,
      toolCall(3, "draft", { patch: { add_strokes: [] } }),
      {
        Authorization: "Bearer secret",
        "Mcp-Session-Id": "session-write",
      },
    );
    expect(write.status).toBe(403);
    const writeBody = (await write.json()) as JsonRpcResponse;
    expect(writeBody.error?.code).toBe(-32003);
    expect(
      (writeBody.error?.data as { error?: { code?: string } }).error?.code,
    ).toBe("E_AUTH");
  });

  test("returns tool errors as structured JSON", async () => {
    const app = createMcpApp({
      execute: async () => ({
        exitCode: 4,
        error: {
          code: "E_NO_DRAFT",
          message: "No draft exists",
          details: { session_id: "session-write" },
        },
      }),
    });

    const response = await rpc(app, toolCall(1, "commit"), {
      "Mcp-Session-Id": "session-write",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonRpcResponse;
    expect(body.result?.isError).toBe(true);
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as {
      exitCode?: number;
      error?: { code?: string; message?: string };
    };
    expect(payload.exitCode).toBe(4);
    expect(payload.error?.code).toBe("E_NO_DRAFT");
    expect(payload.error?.message).toBe("No draft exists");
  });

  test("enforces HTTP headers, Host/Origin, and JSON parse errors", async () => {
    const app = createMcpApp({
      execute: async () => ({ exitCode: 0, data: {} }),
    });

    const missingClientHeader = await app.request(`http://${HOST}/mcp`, {
      method: "POST",
      headers: {
        Host: HOST,
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(missingClientHeader.status).toBe(403);

    const badHost = await app.request("http://evil.example:4318/mcp", {
      method: "POST",
      headers: headers({ Host: "evil.example:4318" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await app.request(`http://${HOST}/mcp`, {
      method: "POST",
      headers: headers({ Origin: "http://evil.example" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(badOrigin.status).toBe(403);

    const badJson = await app.request(`http://${HOST}/mcp`, {
      method: "POST",
      headers: headers(),
      body: "{",
    });
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as JsonRpcResponse;
    expect(badJsonBody.error?.code).toBe(-32700);

    const badContentType = await app.request(`http://${HOST}/mcp`, {
      method: "POST",
      headers: headers({ "Content-Type": "text/plain" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    expect(badContentType.status).toBe(400);
  });
});
