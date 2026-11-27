#!/usr/bin/env bun

import { createMcpRuntime } from "./runtime";
import type { McpScope } from "./tools";

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function splitList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseScopes(value: string | undefined): readonly McpScope[] {
  const items = splitList(value) ?? ["read", "write", "admin"];
  const allowed: readonly McpScope[] = ["read", "write", "admin"];
  return items.map((item) => {
    if (!allowed.includes(item as McpScope)) {
      throw new Error(`Unknown MCP scope: ${item}`);
    }
    return item as McpScope;
  });
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4318 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HUMANBOARD_MCP_PORT must be an integer from 1 to 65535");
  }
  return port;
}

async function main(): Promise<void> {
  const env = process.env;
  const token =
    envValue(env, "HUMAN_AUTH_TOKEN") ?? envValue(env, "HUMAN_MCP_TOKEN");
  const runtime = await createMcpRuntime({
    cwd: process.cwd(),
    env,
    host: envValue(env, "HUMANBOARD_MCP_HOST") ?? "127.0.0.1",
    port: parsePort(envValue(env, "HUMANBOARD_MCP_PORT")),
    ...(token === undefined
      ? {}
      : {
          auth: {
            token,
            scopes: parseScopes(envValue(env, "HUMAN_MCP_SCOPES")),
          },
        }),
    ...(splitList(envValue(env, "HUMAN_ALLOWED_HOSTS")) === undefined
      ? {}
      : {
          allowedHosts: splitList(
            envValue(env, "HUMAN_ALLOWED_HOSTS"),
          )!,
        }),
    ...(splitList(envValue(env, "HUMAN_ALLOWED_ORIGINS")) === undefined
      ? {}
      : {
          allowedOrigins: splitList(
            envValue(env, "HUMAN_ALLOWED_ORIGINS"),
          )!,
        }),
  });

  console.log(`HumanBoard MCP listening on ${runtime.url}/mcp`);
  const shutdown = async (): Promise<void> => {
    await runtime.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
