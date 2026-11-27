import { HumanBoardError } from "@humanboard/core-engine";

import { readServerConfig, type ServerConfig } from "./client-actions";
import type { CommitEvent, CommitEventBus } from "./commit-event-bus";
import type { RuntimePaths } from "./config";
import { checkServerHealth, type ServerHealth } from "./server-health";
import { RemoteSyncClient, type SyncTransport } from "./sync-client";

export const DEFAULT_SYNC_DEBOUNCE_MS = 1500;

export interface SyncSchedulerFailure {
  readonly project_id: string;
  readonly space_id: string;
  readonly layer_id: string;
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
}

export interface CommitSyncSchedulerOptions {
  readonly events: CommitEventBus;
  readonly paths: RuntimePaths;
  readonly push: (
    event: CommitEvent,
    client: SyncTransport,
  ) => Promise<unknown>;
  readonly debounceMs?: number;
  readonly shouldSync?: (event: CommitEvent) => boolean | Promise<boolean>;
  readonly readConfig?: (paths: RuntimePaths) => Promise<ServerConfig | null>;
  readonly checkHealth?: (config: ServerConfig) => Promise<ServerHealth>;
  readonly createClient?: (config: ServerConfig) => SyncTransport;
  readonly onFailure?: (failure: SyncSchedulerFailure) => void;
}

function eventKey(event: CommitEvent): string {
  return `${event.project_id}:${event.space_id}`;
}

function schedulerFailure(
  event: CommitEvent,
  error: unknown,
): SyncSchedulerFailure {
  let cause: string | undefined;
  if (error instanceof HumanBoardError) {
    try {
      cause = JSON.stringify(error.details);
    } catch {
      cause = String(error.details);
    }
  }
  return {
    project_id: event.project_id,
    space_id: event.space_id,
    layer_id: event.layer_id,
    code: error instanceof HumanBoardError ? error.code : "E_CONNECT",
    message: error instanceof Error ? error.message : String(error),
    ...(cause === undefined ? {} : { cause }),
  };
}

export class CommitSyncScheduler {
  private readonly events: CommitEventBus;
  private readonly paths: RuntimePaths;
  private readonly push: CommitSyncSchedulerOptions["push"];
  private readonly shouldSync: NonNullable<
    CommitSyncSchedulerOptions["shouldSync"]
  >;
  private readonly debounceMs: number;
  private readonly readConfig: NonNullable<
    CommitSyncSchedulerOptions["readConfig"]
  >;
  private readonly checkHealth: NonNullable<
    CommitSyncSchedulerOptions["checkHealth"]
  >;
  private readonly createClient: NonNullable<
    CommitSyncSchedulerOptions["createClient"]
  >;
  private readonly onFailure:
    | CommitSyncSchedulerOptions["onFailure"]
    | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;
  private readonly failureLog: SyncSchedulerFailure[] = [];

  constructor(options: CommitSyncSchedulerOptions) {
    const debounceMs = options.debounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new HumanBoardError(
        "E_USAGE",
        "Sync debounce must be a non-negative number",
        { debounce_ms: debounceMs },
      );
    }
    this.events = options.events;
    this.paths = options.paths;
    this.push = options.push;
    this.shouldSync = options.shouldSync ?? (() => true);
    this.debounceMs = debounceMs;
    this.readConfig = options.readConfig ?? readServerConfig;
    this.checkHealth =
      options.checkHealth ??
      ((config) =>
        checkServerHealth(new URL(config.server_url), {
          token: config.token,
        }));
    this.createClient =
      options.createClient ??
      ((config) =>
        new RemoteSyncClient({
          serverUrl: config.server_url,
          token: config.token,
        }));
    this.onFailure = options.onFailure;
    this.unsubscribe = this.events.subscribe(
      (event) => {
        this.schedule(event);
      },
      { all: true },
    );
  }

  get failures(): readonly SyncSchedulerFailure[] {
    return [...this.failureLog];
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(event: CommitEvent): void {
    const key = eventKey(event);
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flush(event);
    }, this.debounceMs);
    const unref = (timer as { unref?: () => void }).unref;
    if (unref !== undefined) {
      unref.call(timer);
    }
    this.timers.set(key, timer);
  }

  private async flush(event: CommitEvent): Promise<void> {
    try {
      if (!(await this.shouldSync(event))) return;
      const config = await this.readConfig(this.paths);
      if (config === null) {
        return;
      }
      const health = await this.checkHealth(config);
      if (!health.healthy) {
        throw new HumanBoardError(
          health.reason === "auth" ? "E_AUTH" : "E_CONNECT",
          "Remote HumanBoard server is unavailable",
          {
            server_url: config.server_url,
            status: health.status,
            reason: health.reason,
          },
        );
      }
      await this.push(event, this.createClient(config));
    } catch (error) {
      const failure = schedulerFailure(event, error);
      this.failureLog.push(failure);
      try {
        this.onFailure?.(failure);
      } catch {
        // Failure reporting must never affect commit delivery.
      }
    }
  }
}
