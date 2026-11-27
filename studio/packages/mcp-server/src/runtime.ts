import { CommitEventBus } from "@humanboard/application-service/commit-event-bus";
import {
  createSessionCommandExecutor as createCliSessionCommandExecutor,
} from "@humanboard/application-service/server-runtime";

import {
  startMcpServer,
  type McpAppOptions,
  type RunningMcpServer,
} from "./server";

export { createSessionCommandExecutor } from "@humanboard/application-service/server-runtime";
export type {
  McpSessionCommandExecutor as McpSessionExecutor,
} from "@humanboard/application-service/server-runtime";

export interface McpSessionExecutorOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface McpRuntimeOptions extends McpSessionExecutorOptions {
  readonly host?: string;
  readonly port?: number;
  readonly auth?: McpAppOptions["auth"];
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly bodyLimitBytes?: number;
  readonly protocolVersion?: string;
}

export interface McpRuntime {
  readonly running: RunningMcpServer;
  readonly sessions: ReturnType<typeof createCliSessionCommandExecutor>;
  readonly url: string;
  stop(): Promise<void>;
}

export async function createMcpRuntime(
  options: McpRuntimeOptions,
): Promise<McpRuntime> {
  const sessions = createCliSessionCommandExecutor({
    cwd: options.cwd,
    env: options.env,
    eventBus: new CommitEventBus(),
  });
  try {
    const running = startMcpServer({
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.allowedHosts === undefined
        ? {}
        : { allowedHosts: options.allowedHosts }),
      ...(options.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: options.allowedOrigins }),
      ...(options.bodyLimitBytes === undefined
        ? {}
        : { bodyLimitBytes: options.bodyLimitBytes }),
      ...(options.protocolVersion === undefined
        ? {}
        : { protocolVersion: options.protocolVersion }),
      execute: sessions.execute,
    });
    return {
      running,
      sessions,
      url: running.url,
      async stop() {
        await running.stop();
        await sessions.close();
      },
    };
  } catch (error) {
    await sessions.close();
    throw error;
  }
}
