import { randomUUID } from "node:crypto";

import { Hono } from "hono";

import {
  MCP_TOOLS,
  buildToolInvocation,
  McpToolArgumentError,
  requiresSession,
  scopeForTool,
  type McpScope,
} from "./mcp-tools";

export interface McpCommandRequest {
  readonly sessionId: string;
  readonly argv: readonly string[];
  readonly stdin?: string;
}

export interface McpCommandError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface McpCommandResult {
  readonly images?: readonly {
    readonly data: string;
    readonly mimeType: "image/png";
  }[];
  readonly exitCode: number;
  readonly data?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: McpCommandError;
}

export type McpExecutor = (
  request: McpCommandRequest,
) => Promise<McpCommandResult>;

export interface McpAuthConfig {
  readonly token: string;
  readonly scopes: readonly McpScope[];
}

export interface McpAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly execute: McpExecutor;
  readonly enabledTools?: ReadonlySet<string>;
  readonly auth?: McpAuthConfig;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly bodyLimitBytes?: number;
  readonly protocolVersion?: string;
}

export interface RunningMcpServer {
  readonly app: Hono;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  stop(): Promise<void>;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const DEFAULT_PORT = 4318;
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);
const ANONYMOUS_SESSION = "mcp-anonymous";

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function allowedHosts(
  host: string,
  port: number,
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  if (configured !== undefined && configured.length > 0) {
    return new Set(configured.map((value) => value.toLowerCase()));
  }
  if (isLoopbackHost(host)) {
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  }
  return new Set([`${host}:${port}`.toLowerCase()]);
}

function allowedOrigins(
  host: string,
  port: number,
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  if (configured !== undefined) {
    return new Set(configured.map((value) => value.toLowerCase()));
  }
  if (isLoopbackHost(host)) {
    return new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]);
  }
  return new Set();
}

function errorPayload(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): { readonly exitCode: number; readonly error: McpCommandError } {
  const exitCode =
    code === "E_USAGE"
      ? 2
      : code === "E_AUTH"
        ? 5
        : code === "E_NOT_FOUND"
          ? 3
          : code === "E_LIVE_UNAVAILABLE"
            ? 6
            : 1;
  return {
    exitCode,
    error: { code, message, details },
  };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: JsonRpcError;
} {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function jsonRpcResult(
  id: string | number | null,
  result: unknown,
): {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: unknown;
} {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(result: McpCommandResult): {
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: "image/png";
      }
  )[];
  readonly structuredContent: unknown;
  readonly isError: boolean;
} {
  const isError = result.exitCode !== 0 || result.error !== undefined;
  const payload = isError
    ? {
        exitCode: result.exitCode,
        error:
          result.error ??
          errorPayload("E_INTERNAL", "Tool execution failed").error,
        ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
      }
    : (result.data ?? null);
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      ...(!isError
        ? (result.images ?? []).map((i) => ({ type: "image" as const, ...i }))
        : []),
    ],
    structuredContent:
      payload !== null && typeof payload === "object"
        ? payload
        : { result: payload },
    isError,
  };
}

function toolError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof toolResult> {
  return toolResult(errorPayload(code, message, details));
}

function readSessionId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new McpToolArgumentError(
      "Mcp-Session-Id must be 1-128 safe ASCII characters",
    );
  }
  return value;
}

function readBearerToken(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function parseRequest(value: unknown): JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON-RPC request must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.jsonrpc !== "2.0" ||
    typeof record.method !== "string" ||
    record.method.length === 0
  ) {
    throw new Error("Invalid JSON-RPC 2.0 request");
  }
  if (
    record.id !== undefined &&
    record.id !== null &&
    typeof record.id !== "string" &&
    typeof record.id !== "number"
  ) {
    throw new Error("JSON-RPC id must be a string, number, or null");
  }
  return record as unknown as JsonRpcRequest;
}

function hasRequestId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

function requestId(request: JsonRpcRequest): string | number | null {
  return request.id ?? null;
}

function scopeAllowed(
  auth: McpAuthConfig | undefined,
  scope: McpScope,
): boolean {
  return auth === undefined || auth.scopes.includes(scope);
}

function filteredTools(
  auth: McpAuthConfig | undefined,
  enabled?: ReadonlySet<string>,
): readonly unknown[] {
  return MCP_TOOLS.filter((tool) => {
    const scope = scopeForTool(tool.name);
    return (
      (!enabled || enabled.has(tool.name)) &&
      scope !== null &&
      scopeAllowed(auth, scope)
    );
  });
}

