import { packagedStaticAssets } from "./runtime-assets";
import {
  clearLocalServerState,
  writeLocalServerState,
} from "./local-server-state";
import { ensureManagedLocalServer } from "./local-server-launcher";
import { ModelSettingsService } from "./model-settings";
import { ProjectSyncService } from "./project-sync";
import { mcpImages } from "./mcp-images";
import { configuredServer } from "./client-actions";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ulid } from "ulid";

import {
  computeSceneBounds,
  ERROR_EXIT_CODES,
  HumanBoardError,
  renderSceneToPNG,
  type HumanBoardErrorCode,
  type ModelProvider,
  type Layer,
  type SyncPushPayload,
} from "@humanboard/core-engine";
import {
  FrontendSessionHub,
  startServer,
  type CommandError,
  type CommandExecutionRequest,
  type CommandExecutionResult,
  type RunningServer,
  type WatchScope,
  type WatchScopeQuery,
} from "@humanboard/server-self-hosted";
import {
  createMcpApp,
  type McpAuthConfig,
  type McpCommandRequest,
  type McpCommandResult,
} from "@humanboard/server-self-hosted/mcp-app";

import { CommitEventBus } from "./commit-event-bus";
import {
  autoTitleEnabled,
  BackgroundTitleService,
} from "./background-title-service";
import {
  CommitSyncScheduler,
  DEFAULT_SYNC_DEBOUNCE_MS,
} from "./commit-sync-scheduler";
import {
  runtimeInstanceId,
  resolveRuntimePaths,
  connectedCliSessionId,
  type Environment,
} from "./config";
import {
  LocalAppService,
  type LocalAppServiceOptions,
} from "./local-app-service";
import { outputModeForCommand, parseCliArgs, type OutputMode } from "./parser";
import { renderError } from "./output";
import { checkServerHealth } from "./server-health";
import { pushLocalToRemote } from "./sync-client";

export interface ServerRuntimeOptions {
  readonly cwd: string;
  readonly env: Environment;
  readonly host: string;
  readonly port: number;
  readonly staticDir?: string;
  readonly staticAssets?: Readonly<Record<string, string>>;
  readonly syncDebounceMs?: number;
  readonly syncPollMs?: number;
  readonly agentProvider?: ModelProvider;
  readonly visionProvider?: ModelProvider;
  readonly textProvider?: ModelProvider;
  readonly mcpAuth?: McpAuthConfig;
}

export interface ServerRuntime {
  readonly running: RunningServer;
  readonly pool: ServicePool;
  readonly mcpSessions: McpSessionCommandExecutor;
  readonly events: CommitEventBus;
  readonly syncScheduler: CommitSyncScheduler;
  readonly projectSync: ProjectSyncService;
  readonly frontendHub: FrontendSessionHub;
  readonly url: string;
  stop(): Promise<void>;
}

export interface McpSessionCommandExecutor {
  readonly execute: (
    request: McpCommandRequest &
      Pick<CommandExecutionRequest, "fileBlobs" | "cwd">,
  ) => Promise<McpCommandResult>;
  activeSessionCount(): number;
  close(): Promise<void>;
}

export interface McpSessionCommandExecutorOptions {
  readonly isolateBinding?: boolean;
  readonly includeImages?: boolean;
  readonly cwd: string;
  readonly env: Environment;
  readonly eventBus?: CommitEventBus;
  readonly agentProvider?: ModelProvider;
  readonly hooks?: {
    readonly onAssetsRegistered?: LocalAppServiceOptions["onAssetsRegistered"];
    readonly onLayerCommitted?: LocalAppServiceOptions["onLayerCommitted"];
    readonly resolveLayerTitle?: LocalAppServiceOptions["resolveLayerTitle"];
  };
  readonly capture?: CaptureCommandHandler;
}

export type CaptureCommandHandler = (
  request: CommandExecutionRequest,
  global: { readonly project?: string; readonly space?: string },
  service: LocalAppService,
) => Promise<CommandExecutionResult>;

