import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  HumanBoardError,
  MAX_ASSET_FILE_BYTES,
  type SyncRefs,
} from "@humanboard/core-engine";
import { SceneSchema } from "@humanboard/schema";
import { Hono, type Context } from "hono";

import {
  FrontendSessionHub,
  type FrontendCapturePayload,
} from "./frontend-session-hub";

export * from "./frontend-session-hub";

export interface CommitEventLike {
  readonly event: "layer_committed";
  readonly layer_id: string;
  readonly project_id: string;
  readonly space_id: string;
  readonly seq: number;
  readonly short_id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly title_source: string;
  readonly author: {
    readonly kind: string;
    readonly name?: string;
  };
  readonly diff: unknown;
}

export interface CommitEventSource {
  subscribe(
    listener: (event: CommitEventLike) => void,
    subscription?: {
      readonly sinceSeq?: number;
      readonly all?: boolean;
      readonly projectId?: string;
      readonly spaceId?: string;
    },
  ): () => void;
}

export interface WatchScopeQuery {
  readonly project?: string;
  readonly space?: string;
  readonly since?: string;
}

export interface WatchScope {
  readonly project_id: string;
  readonly space_id: string;
  readonly since_seq?: number;
}

export interface CommandExecutionRequest {
  readonly fileBlobs?: Readonly<Record<string, string>>;
  readonly sessionId?: string;
  readonly cliSessionId?: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
}

export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CommandExecutionResult {
  readonly exitCode: number;
  readonly data?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: CommandError;
}

export type CommandExecutor = (
  request: CommandExecutionRequest,
) => Promise<CommandExecutionResult>;

export interface SyncRouteService {
  negotiate(
    projectId: string,
    spaceId: string,
    have: readonly string[],
    refs: SyncRefs,
  ): Promise<unknown>;
  pullLayer(
    projectId: string,
    spaceId: string,
    layerId: string,
  ): Promise<unknown>;
  applyPush(
    projectId: string,
    spaceId: string,
    payload: unknown,
  ): Promise<unknown>;
  readBlob(hash: string): Promise<Uint8Array>;
}

export interface AgentRouteService {
  setModels?(body: unknown): Promise<unknown>;
  setAutoTitle?(enabled: boolean): Promise<unknown>;
  status?(input: {
    readonly project_id: string;
    readonly space_id: string;
  }): Promise<unknown> | unknown;
  cancel?(input: {
    readonly project_id: string;
    readonly space_id: string;
  }): Promise<unknown> | unknown;
  config(): Promise<unknown> | unknown;
  history(input: {
    readonly project_id: string;
    readonly space_id: string;
  }): Promise<unknown>;
  chat(input: {
    readonly project_id: string;
    readonly space_id: string;
    readonly message: string;
    readonly base_layer_id?: string;
  }): Promise<unknown>;
}

export interface ServerAppOptions {
  readonly instanceId?: string;
  readonly authToken?: string;
  readonly publicUrl?: string;
  readonly allowedHosts?: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly cacheDir: string;
  readonly execute: CommandExecutor;
  readonly events: CommitEventSource;
  readonly resolveWatch?: (query: WatchScopeQuery) => Promise<WatchScope>;
  readonly watchHistory?: (
    scope: WatchScope,
  ) => Promise<readonly CommitEventLike[]>;
  readonly bodyLimitBytes?: number;
  readonly frontendHub?: FrontendSessionHub;
  readonly staticDir?: string;
  readonly staticAssets?: Readonly<Record<string, string>>;
  readonly setActiveLayer?: (input: {
    readonly space_id: string;
    readonly layer_id: string;
  }) => Promise<{
    readonly space_id: string;
    readonly active_layer_id: string;
  }>;
  readonly deleteLayer?: (input: {
    readonly space_id: string;
    readonly layer_id: string;
  }) => Promise<{
    readonly deleted: readonly string[];
    readonly active_layer_id: string | null;
  }>;
  readonly sync?: SyncRouteService;
  readonly syncBodyLimitBytes?: number;
  readonly agent?: AgentRouteService;
  readonly projectSync?: {
    get(projectId: string): Promise<unknown>;
    set(projectId: string, enabled: boolean): Promise<unknown>;
  };
  readonly assets?: {
    upload?(hash: string, data: Uint8Array): Promise<unknown>;
    get?(id: string): Promise<unknown>;
    rename?(id: string, title: string): Promise<unknown>;
    register(input: {
      project_id: string;
      space_id: string;
      name?: string;
      data_base64?: string;
      url?: string;
    }): Promise<unknown>;
    image(id: string): Promise<{
      data: Uint8Array;
      mime: string;
      width: number;
      height: number;
    }>;
  };
  readonly mcpApp?: Hono;
}

export interface RunningServer {
  readonly app: Hono;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  stop(): Promise<void>;
}

interface ErrorPayload {
  readonly error: CommandError;
  readonly exitCode: number;
}

const DEFAULT_BODY_LIMIT = 1024 * 1024;