function initializeResult(
  protocolVersion: string | undefined,
  fallbackVersion: string | undefined,
): unknown {
  const fallback =
    fallbackVersion !== undefined &&
    SUPPORTED_PROTOCOL_VERSIONS.has(fallbackVersion)
      ? fallbackVersion
      : DEFAULT_PROTOCOL_VERSION;
  const selected =
    protocolVersion !== undefined &&
    SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)
      ? protocolVersion
      : fallback;
  return {
    protocolVersion: selected,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: "humanboard-mcp",
      version: "0.1.0",
    },
    instructions:
      "HumanBoard MCP tools always return JSON. Use Mcp-Session-Id for draft and commit. `watch` is intentionally not exposed as a tool because it is a long-running NDJSON stream; use the CLI command `human watch` instead.",
  };
}

export function createMcpApp(options: McpAppOptions): Hono {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  const basePath = options.basePath ?? "/mcp";
  if (basePath.length === 0 || !basePath.startsWith("/")) {
    throw new Error("MCP basePath must start with /");
  }
  if (!isLoopbackHost(host) && options.auth === undefined) {
    throw new Error(
      "A Bearer token is required when the MCP server binds to a non-loopback host",
    );
  }
  const hosts = allowedHosts(host, port, options.allowedHosts);
  const origins = allowedOrigins(host, port, options.allowedOrigins);
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const app = new Hono();

  app.use("*", async (context, next) => {
    const requestHost = context.req.header("host")?.trim().toLowerCase();
    if (!requestHost || !hosts.has(requestHost)) {
      return context.json(
        jsonRpcError(
          null,
          -32001,
          "Host is not allowed",
          errorPayload("E_AUTH", "Host is not allowed", {
            host: requestHost ?? null,
          }),
        ),
        403,
      );
    }
    const origin = context.req.header("origin");
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return context.json(
        jsonRpcError(
          null,
          -32001,
          "Origin is not allowed",
          errorPayload("E_AUTH", "Origin is not allowed", { origin }),
        ),
        403,
      );
    }
    if (context.req.method !== "GET") {
      if (context.req.header("x-humanboard-client") !== "1") {
        return context.json(
          jsonRpcError(
            null,
            -32001,
            "X-HumanBoard-Client: 1 is required",
            errorPayload("E_AUTH", "X-HumanBoard-Client: 1 is required", {
              header: "X-HumanBoard-Client",
            }),
          ),
          403,
        );
      }
      if (!isJsonContentType(context.req.header("content-type"))) {
        return context.json(
          jsonRpcError(
            null,
            -32600,
            "Content-Type must be application/json",
            errorPayload("E_USAGE", "Content-Type must be application/json", {
              content_type: context.req.header("content-type") ?? null,
            }),
          ),
          400,
        );
      }
    }
    await next();
  });

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "humanboard-mcp",
      host,
      port,
    }),
  );

  app.get(basePath, (context) => {
    context.header("Allow", "POST");
    return context.json(
      jsonRpcError(
        null,
        -32600,
        "MCP Streamable HTTP endpoint accepts POST JSON-RPC requests",
      ),
      405,
    );
  });

  app.post(basePath, async (context) => {
    const auth = options.auth;
    if (auth !== undefined) {
      const token = readBearerToken(context.req.header("authorization"));
      if (token === null || token !== auth.token) {
        context.header("WWW-Authenticate", "Bearer");
        return context.json(
          jsonRpcError(
            null,
            -32001,
            "Authentication required",
            errorPayload("E_AUTH", "Authentication required"),
          ),
          401,
        );
      }
    }

    let sessionId: string | undefined;
    try {
      sessionId = readSessionId(context.req.header("mcp-session-id"));
    } catch (error) {
      return context.json(
        jsonRpcError(
          null,
          -32602,
          error instanceof Error ? error.message : String(error),
          errorPayload(
            "E_USAGE",
            error instanceof Error ? error.message : String(error),
          ),
        ),
        400,
      );
    }

    const declaredLength = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      return context.json(
        jsonRpcError(
          null,
          -32600,
          "Request body is too large",
          errorPayload("E_USAGE", "Request body is too large", {
            max_bytes: bodyLimit,
            size: declaredLength,
          }),
        ),
        413,
      );
    }

    const bodyBytes = await context.req.arrayBuffer();
    if (bodyBytes.byteLength > bodyLimit) {
      return context.json(
        jsonRpcError(
          null,
          -32600,
          "Request body is too large",
          errorPayload("E_USAGE", "Request body is too large", {
            max_bytes: bodyLimit,
            size: bodyBytes.byteLength,
          }),
        ),
        413,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch (error) {
      return context.json(
        jsonRpcError(
          null,
          -32700,
          "Parse error",
          errorPayload("E_USAGE", "Request body must be valid JSON", {
            cause: error instanceof Error ? error.message : String(error),
          }),
        ),
        400,
      );
    }

    let request: JsonRpcRequest;
    try {
      request = parseRequest(payload);
    } catch (error) {
      return context.json(
        jsonRpcError(
          null,
          -32600,
          "Invalid Request",
          errorPayload(
            "E_USAGE",
            error instanceof Error ? error.message : String(error),
          ),
        ),
        400,
      );
    }

    if (!hasRequestId(request)) {
      return context.body(null, 202);
    }

    const id = requestId(request);
    if (request.method === "ping") {
      return context.json(jsonRpcResult(id, {}));
    }

    if (request.method === "initialize") {
      const params =
        request.params !== null &&
        typeof request.params === "object" &&
        !Array.isArray(request.params)
          ? (request.params as Record<string, unknown>)
          : {};
      const assignedSession = sessionId ?? randomUUID();
      context.header("Mcp-Session-Id", assignedSession);
      return context.json(
        jsonRpcResult(
          id,
          initializeResult(
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : undefined,
            options.protocolVersion,
          ),
        ),
      );
    }

    if (request.method === "tools/list") {
      return context.json(
        jsonRpcResult(id, {
          tools: filteredTools(auth, options.enabledTools),
          _meta: {
            "humanboard/unsupportedTools": [
              {
                name: "watch",
                reason:
                  "watch is a long-running NDJSON stream and is intentionally not exposed as an MCP tool",
              },
            ],
          },
        }),
      );
    }

    if (request.method !== "tools/call") {
      return context.json(
        jsonRpcError(
          id,
          -32601,
          "Method not found",
          errorPayload("E_USAGE", "Method not found", {
            method: request.method,
          }),
        ),
        404,
      );
    }

    if (
      request.params === null ||
      typeof request.params !== "object" ||
      Array.isArray(request.params)
    ) {
      return context.json(
        jsonRpcError(
          id,
          -32602,
          "Invalid params",
          errorPayload("E_USAGE", "tools/call params must be an object"),
        ),
        400,
      );
    }
    const params = request.params as Record<string, unknown>;
    if (typeof params.name !== "string" || params.name.length === 0) {
      return context.json(
        jsonRpcError(
          id,
          -32602,
          "Invalid params",
          errorPayload("E_USAGE", "tools/call requires a tool name"),
        ),
        400,
      );
    }
    const toolName = params.name;
    const scope = scopeForTool(toolName);
    if (
      scope === null ||
      (options.enabledTools && !options.enabledTools.has(toolName))
    ) {
      return context.json(
        jsonRpcError(
          id,
          -32602,
          "Unknown tool",
          errorPayload("E_USAGE", `Unknown tool: ${toolName}`, {
            tool: toolName,
          }),
        ),
        400,
      );
    }
    if (!scopeAllowed(auth, scope)) {
      return context.json(
        jsonRpcError(
          id,
          -32003,
          "Insufficient scope",
          errorPayload("E_AUTH", "Insufficient scope", {
            tool: toolName,
            required_scope: scope,
          }),
        ),
        403,
      );
    }
    if (requiresSession(toolName) && sessionId === undefined) {
      return context.json(
        jsonRpcResult(
          id,
          toolError("E_USAGE", `Mcp-Session-Id is required for ${toolName}`, {
            tool: toolName,
          }),
        ),
      );
    }

    let invocation;
    try {
      invocation = buildToolInvocation(
        toolName,
        params.arguments === undefined ? {} : params.arguments,
      );
    } catch (error) {
      return context.json(
        jsonRpcResult(
          id,
          toolError(
            "E_USAGE",
            error instanceof Error ? error.message : String(error),
            { tool: toolName },
          ),
        ),
      );
    }

    try {
      const result = await options.execute({
        sessionId: sessionId ?? ANONYMOUS_SESSION,
        argv: invocation.argv,
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      });
      return context.json(jsonRpcResult(id, toolResult(result)));
    } catch (error) {
      return context.json(
        jsonRpcResult(
          id,
          toolError(
            "E_INTERNAL",
            error instanceof Error ? error.message : String(error),
            { tool: toolName },
          ),
        ),
      );
    }
  });

  app.notFound((context) =>
    context.json(
      jsonRpcError(
        null,
        -32601,
        "Route not found",
        errorPayload("E_NOT_FOUND", "Route not found", {
          path: new URL(context.req.url).pathname,
        }),
      ),
      404,
    ),
  );

  app.onError((error, context) =>
    context.json(
      jsonRpcError(
        null,
        -32603,
        "Internal error",
        errorPayload("E_INTERNAL", error.message),
      ),
      500,
    ),
  );

  return app;
}

export function startMcpServer(options: McpAppOptions): RunningMcpServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;
  if (!isLoopbackHost(host) && options.auth === undefined) {
    throw new Error(
      "A Bearer token is required when the MCP server binds to a non-loopback host",
    );
  }
  const app = createMcpApp({ ...options, host, port });
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: app.fetch,
  });
  return {
    app,
    server,
    url: `http://${host}:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}