export interface WatchClientOptions {
  readonly env: Environment;
  readonly cwd?: string;
  readonly project?: string;
  readonly space?: string;
  readonly since?: string;
  readonly all: boolean;
  readonly timeoutSeconds: number;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly autoStart?: boolean;
  readonly cliEntry?: string;
  readonly cliCommand?: readonly string[];
  readonly onAutoStart?: (child: Bun.Subprocess) => void;
}

function isHumanBoardErrorCode(code: string): code is HumanBoardErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_EXIT_CODES, code);
}

function commandError(error: unknown): CommandError {
  if (error instanceof HumanBoardError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  return {
    code: "E_INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function exitCodeFor(error: unknown): number {
  return error instanceof HumanBoardError ? error.exitCode : 1;
}

function outputModeForError(
  argv: readonly string[],
): Exclude<OutputMode, "auto"> {
  try {
    return outputModeForCommand(parseCliArgs(argv));
  } catch {
    return "json";
  }
}

function errorFromPayload(value: unknown): HumanBoardError {
  if (value !== null && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (error !== null && typeof error === "object") {
      const record = error as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : "E_INTERNAL";
      const normalizedCode = isHumanBoardErrorCode(code) ? code : "E_INTERNAL";
      return new HumanBoardError(
        normalizedCode,
        typeof record.message === "string"
          ? record.message
          : "Server returned an error",
        record.details !== null &&
        typeof record.details === "object" &&
        !Array.isArray(record.details)
          ? (record.details as Record<string, unknown>)
          : {},
      );
    }
  }
  return new HumanBoardError("E_CONNECT", "Invalid response from local server");
}

export class ServicePool {
  private readonly env: Environment;
  private readonly defaultCwd: string;
  private readonly eventBus: CommitEventBus;
  private readonly agentProvider?: ModelProvider;
  private readonly onAssetsRegistered?: (
    service: LocalAppService,
    assets: Parameters<
      NonNullable<LocalAppServiceOptions["onAssetsRegistered"]>
    >[1],
  ) => void;
  private readonly onLayerCommitted?: (
    service: LocalAppService,
    layer: Parameters<
      NonNullable<LocalAppServiceOptions["onLayerCommitted"]>
    >[1],
  ) => void;
  private readonly resolveLayerTitle?: LocalAppServiceOptions["resolveLayerTitle"];
  private readonly captureView?: LocalAppServiceOptions["captureView"];
  private readonly services = new Map<string, Promise<LocalAppService>>();

  constructor(
    env: Environment,
    defaultCwd: string,
    eventBus: CommitEventBus,
    agentProvider?: ModelProvider,
    hooks: {
      readonly onAssetsRegistered?: LocalAppServiceOptions["onAssetsRegistered"];
      readonly onLayerCommitted?: LocalAppServiceOptions["onLayerCommitted"];
      readonly resolveLayerTitle?: LocalAppServiceOptions["resolveLayerTitle"];
      readonly captureView?: LocalAppServiceOptions["captureView"];
    } = {},
  ) {
    this.env = env;
    this.defaultCwd = resolve(defaultCwd);
    this.eventBus = eventBus;
    this.agentProvider = agentProvider;
    this.onAssetsRegistered = hooks.onAssetsRegistered;
    this.onLayerCommitted = hooks.onLayerCommitted;
    this.resolveLayerTitle = hooks.resolveLayerTitle;
    this.captureView = hooks.captureView;
  }

  get(cwd?: string): Promise<LocalAppService> {
    const resolvedCwd =
      cwd === undefined ? this.defaultCwd : resolve(this.defaultCwd, cwd);
    const existing = this.services.get(resolvedCwd);
    if (existing) {
      return existing;
    }
    const created = LocalAppService.create({
      cwd: resolvedCwd,
      env: this.env,
      eventBus: this.eventBus,
      resolveLayerTitle: this.resolveLayerTitle,
      captureView: this.captureView,
      ...(this.agentProvider === undefined
        ? {}
        : { agentProvider: this.agentProvider }),
      ...(this.onAssetsRegistered === undefined
        ? {}
        : { onAssetsRegistered: this.onAssetsRegistered }),
      ...(this.onLayerCommitted === undefined
        ? {}
        : { onLayerCommitted: this.onLayerCommitted }),
    }).catch((error) => {
      this.services.delete(resolvedCwd);
      throw error;
    });
    this.services.set(resolvedCwd, created);
    return created;
  }

  getDefault(): Promise<LocalAppService> {
    return this.get();
  }

  async closeAll(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    const settled = await Promise.allSettled(services);
    for (const item of settled) {
      if (item.status === "fulfilled") {
        item.value.close();
      }
    }
  }
}

export function createSessionCommandExecutor(
  options: McpSessionCommandExecutorOptions,
): McpSessionCommandExecutor {
  const pools = new Map<string, ServicePool>();
  const eventBus = options.eventBus ?? new CommitEventBus();

  const poolFor = (sessionId: string): ServicePool => {
    const existing = pools.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const sessionEnv = {
      ...options.env,
      HUMANBOARD_SESSION: sessionId,
      HUMANBOARD_SESSION_BINDING: options.isolateBinding === false ? "0" : "1",
    };
    const pool = new ServicePool(
      sessionEnv,
      options.cwd,
      eventBus,
      options.agentProvider,
      options.hooks,
    );
    pools.set(sessionId, pool);
    return pool;
  };

  return {
    async execute(
      request: McpCommandRequest &
        Pick<CommandExecutionRequest, "fileBlobs" | "cwd">,
    ): Promise<McpCommandResult> {
      const pool = poolFor(request.sessionId);
      const result = await executeApiCommand(
        pool,
        {
          argv: request.argv,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.fileBlobs === undefined
            ? {}
            : { fileBlobs: request.fileBlobs }),
          ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        },
        options.capture === undefined ? {} : { capture: options.capture },
      );
      const kind = parseCliArgs(request.argv).command.kind;
      if (
        options.includeImages === false ||
        result.exitCode !== 0 ||
        !["get", "capture", "inspect", "diff", "draft"].includes(kind)
      )
        return result;
      try {
        return {
          ...result,
          images: await mcpImages(
            result.data,
            resolveRuntimePaths(options.env, options.cwd).cache,
          ),
        };
      } catch {
        return result;
      } // Cached images are an additive projection; structured results remain available.
    },
    activeSessionCount(): number {
      return pools.size;
    },
    async close(): Promise<void> {
      const active = [...pools.values()];
      pools.clear();
      await Promise.all(active.map((pool) => pool.closeAll()));
    },
  };
}

export async function executeApiCommand(
  pool: ServicePool,
  request: CommandExecutionRequest,
  options: {
    readonly capture?: CaptureCommandHandler;
  } = {},
): Promise<CommandExecutionResult> {
  let mode = outputModeForError(request.argv);
  try {
    const parsed = parseCliArgs(request.argv);
    if (parsed.command.kind === "sync")
      throw new HumanBoardError(
        "E_USAGE",
        "human sync pull is client-local and cannot run through /api/command",
      );
    mode = outputModeForCommand(parsed);
    if (parsed.command.kind === "capture" && options.capture) {
      const service = await pool.get(request.cwd);
      return await options.capture(request, parsed.global, service);
    }
    const service = await pool.get(request.cwd);
    const result = await service.execute(parsed.command, parsed.global, {
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.fileBlobs === undefined
        ? {}
        : { fileBlobs: request.fileBlobs }),
    });
    return {
      exitCode: 0,
      data: result.data,
      ...(mode === "text" ? { stdout: result.text } : {}),
    };
  } catch (error) {
    return {
      exitCode: exitCodeFor(error),
      error: commandError(error),
      stderr: renderError(error, mode).trimEnd(),
    };
  }
}

