import { readLocalServerState } from "./local-server-state";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { HumanBoardError } from "@humanboard/core-engine";

import {
  resolveRuntimePaths,
  type Environment,
  type RuntimePaths,
} from "./config";
import { checkServerHealth } from "./server-health";
import type { CommandResult } from "./output";

const execFileAsync = promisify(execFile);
const DEFAULT_SERVER_URL = "http://127.0.0.1:4317";

export interface ServerConfig {
  readonly server_url: string;
  readonly token: string;
}

export interface ConnectResult extends CommandResult {
  readonly config: ServerConfig;
}

export interface OpenResult extends CommandResult {
  readonly url: string;
}

function normalizeServerUrl(
  value: string,
  details: Record<string, unknown> = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Invalid HumanBoard server URL", {
      ...details,
      value,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HumanBoardError("E_CONNECT", "Invalid HumanBoard server URL", {
      ...details,
      value,
      reason: "unsupported_protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed;
}

function looksLikeUrl(value: string): boolean {
  return value.includes("://");
}

export async function readServerConfig(
  paths: RuntimePaths,
): Promise<ServerConfig | null> {
  let content: string;
  try {
    content = await readFile(paths.configFile, "utf8");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw new HumanBoardError(
      "E_USAGE",
      `Cannot read HumanBoard config ${paths.configFile}`,
      {
        path: paths.configFile,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new HumanBoardError(
      "E_USAGE",
      `Invalid HumanBoard config ${paths.configFile}`,
      {
        path: paths.configFile,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HumanBoardError(
      "E_USAGE",
      `Invalid HumanBoard config ${paths.configFile}`,
      { path: paths.configFile, reason: "config_not_object" },
    );
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.server_url !== "string" ||
    record.server_url.trim().length === 0 ||
    typeof record.token !== "string"
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      `Invalid HumanBoard config ${paths.configFile}`,
      { path: paths.configFile, reason: "missing_server_url_or_token" },
    );
  }
  return {
    server_url: record.server_url.trim(),
    token: record.token,
  };
}

async function writeServerConfig(
  paths: RuntimePaths,
  config: ServerConfig,
): Promise<string> {
  await mkdir(paths.home, { recursive: true });
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return paths.configFile;
}

export async function configuredServer(
  env: Environment,
  paths: RuntimePaths,
): Promise<{
  readonly serverUrl: string;
  readonly token: string;
  readonly explicit: boolean;
}> {
  const configuredUrl = env.HUMANBOARD_SERVER_URL?.trim();
  if (configuredUrl !== undefined && configuredUrl.length > 0) {
    return {
      serverUrl: configuredUrl,
      token: env.HUMAN_AUTH_TOKEN ?? "",
      explicit: true,
    };
  }
  const config = await readServerConfig(paths);
  const local = config ? null : await readLocalServerState(paths);
  return {
    serverUrl:
      config?.server_url ??
      local?.url ??
      `http://127.0.0.1:${env.HUMANBOARD_PORT || "4317"}`,
    token: env.HUMAN_AUTH_TOKEN || config?.token || "",
    explicit: !!config,
  };
}

export async function connectServer(options: {
  readonly target: string;
  readonly cwd: string;
  readonly env: Environment;
}): Promise<ConnectResult> {
  const paths = resolveRuntimePaths(options.env, options.cwd);
  const target = options.target.trim();
  if (target.length === 0) {
    throw new HumanBoardError("E_USAGE", "connect target must not be empty");
  }

  let serverUrl: string;
  let token: string;
  if (looksLikeUrl(target)) {
    serverUrl = normalizeServerUrl(target).href;
    token = "";
  } else {
    const existing = await readServerConfig(paths);
    serverUrl =
      options.env.HUMANBOARD_SERVER_URL?.trim() ||
      existing?.server_url ||
      DEFAULT_SERVER_URL;
    token = target;
  }

  const base = normalizeServerUrl(serverUrl);
  const health = await checkServerHealth(base, { token });
  if (health.reason === "auth") {
    throw new HumanBoardError(
      "E_AUTH",
      "HumanBoard server rejected the token",
      {
        server_url: base.href,
        status: health.status,
      },
    );
  }
  if (!health.healthy) {
    throw new HumanBoardError(
      "E_CONNECT",
      "Cannot connect to HumanBoard server",
      {
        server_url: base.href,
        status: health.status,
        reason: health.reason,
      },
    );
  }

  const config: ServerConfig = { server_url: base.href, token };
  const configPath = await writeServerConfig(paths, config);
  return {
    config,
    data: {
      server_url: config.server_url,
      token_configured: config.token.length > 0,
      config: configPath,
      warnings: [],
    },
    text: `Connected to ${config.server_url}\nConfig: ${configPath}`,
  };
}

export async function launchDefaultBrowser(url: string): Promise<void> {
  try {
    await execFileAsync("open", [url], { timeout: 5000 });
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Cannot open the default browser", {
      url,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function openBoard(options: {
  readonly layer?: string;
  readonly cwd: string;
  readonly env: Environment;
  readonly platform?: NodeJS.Platform;
  readonly launchBrowser?: (url: string) => Promise<void> | void;
}): Promise<OpenResult> {
  const paths = resolveRuntimePaths(options.env, options.cwd);
  const configured = await configuredServer(options.env, paths);
  const base = normalizeServerUrl(configured.serverUrl);
  const health = await checkServerHealth(base, { token: configured.token });
  if (!health.healthy) {
    throw new HumanBoardError("E_CONNECT", "HumanBoard server is not running", {
      server_url: base.href,
      status: health.status,
      reason: health.reason,
    });
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new HumanBoardError(
      "E_USAGE",
      "human open is only supported on macOS",
      { reason: "unsupported_platform", platform },
    );
  }

  const boardUrl = new URL(base.href);
  if (options.layer !== undefined) {
    boardUrl.searchParams.set("layer", options.layer);
  }
  await (options.launchBrowser ?? launchDefaultBrowser)(boardUrl.href);
  return {
    url: boardUrl.href,
    data: {
      url: boardUrl.href,
      opened: true,
      warnings: [],
    },
    text: `Opened ${boardUrl.href}`,
  };
}
