import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HumanBoardError } from "@humanboard/core-engine";
import { readServerConfig } from "./client-actions";
import type { RuntimePaths } from "./config";
import {
  RemoteSyncClient,
  pullRemoteToLocal,
  pushLocalToRemote,
  isMissingSyncScope,
  type LocalSyncProvider,
} from "./sync-client";
export interface SyncScope {
  project_id: string;
  space_id: string;
}
export interface SyncableLocal extends LocalSyncProvider {
  syncScopes(projectId?: string): Promise<SyncScope[]>;
}
export interface ProjectSyncStatus {
  cloud_sync: boolean;
  remote_configured: boolean;
  running: boolean;
  last_synced_at: string | null;
  error: string | null;
}
/** Explicit opt-in per Project; sync transport does not change the human's active view. */
export class ProjectSyncService {
  private enabled = new Set<string>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly status = new Map<
    string,
    { last_synced_at: string | null; error: string | null }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private writes = Promise.resolve();
  constructor(
    private readonly paths: RuntimePaths,
    private readonly local: SyncableLocal,
    private readonly file: string,
  ) {}
  async start(intervalMs = 10000): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (
        !Array.isArray(data.enabled_projects) ||
        data.enabled_projects.some((v: unknown) => typeof v !== "string")
      )
        throw new Error("Invalid sync settings");
      this.enabled = new Set(data.enabled_projects);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }
  async get(projectId: string): Promise<ProjectSyncStatus> {
    await this.local.syncScopes(projectId);
    return {
      cloud_sync: this.enabled.has(projectId),
      remote_configured: !!(await readServerConfig(this.paths)),
      running: this.active.has(projectId),
      last_synced_at: this.status.get(projectId)?.last_synced_at ?? null,
      error: this.status.get(projectId)?.error ?? null,
    };
  }
  isEnabled(projectId: string): boolean {
    return this.enabled.has(projectId);
  }
  async set(projectId: string, enabled: boolean): Promise<ProjectSyncStatus> {
    await this.local.syncScopes(projectId);
    if (enabled && !(await readServerConfig(this.paths)))
      throw new HumanBoardError(
        "E_USAGE",
        "请先通过 human connect 配置远端服务，再开启此项目同步",
      );
    const write = this.writes.then(async () => {
      const next = new Set(this.enabled);
      enabled ? next.add(projectId) : next.delete(projectId);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(
        this.file + ".tmp",
        JSON.stringify({ enabled_projects: [...next] }) + "\n",
        { mode: 0o600 },
      );
      await rename(this.file + ".tmp", this.file);
      this.enabled = next;
    });
    this.writes = write.catch(() => {});
    await write;
    if (enabled) void this.run(projectId);
    return this.get(projectId);
  }
  async run(projectId: string): Promise<void> {
    if (this.stopped || !this.enabled.has(projectId)) return;
    const existing = this.active.get(projectId);
    if (existing) return existing;
    const task = this.perform(projectId).catch((e) => {
      this.status.set(projectId, {
        last_synced_at: this.status.get(projectId)?.last_synced_at ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    this.active.set(projectId, task);
    try {
      await task;
    } finally {
      this.active.delete(projectId);
    }
  }
  async flush(projectId: string) {
    await this.active.get(projectId);
    await this.run(projectId);
  }
  private async perform(projectId: string) {
    const config = await readServerConfig(this.paths);
    if (!config) throw new Error("远端连接尚未配置");
    const client = new RemoteSyncClient({
      serverUrl: config.server_url,
      token: config.token,
      timeoutMs: 5000,
    });
    const failures: string[] = [];
    for (const scope of await this.local.syncScopes(projectId)) {
      if (this.stopped || !this.enabled.has(projectId)) return;
      try {
        try {
          const pulled = await pullRemoteToLocal(
            this.local,
            client,
            scope.project_id,
            scope.space_id,
          );
          if (pulled.response.rejected.length)
            throw new Error("部分远端层未能导入，请检查同步状态");
        } catch (error) {
          // A newly created local Space has no remote replica yet. The push below
          // initializes the matching remote identities; other failures stay errors.
          if (!isMissingSyncScope(error)) throw error;
        }
        const pushed = await pushLocalToRemote(
          this.local,
          client,
          scope.project_id,
          scope.space_id,
        );
        if (pushed.response.rejected.length)
          throw new Error("远端拒绝了部分层，请检查同步状态");
      } catch (error) {
        failures.push(
          `${scope.space_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
    this.status.set(projectId, {
      last_synced_at: new Date().toISOString(),
      error: null,
    });
  }
  private async tick() {
    await Promise.all([...this.enabled].map((id) => this.run(id)));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active.values()]);
    await this.writes;
  }
}