export async function captureCommandResult(
  frontendHub: FrontendSessionHub,
  cacheDir: string,
  baseUrl: string,
  service: LocalAppService,
  global: { readonly project?: string; readonly space?: string },
): Promise<CommandExecutionResult> {
  try {
    const scope = await service.resolveWatchScope({
      output: "json",
      ...(global.project === undefined ? {} : { project: global.project }),
      ...(global.space === undefined ? {} : { space: global.space }),
    });
    const payload = await frontendHub.requestCapture({
      projectId: scope.project_id,
      spaceId: scope.space_id,
      timeoutMs: 2000,
    });
    await service.resolveWatchScope(
      {
        output: "json",
        project: scope.project_id,
        space: scope.space_id,
      },
      payload.based_on_layer,
    );
    const snapshotId = ulid();
    const renderDirectory = join(cacheDir, "renders");
    await mkdir(renderDirectory, { recursive: true });
    await writeFile(
      join(renderDirectory, `${snapshotId}.png`),
      await service.renderScenePNG(payload.scene),
    );
    return {
      exitCode: 0,
      data: {
        ...payload,
        snapshot_id: snapshotId,
        render: {
          url: `${baseUrl}/render/${snapshotId}.png`,
          bounds: computeSceneBounds(payload.scene),
        },
      },
    };
  } catch (error) {
    return {
      exitCode: exitCodeFor(error),
      error: commandError(error),
      stderr: renderError(error, "json").trimEnd(),
    };
  }
}

