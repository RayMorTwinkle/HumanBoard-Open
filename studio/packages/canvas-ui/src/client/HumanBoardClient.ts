import type {
  ModelSettingsUpdate,
  ProjectSyncData,
  ActiveLayerResponse,
  AgentChatData,
  AgentRunData,
  AgentConfigData,
  AgentHistoryData,
  CaptureData,
  CommandEnvelope,
  CommitData,
  DiffData,
  DraftData,
  FrontendCapturePayload,
  FrontendCaptureRequest,
  FrontendCaptureResponse,
  FrontendSessionRegistration,
  GetData,
  HealthData,
  InspectData,
  LayersData,
  StatusData,
} from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HumanBoardClientOptions {
  readonly baseUrl?: string;
  readonly project?: string;
  readonly space?: string;
  readonly fetchImpl?: FetchLike;
  readonly sessionId?: string;
}

export interface DraftCommandOptions {
  readonly parent?: string;
  readonly redo?: boolean;
  readonly transform?: boolean;
  readonly file?: string;
  readonly merge?: string;
  readonly mergeStdin?: string;
}

export interface CommandOptions {
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export class HumanBoardClientError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly exitCode: number;

  constructor(
    code: string,
    message: string,
    options: {
      readonly details?: Readonly<Record<string, unknown>>;
      readonly exitCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "HumanBoardClientError";
    this.code = code;
    this.details = options.details ?? {};
    this.exitCode = options.exitCode ?? 1;
  }
}

export class HumanBoardClient {
  private readonly baseUrl: string;
  private project?: string;
  private space?: string;
  private readonly fetchImpl: FetchLike;
  private readonly sessionId?: string;