function normalizeError(error: unknown): ErrorPayload {
  if (error instanceof HumanBoardError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      exitCode: error.exitCode,
    };
  }
  return {
    error: {
      code: "E_INTERNAL",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
    exitCode: 1,
  };
}

function errorResponse(error: unknown, status: number): Response {
  return Response.json(normalizeError(error), { status });
}

function apiError(
  code:
    | "E_USAGE"
    | "E_AUTH"
    | "E_NOT_FOUND"
    | "E_ASSET_NOT_FOUND"
    | "E_INTERNAL",
  message: string,
  details: Readonly<Record<string, unknown>>,
  status: number,
): Response {
  const exitCode =
    code === "E_USAGE"
      ? 2
      : code === "E_AUTH"
        ? 5
        : code === "E_NOT_FOUND" || code === "E_ASSET_NOT_FOUND"
          ? 3
          : 1;
  return Response.json(
    {
      error: { code, message, details },
      exitCode,
    },
    { status },
  );
}

function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

function requireClientPostHeaders(context: Context): Response | null {
  if (context.req.header("x-humanboard-client") !== "1") {
    return apiError(
      "E_AUTH",
      "X-HumanBoard-Client: 1 is required",
      { header: "X-HumanBoard-Client" },
      403,
    );
  }
  if (!isJsonContentType(context.req.header("content-type"))) {
    return apiError(
      "E_USAGE",
      "Content-Type must be application/json",
      { content_type: context.req.header("content-type") ?? null },
      400,
    );
  }
  return null;
}

async function readLimitedJson(
  context: Context,
  limit: number,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response }
> {
  const declaredLength = Number(context.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return {
      ok: false,
      response: apiError(
        "E_USAGE",
        "Request body is too large",
        { max_bytes: limit, size: declaredLength },
        413,
      ),
    };
  }
  const bytes = await context.req.arrayBuffer();
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      response: apiError(
        "E_USAGE",
        "Request body is too large",
        { max_bytes: limit, size: bytes.byteLength },
        413,
      ),
    };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder().decode(bytes)),
    };
  } catch (error) {
    return {
      ok: false,
      response: apiError(
        "E_USAGE",
        "Request body must be valid JSON",
        { cause: error instanceof Error ? error.message : String(error) },
        400,
      ),
    };
  }
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0") {
    return false;
  }
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new HumanBoardError("E_USAGE", "all must be a boolean", { all: value });
}

function parseTimeout(value: string | undefined): number {
  const timeout = value === undefined ? 300 : Number(value);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new HumanBoardError(
      "E_USAGE",
      "timeout must be a non-negative number of seconds",
      { timeout: value },
    );
  }
  return timeout;
}

function parseFrontendTimeout(value: string | undefined): number {
  const timeout = value === undefined ? 25_000 : Number(value);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new HumanBoardError(
      "E_USAGE",
      "timeout must be a non-negative number of milliseconds",
      { timeout: value },
    );
  }
  return timeout;
}

function renderPath(cacheDir: string, requestPath: string): string {
  const root = resolve(cacheDir, "renders");
  const prefix = "/render/";
  if (!requestPath.startsWith(prefix)) {
    throw new HumanBoardError("E_USAGE", "Invalid render path");
  }
  let relative: string;
  try {
    relative = decodeURIComponent(requestPath.slice(prefix.length));
  } catch {
    throw new HumanBoardError("E_USAGE", "Invalid render path encoding");
  }
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "..")
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Render path traversal is not allowed",
    );
  }
  if (extname(relative).toLowerCase() !== ".png") {
    throw new HumanBoardError("E_USAGE", "Only PNG render files are served");
  }
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new HumanBoardError(
      "E_USAGE",
      "Render path traversal is not allowed",
    );
  }
  return target;
}

function inspectPath(cacheDir: string, requestPath: string): string {
  const root = resolve(cacheDir, "inspect");
  const prefix = "/inspect/";
  if (!requestPath.startsWith(prefix)) {
    throw new HumanBoardError("E_USAGE", "Invalid inspect path");
  }
  let relative: string;
  try {
    relative = decodeURIComponent(requestPath.slice(prefix.length));
  } catch {
    throw new HumanBoardError("E_USAGE", "Invalid inspect path encoding");
  }
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "..") ||
    extname(relative).toLowerCase() !== ".png"
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Inspect path traversal is not allowed",
    );
  }
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new HumanBoardError(
      "E_USAGE",
      "Inspect path traversal is not allowed",
    );
  }
  return target;
}

function staticPath(staticDir: string, requestPath: string): string {
  const root = resolve(staticDir);
  let relative: string;
  try {
    relative =
      requestPath === "/"
        ? "index.html"
        : decodeURIComponent(requestPath.replace(/^\/+/, ""));
  } catch {
    throw new HumanBoardError("E_USAGE", "Invalid static path encoding");
  }
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "..")
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Static path traversal is not allowed",
    );
  }
  const target = resolve(root, relative);
  if (
    target !== root &&
    !target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Static path traversal is not allowed",
    );
  }
  return target;
}

function staticContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".json":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function serveStatic(
  staticDir: string | undefined,
  requestPath: string,
  embedded?: Readonly<Record<string, string>>,
): Promise<Response> {
  if (embedded) {
    try {
      staticPath("/", requestPath);
      const key = "/" + decodeURIComponent(requestPath).replace(/^\/+/, "");
      const path = Object.hasOwn(embedded, key) ? embedded[key] : undefined;
      if (!path)
        return apiError("E_NOT_FOUND", "Static asset does not exist", {}, 404);
      return new Response(await Bun.file(path).arrayBuffer(), {
        headers: {
          "Content-Type": staticContentType(key === "/" ? "index.html" : key),
          "Cache-Control":
            requestPath === "/"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      return errorResponse(error, 400);
    }
  }
  if (!staticDir) {
    if (requestPath !== "/") {
      return apiError("E_NOT_FOUND", "Static asset does not exist", {}, 404);
    }
    return new Response(
      "<h1>HumanBoard UI is not built</h1><p>Run <code>bun run --filter @humanboard/canvas-ui build</code>.</p>",
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
  let path: string;
  try {
    path = staticPath(staticDir, requestPath);
  } catch (error) {
    return errorResponse(error, 400);
  }
  try {
    const data = await readFile(path);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": staticContentType(path),
        "Cache-Control":
          requestPath === "/"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      if (requestPath !== "/") {
        return apiError("E_NOT_FOUND", "Static asset does not exist", {}, 404);
      }
      return new Response(
        "<h1>HumanBoard UI is not built</h1><p>Run <code>bun run --filter @humanboard/canvas-ui build</code>.</p>",
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }
    return errorResponse(error, 500);
  }
}

export function createServerApp(options: ServerAppOptions): Hono {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const remote = !["127.0.0.1", "localhost", "::1"].includes(host);
  if (
    remote &&
    (!options.authToken ||
      !options.publicUrl ||
      new URL(options.publicUrl).protocol !== "https:")
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Non-loopback serving requires HUMAN_AUTH_TOKEN and an HTTPS HUMAN_PUBLIC_URL",
    );
  }
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : null;
  const allowedHosts = new Set(
    (options.allowedHosts?.length
      ? options.allowedHosts
      : [
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          `${host.includes(":") ? `[${host}]` : host}:${port}`,
          ...(publicUrl ? [publicUrl.host] : []),
        ]
    ).map((v) => v.toLowerCase()),
  );
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const tokenMatches = (value: string) =>
    !!options.authToken &&
    timingSafeEqual(digest(value), digest(options.authToken));
  const cookieValue = options.authToken
    ? digest(options.authToken).toString("hex")
    : "";
  let authFailures = 0,
    failureWindow = Date.now();
  const origins = new Set(allowedOrigins(port));
  if (publicUrl) origins.add(publicUrl.origin.toLowerCase());
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const syncBodyLimit = options.syncBodyLimitBytes ?? 50 * 1024 * 1024;
  const app = new Hono();

  app.use("*", async (context, next) => {
    const requestHost = context.req.header("host")?.trim().toLowerCase();
    if (!requestHost || !allowedHosts.has(requestHost)) {
      return apiError(
        "E_AUTH",
        "Host is not allowed",
        { host: requestHost ?? null },
        403,
      );
    }
    const origin = context.req.header("origin");
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return apiError("E_AUTH", "Origin is not allowed", { origin }, 403);
    }
    const path = context.req.path;
    if (
      options.authToken &&
      path !== "/" &&
      !path.startsWith("/assets/") &&
      path !== "/favicon.ico" &&
      path !== "/api/auth"
    ) {
      const bearer =
        context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const cookie =
        context.req
          .header("cookie")
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("hb_session="))
          ?.slice(11) ?? "";
      const cookieMatches =
        /^[a-f0-9]{64}$/.test(cookie) &&
        timingSafeEqual(Buffer.from(cookie), Buffer.from(cookieValue));
      if (!tokenMatches(bearer) && !cookieMatches)
        return apiError("E_AUTH", "Authentication required", {}, 401);
    }
    await next();
  });

  app.post("/api/auth", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    if (Date.now() - failureWindow > 60_000) {
      authFailures = 0;
      failureWindow = Date.now();
    }
    if (authFailures >= 20)
      return apiError(
        "E_AUTH",
        "Too many login attempts; try again in one minute",
        {},
        429,
      );
    const parsed = await readLimitedJson(context, 4096);
    if (!parsed.ok) return parsed.response;
    const token = (parsed.value as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !tokenMatches(token)) {
      authFailures++;
      return apiError("E_AUTH", "Invalid access token", {}, 401);
    }
    authFailures = 0;
    context.header(
      "Set-Cookie",
      `hb_session=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${publicUrl?.protocol === "https:" ? "; Secure" : ""}`,
    );
    return context.json({ ok: true });
  });

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "humanboard",
      ...(options.instanceId ? { instance_id: options.instanceId } : {}),
      host,
      port,
    }),
  );

  if (options.mcpApp) {
    app.route("/mcp", options.mcpApp);
  }

  app.get("/api/agent/config", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!options.agent) {
      return apiError("E_USAGE", "Agent service is not configured", {}, 503);
    }
    try {
      return context.json(await options.agent.config());
    } catch (error) {
      return errorResponse(error, 500);
    }
  });

  app.get("/api/agent/history", async (context) => {
    if (!options.agent) {
      return apiError("E_USAGE", "Agent service is not configured", {}, 503);
    }
    const projectId = context.req.query("project_id");
    const spaceId = context.req.query("space_id");
    if (
      projectId === undefined ||
      projectId.length === 0 ||
      spaceId === undefined ||
      spaceId.length === 0
    ) {
      return apiError(
        "E_USAGE",
        "Agent history requires project_id and space_id",
        {},
        400,
      );
    }
    try {
      return context.json(
        await options.agent.history({
          project_id: projectId,
          space_id: spaceId,
        }),
      );
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.put("/api/uploads/:hash", async (context) => {
    if (context.req.header("x-humanboard-client") !== "1")
      return apiError("E_AUTH", "X-HumanBoard-Client: 1 is required", {}, 403);
    if (
      context.req.header("content-type")?.split(";")[0]?.trim() !==
      "application/octet-stream"
    )
      return apiError("E_USAGE", "Binary upload required", {}, 400);
    const hash = context.req.param("hash");
    if (!/^sha256:[a-f0-9]{64}$/.test(hash))
      return apiError("E_USAGE", "Invalid upload hash", {}, 400);
    if (!options.assets?.upload)
      return apiError("E_USAGE", "File upload unavailable", {}, 503);
    const declared = Number(context.req.header("content-length") ?? "0");
    if (declared > MAX_ASSET_FILE_BYTES)
      return apiError("E_USAGE", "Image exceeds the 20 MB limit", {}, 413);
    const reader = context.req.raw.body?.getReader();
    if (!reader) return apiError("E_USAGE", "Upload body required", {}, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_ASSET_FILE_BYTES) {
          await reader.cancel();
          return apiError("E_USAGE", "Image exceeds the 20 MB limit", {}, 413);
        }
        chunks.push(chunk.value);
      }
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      context.header("Cache-Control", "no-store");
      return context.json(await options.assets.upload(hash, data));
    } catch (error) {
      return errorResponse(error, 400);
    } finally {
      reader.releaseLock();
    }
  });

  app.post("/api/assets", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    if (!options.assets)
      return apiError("E_USAGE", "Asset service unavailable", {}, 503);
    const parsed = await readLimitedJson(context, 29 * 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    const v = parsed.value as Record<string, unknown> | null;
    if (
      !v ||
      typeof v.project_id !== "string" ||
      typeof v.space_id !== "string" ||
      (typeof v.data_base64 !== "string" && typeof v.url !== "string") ||
      (v.data_base64 !== undefined && v.url !== undefined)
    )
      return apiError(
        "E_USAGE",
        "Provide project_id, space_id and either image data or URL",
        {},
        400,
      );
    try {
      return context.json(
        await options.assets.register({
          project_id: v.project_id,
          space_id: v.space_id,
          ...(typeof v.name === "string" ? { name: v.name } : {}),
          ...(typeof v.data_base64 === "string"
            ? { data_base64: v.data_base64 }
            : {}),
          ...(typeof v.url === "string" ? { url: v.url } : {}),
        }),
      );
    } catch (e) {
      return errorResponse(e, 400);
    }
  });
  app.get("/api/assets/:id", async (context) => {
    if (!options.assets?.get)
      return apiError("E_USAGE", "Asset service unavailable", {}, 503);
    const asset = await options.assets.get(context.req.param("id"));
    return asset
      ? context.json(asset)
      : apiError("E_ASSET_NOT_FOUND", "Asset not found", {}, 404);
  });
  app.post("/api/assets/:id/title", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    if (!options.assets?.rename)
      return apiError("E_USAGE", "Asset service unavailable", {}, 503);
    const parsed = await readLimitedJson(context, 2048);
    if (!parsed.ok) return parsed.response;
    const title = (parsed.value as { title?: unknown } | null)?.title;
    if (typeof title !== "string")
      return apiError("E_USAGE", "Title is required", {}, 400);
    try {
      return context.json(
        await options.assets.rename(context.req.param("id"), title),
      );
    } catch (e) {
      return errorResponse(e, 400);
    }
  });
  app.get("/api/assets/:id/image", async (context) => {
    if (!options.assets)
      return apiError("E_USAGE", "Asset service unavailable", {}, 503);
    try {
      const image = await options.assets.image(context.req.param("id"));
      return new Response(new Uint8Array(image.data), {
        headers: {
          "Content-Type": image.mime,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      return errorResponse(e, 404);
    }
  });

  app.get("/api/sync/settings", async (context) => {
    const projectId = context.req.query("project_id");
    if (!projectId || !options.projectSync)
      return apiError("E_USAGE", "Project required", {}, 400);
    try {
      return context.json(await options.projectSync.get(projectId));
    } catch (e) {
      return errorResponse(e, 400);
    }
  });
  app.post("/api/sync/settings", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as {
      project_id?: unknown;
      cloud_sync?: unknown;
    } | null;
    if (
      !options.projectSync ||
      typeof body?.project_id !== "string" ||
      typeof body.cloud_sync !== "boolean"
    )
      return apiError(
        "E_USAGE",
        "Project and cloud_sync boolean required",
        {},
        400,
      );
    try {
      return context.json(
        await options.projectSync.set(body.project_id, body.cloud_sync),
      );
    } catch (e) {
      return errorResponse(e, 400);
    }
  });

  app.post("/api/agent/models", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) return parsed.response;
    if (!options.agent?.setModels)
      return apiError("E_USAGE", "Model settings unavailable", {}, 503);
    try {
      context.header("Cache-Control", "no-store");
      return context.json(await options.agent.setModels(parsed.value));
    } catch (error) {
      return errorResponse(error, 400);
    }
  });

  app.post("/api/agent/settings", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as { auto_title?: unknown } | null;
    if (!options.agent?.setAutoTitle || typeof body?.auto_title !== "boolean")
      return apiError("E_USAGE", "auto_title boolean required", {}, 400);
    try {
      return context.json(await options.agent.setAutoTitle(body.auto_title));
    } catch (e) {
      return errorResponse(e, 400);
    }
  });

  app.get("/api/agent/run", async (context) => {
    const project_id = context.req.query("project_id"),
      space_id = context.req.query("space_id");
    if (!project_id || !space_id)
      return apiError("E_USAGE", "Project and Space required", {}, 400);
    return context.json({
      run: (await options.agent?.status?.({ project_id, space_id })) ?? null,
    });
  });
  app.post("/api/agent/cancel", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) return headerError;
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as Record<string, unknown> | null;
    if (
      typeof body?.project_id !== "string" ||
      typeof body?.space_id !== "string"
    )
      return apiError("E_USAGE", "Project and Space required", {}, 400);
    return context.json(
      (await options.agent?.cancel?.({
        project_id: body.project_id,
        space_id: body.space_id,
      })) ?? { cancelled: false },
    );
  });

  app.post("/api/agent/chat", async (context) => {
    if (!options.agent) {
      return apiError("E_USAGE", "Agent service is not configured", {}, 503);
    }
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return apiError("E_USAGE", "Agent chat body must be an object", {}, 400);
    }
    const body = parsed.value as Record<string, unknown>;
    if (
      typeof body.project_id !== "string" ||
      body.project_id.length === 0 ||
      typeof body.space_id !== "string" ||
      body.space_id.length === 0 ||
      typeof body.message !== "string" ||
      body.message.trim().length === 0 ||
      (body.base_layer_id !== undefined &&
        typeof body.base_layer_id !== "string")
    ) {
      return apiError(
        "E_USAGE",
        "Agent chat requires project_id, space_id, and message",
        {},
        400,
      );
    }
    try {
      return context.json(
        await options.agent.chat({
          project_id: body.project_id,
          space_id: body.space_id,
          message: body.message,
          ...(body.base_layer_id === undefined
            ? {}
            : { base_layer_id: body.base_layer_id }),
        }),
      );
    } catch (error) {
      if (
        error instanceof HumanBoardError &&
        error.details.model_unconfigured === true
      ) {
        return errorResponse(error, 409);
      }
      const status =
        error instanceof HumanBoardError
          ? error.code === "E_CONNECT"
            ? 502
            : error.code === "E_USAGE"
              ? 400
              : 404
          : 500;
      return errorResponse(error, status);
    }
  });

  app.post("/api/frontend/session", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    if (!options.frontendHub) {
      return apiError(
        "E_USAGE",
        "Frontend session hub is not configured",
        {},
        503,
      );
    }
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    const body = parsed.value;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return apiError(
        "E_USAGE",
        "Frontend session body must be an object",
        {},
        400,
      );
    }
    const record = body as Record<string, unknown>;
    if (
      typeof record.project_id !== "string" ||
      typeof record.space_id !== "string" ||
      record.project_id.length === 0 ||
      record.space_id.length === 0
    ) {
      return apiError(
        "E_USAGE",
        "Frontend session requires project_id and space_id",
        {},
        400,
      );
    }
    return context.json(
      options.frontendHub.register({
        project_id: record.project_id,
        space_id: record.space_id,
      }),
    );
  });

  app.get("/api/frontend/requests", async (context) => {
    if (!options.frontendHub) {
      return apiError(
        "E_USAGE",
        "Frontend session hub is not configured",
        {},
        503,
      );
    }
    const sessionId = context.req.query("session_id");
    if (!sessionId) {
      return apiError("E_USAGE", "session_id is required", {}, 400);
    }
    let timeout: number;
    try {
      timeout = parseFrontendTimeout(context.req.query("timeout"));
      const request = await options.frontendHub.waitForRequest(
        sessionId,
        timeout,
      );
      return context.json({ request });
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.post("/api/frontend/response", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    if (!options.frontendHub) {
      return apiError(
        "E_USAGE",
        "Frontend session hub is not configured",
        {},
        503,
      );
    }
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    const body = parsed.value;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return apiError(
        "E_USAGE",
        "Frontend capture body must be an object",
        {},
        400,
      );
    }
    const record = body as Record<string, unknown>;
    if (
      typeof record.session_id !== "string" ||
      typeof record.request_id !== "string" ||
      typeof record.based_on_layer !== "string" ||
      typeof record.based_on_seq !== "number" ||
      record.scene === null ||
      typeof record.scene !== "object" ||
      Array.isArray(record.scene) ||
      record.layer === null ||
      typeof record.layer !== "object" ||
      Array.isArray(record.layer) ||
      !Array.isArray(record.assets) ||
      typeof record.has_uncommitted !== "boolean" ||
      record.uncommitted === null ||
      typeof record.uncommitted !== "object" ||
      Array.isArray(record.uncommitted) ||
      typeof record.captured_at !== "string"
    ) {
      return apiError("E_USAGE", "Invalid frontend capture payload", {}, 400);
    }
    const scene = SceneSchema.safeParse(record.scene);
    if (!scene.success) {
      return apiError(
        "E_USAGE",
        "Invalid frontend capture payload",
        { field: "scene", issues: scene.error.issues },
        400,
      );
    }
    try {
      options.frontendHub.respond(record.session_id, record.request_id, {
        based_on_layer: record.based_on_layer,
        based_on_seq: record.based_on_seq,
        scene: scene.data,
        layer: record.layer as Readonly<Record<string, unknown>>,
        assets: record.assets,
        has_uncommitted: record.has_uncommitted,
        uncommitted: record.uncommitted as Readonly<Record<string, unknown>>,
        captured_at: record.captured_at,
      } satisfies FrontendCapturePayload);
      return context.json({ accepted: true });
    } catch (error) {
      return errorResponse(error, 400);
    }
  });

  app.post("/api/frontend/active-layer", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    if (!options.setActiveLayer) {
      return apiError(
        "E_USAGE",
        "Frontend active-layer writer is not configured",
        {},
        503,
      );
    }
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    const body = parsed.value;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return apiError(
        "E_USAGE",
        "Active layer body must be an object",
        {},
        400,
      );
    }
    const record = body as Record<string, unknown>;
    if (
      typeof record.space_id !== "string" ||
      typeof record.layer_id !== "string" ||
      record.space_id.length === 0 ||
      record.layer_id.length === 0
    ) {
      return apiError(
        "E_USAGE",
        "Active layer requires space_id and layer_id",
        {},
        400,
      );
    }
    try {
      const space = await options.setActiveLayer({
        space_id: record.space_id,
        layer_id: record.layer_id,
      });
      return context.json({
        space_id: space.space_id,
        active_layer_id: space.active_layer_id,
      });
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  // Deleting history is a human decision; this route has no CLI, MCP or agent tool.
  app.post("/api/frontend/delete-layer", async (context) => {
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    if (!options.deleteLayer) {
      return apiError("E_USAGE", "Layer deletion is not configured", {}, 503);
    }
    const parsed = await readLimitedJson(context, bodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    const record = parsed.value as Record<string, unknown> | null;
    if (
      record === null ||
      typeof record !== "object" ||
      typeof record.space_id !== "string" ||
      typeof record.layer_id !== "string" ||
      record.space_id.length === 0 ||
      record.layer_id.length === 0
    ) {
      return apiError(
        "E_USAGE",
        "Layer deletion requires space_id and layer_id",
        {},
        400,
      );
    }
    try {
      return context.json(
        await options.deleteLayer({
          space_id: record.space_id,
          layer_id: record.layer_id,
        }),
      );
    } catch (error) {
      return errorResponse(error, 400);
    }
  });

  app.post("/sync/negotiate", async (context) => {
    if (!options.sync) {
      return apiError("E_USAGE", "Sync service is not configured", {}, 503);
    }
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    const parsed = await readLimitedJson(context, syncBodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return apiError("E_USAGE", "Sync body must be an object", {}, 400);
    }
    const body = parsed.value as Record<string, unknown>;
    if (
      typeof body.project_id !== "string" ||
      typeof body.space_id !== "string" ||
      !Array.isArray(body.have) ||
      !body.have.every((value) => typeof value === "string")
    ) {
      return apiError(
        "E_USAGE",
        "Sync negotiate requires project_id, space_id, and have[]",
        {},
        400,
      );
    }
    const refs =
      body.refs !== null &&
      typeof body.refs === "object" &&
      !Array.isArray(body.refs)
        ? (body.refs as Record<string, unknown>)
        : {};
    const active =
      typeof refs.active === "string" || refs.active === null
        ? refs.active
        : undefined;
    const blobs =
      Array.isArray(refs.blobs) &&
      refs.blobs.every((value) => typeof value === "string")
        ? refs.blobs
        : undefined;
    if (
      refs.messages !== undefined &&
      (!Array.isArray(refs.messages) ||
        !refs.messages.every((value) => typeof value === "string"))
    )
      return apiError(
        "E_USAGE",
        "Sync message inventory must be an array of IDs",
        {},
        400,
      );
    try {
      return context.json(
        await options.sync.negotiate(
          body.project_id,
          body.space_id,
          body.have,
          {
            ...(active === undefined ? {} : { active }),
            ...(blobs === undefined ? {} : { blobs }),
            ...(refs.messages === undefined
              ? {}
              : { messages: refs.messages as string[] }),
          },
        ),
      );
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.post("/sync/push", async (context) => {
    if (!options.sync) {
      return apiError("E_USAGE", "Sync service is not configured", {}, 503);
    }
    const headerError = requireClientPostHeaders(context);
    if (headerError) {
      return headerError;
    }
    const parsed = await readLimitedJson(context, syncBodyLimit);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return apiError("E_USAGE", "Sync body must be an object", {}, 400);
    }
    const body = parsed.value as Record<string, unknown>;
    if (
      typeof body.project_id !== "string" ||
      typeof body.space_id !== "string" ||
      !Array.isArray(body.layers) ||
      !Array.isArray(body.blobs)
    ) {
      return apiError(
        "E_USAGE",
        "Sync push requires project_id, space_id, layers[], and blobs[]",
        {},
        400,
      );
    }
    try {
      return context.json(
        await options.sync.applyPush(body.project_id, body.space_id, {
          ...body,
          meta: Array.isArray(body.meta) ? body.meta : [],
        }),
      );
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.get("/layers/:id", async (context) => {
    if (!options.sync) {
      return apiError("E_USAGE", "Sync service is not configured", {}, 503);
    }
    const projectId = context.req.query("project_id");
    const spaceId = context.req.query("space_id");
    if (!projectId || !spaceId) {
      return apiError(
        "E_USAGE",
        "project_id and space_id query parameters are required",
        {},
        400,
      );
    }
    try {
      return context.json(
        await options.sync.pullLayer(
          projectId,
          spaceId,
          context.req.param("id"),
        ),
      );
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.get("/blobs/:hash", async (context) => {
    if (!options.sync) {
      return apiError("E_USAGE", "Sync service is not configured", {}, 503);
    }
    const hash = context.req.param("hash");
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
      return apiError("E_USAGE", "Invalid blob hash", { hash }, 400);
    }
    try {
      const data = await options.sync.readBlob(hash);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (error) {
      return errorResponse(error, 404);
    }
  });

  app.post("/api/command", async (context) => {
    if (context.req.header("x-humanboard-client") !== "1") {
      return apiError(
        "E_AUTH",
        "X-HumanBoard-Client: 1 is required",
        { header: "X-HumanBoard-Client" },
        403,
      );
    }
    if (!isJsonContentType(context.req.header("content-type"))) {
      return apiError(
        "E_USAGE",
        "Content-Type must be application/json",
        { content_type: context.req.header("content-type") ?? null },
        400,
      );
    }

    const declaredLength = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      return apiError(
        "E_USAGE",
        "Command request body is too large",
        { max_bytes: bodyLimit, size: declaredLength },
        413,
      );
    }

    const bodyBytes = await context.req.arrayBuffer();
    if (bodyBytes.byteLength > bodyLimit) {
      return apiError(
        "E_USAGE",
        "Command request body is too large",
        { max_bytes: bodyLimit, size: bodyBytes.byteLength },
        413,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch (error) {
      return apiError(
        "E_USAGE",
        "Command request body must be valid JSON",
        { cause: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return apiError(
        "E_USAGE",
        "Command request body must be an object",
        {},
        400,
      );
    }
    const record = body as Record<string, unknown>;
    if (
      !Array.isArray(record.argv) ||
      !record.argv.every((value) => typeof value === "string")
    ) {
      return apiError("E_USAGE", "argv must be an array of strings", {}, 400);
    }
    if (record.cwd !== undefined && typeof record.cwd !== "string") {
      return apiError("E_USAGE", "cwd must be a string", {}, 400);
    }
    if (record.stdin !== undefined && typeof record.stdin !== "string") {
      return apiError("E_USAGE", "stdin must be a string", {}, 400);
    }

    if (
      [record.session_id, record.cli_session_id].some(
        (v) =>
          v !== undefined &&
          (typeof v !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(v)),
      ) ||
      (record.session_id !== undefined && record.cli_session_id !== undefined)
    ) {
      return apiError(
        "E_USAGE",
        "Provide one valid web or CLI session ID",
        {},
        400,
      );
    }
    if (
      record.file_blobs !== undefined &&
      (record.file_blobs === null ||
        typeof record.file_blobs !== "object" ||
        Array.isArray(record.file_blobs) ||
        Object.entries(record.file_blobs).some(
          ([path, hash]) =>
            path.length > 4096 ||
            typeof hash !== "string" ||
            !/^sha256:[a-f0-9]{64}$/.test(hash),
        ))
    )
      return apiError("E_USAGE", "Invalid uploaded file mapping", {}, 400);
    try {
      const result = await options.execute({
        argv: record.argv,
        ...(typeof record.cli_session_id === "string"
          ? { cliSessionId: record.cli_session_id }
          : {}),
        ...(record.file_blobs === undefined
          ? {}
          : { fileBlobs: record.file_blobs as Record<string, string> }),
        ...(typeof record.session_id === "string" &&
        /^[a-zA-Z0-9-]{1,100}$/.test(record.session_id)
          ? { sessionId: record.session_id }
          : {}),
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
        ...(record.stdin === undefined ? {} : { stdin: record.stdin }),
      });
      const baseUrl = options.publicUrl ?? new URL(context.req.url).origin;
      const publicValue = (value: unknown): unknown => {
        if (typeof value === "string" && value.startsWith("file://")) {
          try {
            const path = new URL(value).pathname;
            const parts = path.split("/");
            for (const [dir, route] of [
              ["renders", "render"],
              ["inspect", "inspect"],
            ] as const) {
              const i = parts.lastIndexOf(dir);
              if (i >= 0 && i < parts.length - 1)
                return `${baseUrl.replace(/\/$/, "")}/${route}/${parts.slice(i + 1).join("/")}`;
            }
          } catch {}
          return value;
        }
        if (Array.isArray(value)) return value.map(publicValue);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, publicValue(v)]),
          );
        return value;
      };
      return context.json(publicValue(result));
    } catch (error) {
      return errorResponse(error, 200);
    }
  });

  app.get("/api/watch", async (context) => {
    let timeoutSeconds: number;
    let all: boolean;
    try {
      timeoutSeconds = parseTimeout(context.req.query("timeout"));
      all = parseBoolean(context.req.query("all"));
    } catch (error) {
      return errorResponse(error, 400);
    }

    if (!options.resolveWatch) {
      return apiError(
        "E_USAGE",
        "watch scope resolution is not configured",
        { feature: "watch" },
        400,
      );
    }
    const project = context.req.query("project") || undefined;
    const space = context.req.query("space") || undefined;
    const since = context.req.query("since") || undefined;
    let watchScope: WatchScope;
    try {
      watchScope = await options.resolveWatch({
        ...(project === undefined ? {} : { project }),
        ...(space === undefined ? {} : { space }),
        ...(since === undefined ? {} : { since }),
      });
    } catch (error) {
      return errorResponse(error, 404);
    }

    const replay =
      watchScope.since_seq !== undefined && options.watchHistory
        ? await options.watchHistory(watchScope)
        : [];
    const replaySeq = replay.reduce(
      (seq, event) => Math.max(seq, event.seq),
      watchScope.since_seq ?? 0,
    );
    const encoder = new TextEncoder();
    let unsubscribe: () => void = () => {};
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (value: unknown): void => {
          if (closed) {
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        for (const event of replay)
          if (all || event.author.kind === "human") enqueue(event);
        unsubscribe = options.events.subscribe(enqueue, {
          all,
          projectId: watchScope.project_id,
          spaceId: watchScope.space_id,
          ...(watchScope.since_seq === undefined
            ? {}
            : { sinceSeq: replaySeq }),
        });
        timeoutHandle = setTimeout(() => {
          enqueue({
            error: {
              code: "E_WATCH_TIMEOUT",
              message: `watch timed out after ${timeoutSeconds}s`,
              details: { timeout_s: timeoutSeconds },
            },
          });
          cleanup();
          controller.close();
        }, timeoutSeconds * 1000);
        context.req.raw.signal.addEventListener(
          "abort",
          () => {
            cleanup();
            try {
              controller.close();
            } catch {
              // The stream may already be closed by the runtime.
            }
          },
          { once: true },
        );
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  });

  app.get("/render/*", async (context) => {
    let path: string;
    try {
      path = renderPath(options.cacheDir, new URL(context.req.url).pathname);
    } catch (error) {
      return errorResponse(error, 400);
    }
    try {
      const data = await readFile(path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, no-cache",
        },
      });
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return apiError("E_NOT_FOUND", "Render file does not exist", {}, 404);
      }
      return errorResponse(error, 500);
    }
  });

  app.get("/inspect/*", async (context) => {
    let path: string;
    try {
      path = inspectPath(options.cacheDir, new URL(context.req.url).pathname);
    } catch (error) {
      return errorResponse(error, 400);
    }
    try {
      const data = await readFile(path);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, no-cache",
        },
      });
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "ENOENT") {
        return apiError("E_NOT_FOUND", "Inspect file does not exist", {}, 404);
      }
      return errorResponse(error, 500);
    }
  });

  app.get("/", () => serveStatic(options.staticDir, "/", options.staticAssets));
  app.get("/assets/*", (context) =>
    serveStatic(
      options.staticDir,
      new URL(context.req.url).pathname,
      options.staticAssets,
    ),
  );
  app.get("/favicon.ico", () =>
    serveStatic(options.staticDir, "/favicon.ico", options.staticAssets),
  );

  app.notFound(() => apiError("E_NOT_FOUND", "Route does not exist", {}, 404));
  app.onError((error) => errorResponse(error, 500));

  return app;
}

export function startServer(options: ServerAppOptions): RunningServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const app = createServerApp({ ...options, host, port });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: app.fetch,
      // Long polls and watch own their timeout; Bun must not close idle streams.
      idleTimeout: 0,
    });
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Cannot start local server", {
      host,
      port,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    app,
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}