export async function createServerRuntime(
  options: ServerRuntimeOptions,
): Promise<ServerRuntime> {
  const paths = resolveRuntimePaths(options.env, options.cwd);
  const events = new CommitEventBus();
  const frontendHub = new FrontendSessionHub();
  const modelSettings = await ModelSettingsService.create(
    paths.home,
    options.env,
    {
      ...(options.agentProvider ? { agent: options.agentProvider } : {}),
      ...(options.visionProvider ? { vision: options.visionProvider } : {}),
      ...(options.textProvider ? { text: options.textProvider } : {}),
    },
  );
  const agentProvider = modelSettings.routingProvider("agent");
  const visionProvider = modelSettings.provider("vision");
  const textProvider = modelSettings.provider("text");
  let preferenceWrites = Promise.resolve();
  const preferenceFile = join(paths.home, "agent-preferences.json");
  let autoTitle = autoTitleEnabled(options.env);
  try {
    const preferences = JSON.parse(await readFile(preferenceFile, "utf8"));
    if (typeof preferences.auto_title !== "boolean")
      throw new Error("Invalid agent preferences");
    autoTitle = preferences.auto_title;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const backgroundTitles = new BackgroundTitleService({
    enabled: autoTitle,
    configuration: modelSettings.publicConfiguration(),
    ...(visionProvider === undefined ? {} : { visionProvider }),
    ...(textProvider === undefined ? {} : { textProvider }),
  });
  const hooks = {
    captureView: (scope: { projectId: string; spaceId: string }) =>
      frontendHub.requestCapture({
        projectId: scope.projectId,
        spaceId: scope.spaceId,
        timeoutMs: 2000,
      }),
    resolveLayerTitle: (service: LocalAppService, layer: Layer) =>
      backgroundTitles.attemptLayerTitle(service, layer),
    onAssetsRegistered: (
      service: LocalAppService,
      assets: Parameters<
        NonNullable<LocalAppServiceOptions["onAssetsRegistered"]>
      >[1],
    ) => {
      backgroundTitles.scheduleAssets(service, assets);
    },
    onLayerCommitted: (
      service: LocalAppService,
      layer: Parameters<
        NonNullable<LocalAppServiceOptions["onLayerCommitted"]>
      >[1],
    ) => {
      void backgroundTitles.scheduleCommitted(service, layer).catch(() => {
        // Title scheduling is best-effort and never blocks commits.
      });
    },
  };
  const pool = new ServicePool(
    options.env,
    options.cwd,
    events,
    agentProvider,
    hooks,
  );
  const webSessions = createSessionCommandExecutor({
    includeImages: false,
    cwd: options.cwd,
    env: { ...options.env, HUMANBOARD_ACTOR: "human" },
    eventBus: events,
    hooks,
    agentProvider,
  });
  const mcpSessions = createSessionCommandExecutor({
    cwd: options.cwd,
    env: options.env,
    eventBus: events,
    ...(agentProvider === undefined ? {} : { agentProvider }),
    hooks,
    capture: (_captureRequest, global, service) =>
      captureCommandResult(
        frontendHub,
        paths.cache,
        options.env.HUMAN_PUBLIC_URL ||
          `http://${options.host}:${options.port}`,
        service,
        global,
      ),
  });
  const cliSessions = createSessionCommandExecutor({
    includeImages: false,
    isolateBinding: false,
    cwd: options.cwd,
    env: { ...options.env, HUMANBOARD_ACTOR: "cli" },
    eventBus: events,
    hooks,
    agentProvider,
    capture: (_request, global, service) =>
      captureCommandResult(
        frontendHub,
        paths.cache,
        options.env.HUMAN_PUBLIC_URL ||
          `http://${options.host}:${options.port}`,
        service,
        global,
      ),
  });
  const mcpApp = createMcpApp({
    host: options.host,
    port: options.port,
    basePath: "/",
    ...(options.env.HUMAN_ALLOWED_HOSTS
      ? {
          allowedHosts: options.env.HUMAN_ALLOWED_HOSTS.split(",").map((v) =>
            v.trim(),
          ),
        }
      : options.env.HUMAN_PUBLIC_URL
        ? {
            allowedHosts: [
              new URL(options.env.HUMAN_PUBLIC_URL).host,
              `127.0.0.1:${options.port}`,
              `localhost:${options.port}`,
            ],
          }
        : {}),
    ...(options.env.HUMAN_PUBLIC_URL
      ? { allowedOrigins: [new URL(options.env.HUMAN_PUBLIC_URL).origin] }
      : {}),
    ...(options.mcpAuth
      ? { auth: options.mcpAuth }
      : options.env.HUMAN_AUTH_TOKEN
        ? {
            auth: {
              token: options.env.HUMAN_AUTH_TOKEN,
              scopes: ["read", "write", "admin"] as const,
            },
          }
        : {}),
    execute: mcpSessions.execute,
  });
  const defaultService = await pool.getDefault();
  // Pending rows survive a process restart; reconstruct best-effort title work.
  void defaultService
    .pendingTitleCandidates()
    .then((pending) => {
      for (const layer of pending.layers)
        backgroundTitles.scheduleLayer(defaultService, layer);
      backgroundTitles.scheduleAssets(defaultService, pending.assets);
    })
    .catch(() => {});
  const projectSync = new ProjectSyncService(
    paths,
    defaultService,
    join(paths.home, "project-sync.json"),
  );
  await projectSync.start(options.syncPollMs ?? 10000);
  const syncScheduler = new CommitSyncScheduler({
    events,
    paths,
    debounceMs: options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS,
    shouldSync: (event) => projectSync.isEnabled(event.project_id),
    push: async (event, client) => {
      await projectSync.flush(event.project_id);
    },
  });
  let startedServer: RunningServer | undefined;
  try {
    const started = startServer({
      host: options.host,
      port: options.port,
      cacheDir: paths.cache,
      instanceId: runtimeInstanceId(paths),
      authToken: options.env.HUMAN_AUTH_TOKEN,
      publicUrl: options.env.HUMAN_PUBLIC_URL,
      ...(options.env.HUMAN_ALLOWED_HOSTS
        ? {
            allowedHosts: options.env.HUMAN_ALLOWED_HOSTS.split(",").map((v) =>
              v.trim(),
            ),
          }
        : {}),
      staticDir:
        options.staticDir ?? resolve(import.meta.dir, "../../canvas-ui/dist"),
      staticAssets:
        options.staticAssets ??
        (options.staticDir === undefined ? packagedStaticAssets() : undefined),
      frontendHub,
      mcpApp,
      setActiveLayer: async ({ space_id, layer_id }) => {
        const service = await pool.getDefault();
        const space = await service.setActiveLayer(space_id, layer_id);
        if (space.active_layer_id === null) {
          throw new HumanBoardError(
            "E_INTERNAL",
            "Active layer was not written",
            { space_id, layer_id },
          );
        }
        return {
          space_id: space.id,
          active_layer_id: space.active_layer_id,
        };
      },
      deleteLayer: async ({ space_id, layer_id }) =>
        (await pool.getDefault()).deleteLayer(space_id, layer_id),
      sync: {
        negotiate: (projectId, spaceId, have, refs) =>
          defaultService
            .getSyncService()
            .negotiate(projectId, spaceId, have, refs),
        pullLayer: (projectId, spaceId, layerId) =>
          defaultService
            .getSyncService()
            .pullLayer(projectId, spaceId, layerId),
        applyPush: (projectId, spaceId, payload) =>
          defaultService
            .getSyncService()
            .applyPush(projectId, spaceId, payload as SyncPushPayload),
        readBlob: (hash) => defaultService.getSyncService().readBlob(hash),
      },
      assets: {
        upload: (hash, data) => defaultService.stageAssetFile(hash, data),
        get: (id) => defaultService.getAsset(id),
        register: (input) => defaultService.registerFrontendAsset(input),
        image: (id) => defaultService.readAssetImage(id),
        rename: (id, title) => defaultService.renameAsset(id, title),
      },
      projectSync: {
        get: (projectId) => projectSync.get(projectId),
        set: (projectId, enabled) => projectSync.set(projectId, enabled),
      },
      agent: {
        setAutoTitle: async (enabled) => {
          const write = preferenceWrites.then(async () => {
            await writeFile(
              preferenceFile + ".tmp",
              JSON.stringify({ auto_title: enabled }) + "\n",
              { mode: 0o600 },
            );
            await rename(preferenceFile + ".tmp", preferenceFile);
            backgroundTitles.setEnabled(enabled);
          });
          preferenceWrites = write.catch(() => {});
          await write;
          if (enabled) {
            const pending = await defaultService.pendingTitleCandidates();
            for (const layer of pending.layers)
              backgroundTitles.scheduleLayer(defaultService, layer);
            backgroundTitles.scheduleAssets(defaultService, pending.assets);
          }
          return { auto_title: enabled };
        },
        status: async (input) =>
          defaultService
            .getAgentService()
            ?.status(input.project_id, input.space_id) ?? null,
        cancel: async (input) =>
          defaultService
            .getAgentService()
            ?.cancel(input.project_id, input.space_id) ?? { cancelled: false },
        setModels: async (body) => {
          await modelSettings.update(body);
          backgroundTitles.setModels(
            modelSettings.publicConfiguration(),
            modelSettings.provider("vision"),
            modelSettings.provider("text"),
          );
          if (backgroundTitles.status().enabled) {
            const pending = await defaultService.pendingTitleCandidates();
            for (const layer of pending.layers)
              backgroundTitles.scheduleLayer(defaultService, layer);
            backgroundTitles.scheduleAssets(defaultService, pending.assets);
          }
          return {
            ...modelSettings.publicConfiguration(),
            titles: backgroundTitles.status(),
          };
        },
        config: () => ({
          ...modelSettings.publicConfiguration(),
          titles: backgroundTitles.status(),
        }),
        history: async (input) => {
          const service = await pool.getDefault();
          return service.getAgentHistory(input.project_id, input.space_id);
        },
        chat: async (input) => {
          const service = await pool.getDefault();
          const agent = service.getAgentService();
          if (agent === null) {
            throw new HumanBoardError(
              "E_USAGE",
              "HUMAN_AGENT_MODEL is not configured",
              {
                feature: "agent_chat",
                model_unconfigured: true,
                env: "HUMAN_AGENT_MODEL",
                missing_env:
                  modelSettings.publicConfiguration().agent.missing_env,
              },
            );
          }
          const result = await agent.chat({
            projectId: input.project_id,
            spaceId: input.space_id,
            message: input.message,
            ...(input.base_layer_id === undefined
              ? {}
              : { baseLayerId: input.base_layer_id }),
          });
          if (!result.result_layer_id) void projectSync.flush(input.project_id);
          return result;
        },
      },
      events,
      execute: (request) =>
        request.cliSessionId
          ? cliSessions.execute({
              sessionId: `cli:${request.cliSessionId}`,
              argv: request.argv,
              stdin: request.stdin,
              cwd: request.cwd,
              fileBlobs: request.fileBlobs,
            })
          : request.sessionId
            ? webSessions.execute({
                sessionId: `web:${request.sessionId}`,
                ...(request.fileBlobs === undefined
                  ? {}
                  : { fileBlobs: request.fileBlobs }),
                argv: request.argv,
                stdin: request.stdin,
              })
            : executeApiCommand(pool, request, {
                capture: (_captureRequest, global, service) =>
                  captureCommandResult(
                    frontendHub,
                    paths.cache,
                    options.env.HUMAN_PUBLIC_URL ||
                      `http://${options.host}:${options.port}`,
                    service,
                    global,
                  ),
              }),
      watchHistory: (scope) =>
        defaultService.commitHistory(scope.space_id, scope.since_seq ?? 0),
      resolveWatch: async (query: WatchScopeQuery): Promise<WatchScope> => {
        const service = await pool.getDefault();
        return service.resolveWatchScope(
          {
            output: "json",
            ...(query.project === undefined ? {} : { project: query.project }),
            ...(query.space === undefined ? {} : { space: query.space }),
          },
          query.since,
        );
      },
    });
    startedServer = started;
    await writeLocalServerState(paths, started.url, process.pid);
    let serverStop: Promise<void> | undefined;
    const running: RunningServer = {
      app: started.app,
      server: started.server,
      url: started.url,
      stop(): Promise<void> {
        serverStop ??= (async () => {
          await projectSync.stop();
          await defaultService.getAgentService()?.stop();
          await started.stop();
          await clearLocalServerState(paths, started.url, process.pid);
          await preferenceWrites;
          await modelSettings.waitForWrites();
          await backgroundTitles.waitForIdle();
          await mcpSessions.close();
          await webSessions.close();
          await cliSessions.close();
        })();
        return serverStop;
      },
    };
    let runtimeStop: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      runtimeStop ??= (async () => {
        syncScheduler.dispose();
        await running.stop();
        await backgroundTitles.waitForIdle();
        await pool.closeAll();
      })();
      return runtimeStop;
    };
    return {
      running,
      pool,
      mcpSessions,
      events,
      syncScheduler,
      projectSync,
      frontendHub,
      url: running.url,
      stop,
    };
  } catch (error) {
    await startedServer?.stop();
    syncScheduler.dispose();
    await projectSync.stop();
    await mcpSessions.close();
    await webSessions.close();
    await cliSessions.close();
    await pool.closeAll();
    throw error;
  }
}