  constructor(options: HumanBoardClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.sessionId = options.sessionId;
    this.project = options.project;
    this.space = options.space;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async saveModelSettings(
    value: ModelSettingsUpdate,
  ): Promise<AgentConfigData> {
    const response = await this.fetchImpl(this.url("/api/agent/models"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(value),
    });
    const data = await response.json();
    if (!response.ok)
      throw new HumanBoardClientError(
        data.error?.code ?? "E_CONNECT",
        data.error?.message ?? "模型配置保存失败",
      );
    return data as AgentConfigData;
  }
  async setAutoTitle(enabled: boolean): Promise<void> {
    const response = await this.fetchImpl(this.url("/api/agent/settings"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ auto_title: enabled }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new HumanBoardClientError(
        data.error?.code ?? "E_CONNECT",
        data.error?.message ?? "设置保存失败",
      );
    }
  }
  async projectSync(
    projectId: string,
    enabled?: boolean,
  ): Promise<ProjectSyncData> {
    const response = await this.fetchImpl(
      this.url(
        `/api/sync/settings?project_id=${encodeURIComponent(projectId)}`,
      ),
      enabled === undefined
        ? {}
        : {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({
              project_id: projectId,
              cloud_sync: enabled,
            }),
          },
    );
    const data = await response.json();
    if (!response.ok)
      throw new HumanBoardClientError(
        data.error?.code ?? "E_CONNECT",
        data.error?.message ?? "同步设置读取失败",
      );
    return data as ProjectSyncData;
  }
  private url(path: string): string {
    return this.baseUrl.length === 0
      ? path
      : new URL(path, this.baseUrl).toString();
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Accept: "application/json",
      "X-HumanBoard-Client": "1",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private scopedArgs(): string[] {
    return [
      ...(this.project === undefined ? [] : ["--project", this.project]),
      ...(this.space === undefined ? [] : ["--space", this.space]),
    ];
  }

  async command<T>(
    argv: readonly string[],
    options: CommandOptions = {},
  ): Promise<T> {
    const args = [
      ...this.scopedArgs(),
      ...argv,
      ...(argv.includes("--json") ? [] : ["--json"]),
    ];
    let response: Response;
    try {
      response = await this.fetchImpl(this.url("/api/command"), {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          argv: args,
          ...(this.sessionId ? { session_id: this.sessionId } : {}),
          ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw new HumanBoardClientError("E_CONNECT", "无法连接 HumanBoard 服务", {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    let payload: CommandEnvelope<T> | null = null;
    try {
      payload = (await response.json()) as CommandEnvelope<T>;
    } catch {
      // The status below turns non-JSON middleware failures into E_CONNECT.
    }

    if (payload?.error) {
      throw new HumanBoardClientError(
        payload.error.code,
        payload.error.message,
        {
          details: payload.error.details,
          exitCode: payload.exitCode,
        },
      );
    }
    if (!response.ok) {
      throw new HumanBoardClientError(
        "E_CONNECT",
        `HumanBoard 服务返回 HTTP ${response.status}`,
        { details: { status: response.status }, exitCode: 6 },
      );
    }
    if (payload === null) {
      throw new HumanBoardClientError(
        "E_INTERNAL",
        "HumanBoard 服务返回了无效响应",
      );
    }
    if (payload.exitCode !== 0) {
      throw new HumanBoardClientError(
        "E_INTERNAL",
        payload.stderr?.trim() || "HumanBoard 命令执行失败",
        { exitCode: payload.exitCode },
      );
    }
    return payload.data as T;
  }

  async health(signal?: AbortSignal): Promise<HealthData> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url("/health"), {
        method: "GET",
        headers: this.headers(false),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new HumanBoardClientError("E_CONNECT", "HumanBoard 服务未启动", {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
    if (!response.ok) {
      throw new HumanBoardClientError(
        response.status === 401 || response.status === 403
          ? "E_AUTH"
          : "E_CONNECT",
        "HumanBoard 服务健康检查失败",
        {
          details: { status: response.status },
          exitCode: response.status === 401 || response.status === 403 ? 5 : 6,
        },
      );
    }
    let payload: Partial<HealthData>;
    try {
      payload = (await response.json()) as Partial<HealthData>;
    } catch {
      throw new HumanBoardClientError(
        "E_CONNECT",
        "HumanBoard 健康检查返回无效 JSON",
        { details: { status: response.status } },
      );
    }
    if (payload.ok !== true || payload.service !== "humanboard") {
      throw new HumanBoardClientError("E_CONNECT", "目标服务不是 HumanBoard", {
        details: { payload },
      });
    }
    return payload as HealthData;
  }

  setScope(project?: string, space?: string): void {
    this.project = project;
    this.space = space;
  }

  status(): Promise<StatusData> {
    return this.command<StatusData>(["status"]);
  }

  layers(): Promise<LayersData> {
    return this.command<LayersData>(["layers"]);
  }

  get(
    layer?: string,
    format: "ast" | "render" | "both" = "render",
    options: {
      readonly withStrokes?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<GetData> {
    return this.command<GetData>(
      [
        "get",
        ...(layer === undefined ? [] : [layer]),
        "--format",
        format,
        ...(options.withStrokes === true ? ["--with-strokes"] : []),
      ],
      { signal: options.signal },
    );
  }

  diff(
    layer?: string,
    compareTo?: string,
    visual?: boolean,
  ): Promise<DiffData> {
    return this.command<DiffData>([
      "diff",
      ...(layer === undefined ? [] : [layer]),
      ...(compareTo === undefined ? [] : [compareTo]),
      ...(visual === undefined ? [] : [visual ? "--visual" : "--no-visual"]),
    ]);
  }

  draft(options: DraftCommandOptions = {}): Promise<DraftData> {
    const argv = [
      "draft",
      ...(options.parent === undefined ? [] : ["--parent", options.parent]),
      ...(options.redo === true ? ["--redo"] : []),
      ...(options.transform === true ? ["--transform"] : []),
      ...(options.mergeStdin === undefined
        ? options.file === undefined
          ? []
          : ["--file", options.file]
        : ["--merge", "-"]),
      ...(options.mergeStdin === undefined && options.merge !== undefined
        ? ["--merge", options.merge]
        : []),
    ];
    return this.command<DraftData>(
      argv,
      options.mergeStdin === undefined ? {} : { stdin: options.mergeStdin },
    );
  }

  commit(draftId?: string, message?: string): Promise<CommitData> {
    return this.command<CommitData>([
      "commit",
      ...(draftId === undefined ? [] : [draftId]),
      ...(message === undefined ? [] : ["-m", message]),
    ]);
  }

  capture(): Promise<CaptureData> {
    return this.command<CaptureData>(["capture"]);
  }

  inspect(asset: string, layer?: string): Promise<InspectData> {
    return this.command<InspectData>([
      "inspect",
      asset,
      ...(layer === undefined ? [] : ["--layer", layer]),
    ]);
  }

  async registerFrontendSession(
    projectId: string,
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<FrontendSessionRegistration> {
    return this.frontendRequest<FrontendSessionRegistration>(
      "/api/frontend/session",
      {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          space_id: spaceId,
        }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async waitForCaptureRequest(
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FrontendCaptureRequest | null> {
    const params = new URLSearchParams({
      session_id: sessionId,
      timeout: String(timeoutMs),
    });
    const payload = await this.frontendRequest<{
      readonly request: FrontendCaptureRequest | null;
    }>(`/api/frontend/requests?${params.toString()}`, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    return payload.request;
  }

  async respondCapture(
    sessionId: string,
    requestId: string,
    payload: FrontendCapturePayload,
    signal?: AbortSignal,
  ): Promise<FrontendCaptureResponse> {
    return this.frontendRequest<FrontendCaptureResponse>(
      "/api/frontend/response",
      {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          request_id: requestId,
          ...payload,
        }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async setActiveLayer(
    spaceId: string,
    layerId: string,
    signal?: AbortSignal,
  ): Promise<ActiveLayerResponse> {
    return this.frontendRequest<ActiveLayerResponse>(
      "/api/frontend/active-layer",
      {
        method: "POST",
        body: JSON.stringify({
          space_id: spaceId,
          layer_id: layerId,
        }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  /** Human-only history cleanup; the route has no CLI or agent counterpart. */
  async deleteLayer(
    spaceId: string,
    layerId: string,
  ): Promise<{ deleted: string[]; active_layer_id: string | null }> {
    return this.frontendRequest("/api/frontend/delete-layer", {
      method: "POST",
      body: JSON.stringify({ space_id: spaceId, layer_id: layerId }),
    });
  }

  async assetMetadata(
    id: string,
  ): Promise<Partial<import("./types").AssetManifestItem>> {
    return this.frontendRequest(`/api/assets/${encodeURIComponent(id)}`, {
      method: "GET",
    });
  }

  async renameAsset(id: string, title: string): Promise<void> {
    await this.frontendRequest(`/api/assets/${encodeURIComponent(id)}/title`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  async registerAsset(input: {
    project_id: string;
    space_id: string;
    name?: string;
    data_base64?: string;
    url?: string;
  }): Promise<
    import("./types").AssetManifestItem & { width: number; height: number }
  > {
    return this.frontendRequest("/api/assets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async agentConfig(signal?: AbortSignal): Promise<AgentConfigData> {
    return this.frontendRequest<AgentConfigData>("/api/agent/config", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async agentHistory(
    projectId: string,
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<AgentHistoryData> {
    const params = new URLSearchParams({
      project_id: projectId,
      space_id: spaceId,
    });
    return this.frontendRequest<AgentHistoryData>(
      `/api/agent/history?${params.toString()}`,
      {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async agentRun(
    project: string,
    space: string,
  ): Promise<{ run: AgentRunData | null }> {
    return this.frontendRequest(
      `/api/agent/run?${new URLSearchParams({ project_id: project, space_id: space })}`,
      { method: "GET" },
    );
  }
  async cancelAgent(
    project: string,
    space: string,
  ): Promise<{ cancelled: boolean }> {
    return this.frontendRequest("/api/agent/cancel", {
      method: "POST",
      body: JSON.stringify({ project_id: project, space_id: space }),
    });
  }

  async agentChat(
    input: {
      readonly project_id: string;
      readonly space_id: string;
      readonly message: string;
      readonly base_layer_id?: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentChatData> {
    return this.frontendRequest<AgentChatData>("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async frontendRequest<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: {
          ...this.headers(init.body !== undefined),
          ...(init.headers === undefined
            ? {}
            : Object.fromEntries(new Headers(init.headers).entries())),
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new HumanBoardClientError(
        "E_CONNECT",
        "无法连接 HumanBoard 前端会话",
        {
          details: {
            cause: error instanceof Error ? error.message : String(error),
          },
        },
      );
    }
    let payload: {
      readonly error?: {
        readonly code: string;
        readonly message: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    } & T;
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new HumanBoardClientError(
        "E_CONNECT",
        `HumanBoard 前端会话返回 HTTP ${response.status}`,
        { details: { status: response.status } },
      );
    }
    if (payload.error) {
      throw new HumanBoardClientError(
        payload.error.code,
        payload.error.message,
        { details: payload.error.details },
      );
    }
    if (!response.ok) {
      throw new HumanBoardClientError(
        "E_CONNECT",
        `HumanBoard 前端会话返回 HTTP ${response.status}`,
        { details: { status: response.status } },
      );
    }
    return payload;
  }
}

export function renderUrlForBrowser(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "file:") {
    return url;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const renderIndex = segments.lastIndexOf("renders");
  if (renderIndex !== -1 && renderIndex < segments.length - 1) {
    return `/render/${segments
      .slice(renderIndex + 1)
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }
  const inspectIndex = segments.lastIndexOf("inspect");
  if (inspectIndex !== -1 && inspectIndex < segments.length - 1) {
    return `/inspect/${segments
      .slice(inspectIndex + 1)
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }
  if (renderIndex === -1 && inspectIndex === -1) {
    return url;
  }
  return url;
}