async function ensureLocalServer(
  options: WatchClientOptions,
  serverBase: URL,
): Promise<void> {
  if (options.autoStart && options.env.HUMANBOARD_NO_AUTO_START !== "1") {
    const command =
      options.cliCommand ??
      (options.cliEntry ? [process.execPath, options.cliEntry] : []);
    if (!command.length)
      throw new HumanBoardError(
        "E_CONNECT",
        "Cannot auto-start local HumanBoard server",
        { reason: "cli_entry_unavailable" },
      );
    const url = await ensureManagedLocalServer({
      env: options.env,
      cwd: options.cwd ?? process.cwd(),
      command,
      onAutoStart: options.onAutoStart,
    });
    serverBase.href = url.href;
    return;
  }
  const connection = await configuredServer(
    options.env,
    resolveRuntimePaths(options.env, options.cwd ?? process.cwd()),
  );
  const health = await checkServerHealth(serverBase, {
    token: connection.token,
    timeoutMs: 500,
  });
  if (!health.healthy)
    throw new HumanBoardError(
      health.reason === "auth" ? "E_AUTH" : "E_CONNECT",
      "Local HumanBoard server is not running",
      { reason: health.reason },
    );
}

export async function watchLocalServer(
  options: WatchClientOptions,
): Promise<number> {
  const connection = await configuredServer(
    options.env,
    resolveRuntimePaths(options.env, options.cwd ?? process.cwd()),
  );
  const configuredBase = connection.serverUrl;
  let serverBase: URL;
  try {
    serverBase = new URL(configuredBase);
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Invalid HUMANBOARD_SERVER_URL", {
      value: configuredBase,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  await ensureLocalServer(options, serverBase);
  const url = new URL("/api/watch", serverBase);
  if (options.project !== undefined) {
    url.searchParams.set("project", options.project);
  }
  if (options.space !== undefined) {
    url.searchParams.set("space", options.space);
  }
  if (options.since !== undefined) {
    url.searchParams.set("since", options.since);
  }
  if (options.all) {
    url.searchParams.set("all", "true");
  }
  url.searchParams.set("timeout", String(options.timeoutSeconds));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/x-ndjson",
        ...(connection.token
          ? { Authorization: `Bearer ${connection.token}` }
          : {}),
      },
    });
  } catch (error) {
    throw new HumanBoardError(
      "E_CONNECT",
      "Local HumanBoard server is not running",
      {
        url: url.href,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new HumanBoardError(
        "E_CONNECT",
        `Local server returned HTTP ${response.status}`,
        { url: url.href, status: response.status },
      );
    }
    throw errorFromPayload(payload);
  }
  if (!response.body) {
    throw new HumanBoardError(
      "E_CONNECT",
      "Local server returned no watch stream",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string): number | null => {
    if (line.trim().length === 0) {
      return null;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new HumanBoardError(
        "E_CONNECT",
        "Local server returned invalid NDJSON",
        { line },
      );
    }
    if (payload !== null && typeof payload === "object" && "error" in payload) {
      const error = errorFromPayload(payload);
      options.stderr(renderError(error, "json"));
      return error.exitCode;
    }
    options.stdout(`${line}\n`);
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const exitCode = handleLine(line);
        if (exitCode !== null) {
          await reader.cancel();
          return exitCode;
        }
      }
    }
  } catch (error) {
    if (error instanceof HumanBoardError) {
      throw error;
    }
    throw new HumanBoardError("E_CONNECT", "Watch stream was interrupted", {
      url: url.href,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const exitCode = handleLine(buffer);
    if (exitCode !== null) {
      return exitCode;
    }
  }
  return 0;
}

export async function captureLocalServer(options: {
  readonly env: Environment;
  readonly cwd?: string;
  readonly project?: string;
  readonly space?: string;
}): Promise<CommandExecutionResult> {
  const connection = await configuredServer(
    options.env,
    resolveRuntimePaths(options.env, options.cwd ?? process.cwd()),
  );
  const configuredBase = connection.serverUrl;
  let serverBase: URL;
  try {
    serverBase = new URL(configuredBase);
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Invalid HUMANBOARD_SERVER_URL", {
      value: configuredBase,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  await ensureLocalServer(
    {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      all: false,
      timeoutSeconds: 0,
      stdout: () => {},
      stderr: () => {},
      autoStart: false,
    },
    serverBase,
  );

  const argv = [
    ...(options.project === undefined ? [] : ["--project", options.project]),
    ...(options.space === undefined ? [] : ["--space", options.space]),
    "capture",
    "--json",
  ];
  let response: Response;
  try {
    response = await fetch(new URL("/api/command", serverBase), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
        ...(connection.token
          ? { Authorization: `Bearer ${connection.token}` }
          : {}),
      },
      body: JSON.stringify({
        argv,
        cli_session_id: connectedCliSessionId(
          options.env,
          options.cwd ?? process.cwd(),
        ),
        ...(connection.explicit ? {} : { cwd: options.cwd ?? process.cwd() }),
      }),
    });
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "HumanBoard server is not running", {
      url: serverBase.href,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HumanBoardError(
      "E_CONNECT",
      `HumanBoard server returned HTTP ${response.status}`,
      { url: serverBase.href, status: response.status },
    );
  }
  if (payload !== null && typeof payload === "object" && "error" in payload) {
    throw errorFromPayload(payload);
  }
  if (!response.ok) {
    throw new HumanBoardError(
      "E_CONNECT",
      `HumanBoard server returned HTTP ${response.status}`,
      { url: serverBase.href, status: response.status },
    );
  }
  return payload as CommandExecutionResult;
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolveSignal) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveSignal();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function runServe(
  options: ServerRuntimeOptions,
  output: (value: string) => void,
  mode: Exclude<OutputMode, "auto">,
): Promise<number> {
  if (
    !["127.0.0.1", "localhost", "::1"].includes(options.host) &&
    (!options.env.HUMAN_AUTH_TOKEN ||
      !options.env.HUMAN_PUBLIC_URL?.startsWith("https://"))
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Remote serve requires HUMAN_AUTH_TOKEN and an HTTPS HUMAN_PUBLIC_URL",
      { host: options.host, feature: "serve" },
    );
  }
  const runtime = await createServerRuntime(options);
  output(
    mode === "json"
      ? `${JSON.stringify({
          url: runtime.url,
          host: options.host,
          port: options.port,
        })}\n`
      : `HumanBoard listening on ${runtime.url}\n`,
  );
  try {
    await waitForShutdownSignal();
  } finally {
    await runtime.stop();
  }
  return 0;
}
