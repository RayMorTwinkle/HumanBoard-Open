import { createHash } from "node:crypto";

import {
  ERROR_EXIT_CODES,
  HumanBoardError,
  type HumanBoardErrorCode,
  type SyncApplyPushResult,
  type SyncBlobPayload,
  type SyncLayerPayload,
  type SyncNegotiateResult,
  type SyncPullResult,
  type SyncPushPayload,
  type SyncService,
  type SyncRefs,
} from "@humanboard/core-engine";

import { readServerConfig, type ServerConfig } from "./client-actions";
import type { RuntimePaths } from "./config";

export interface SyncTransport {
  negotiateRemote(
    projectId: string,
    spaceId: string,
    have: readonly string[],
    refs?: SyncRefs,
  ): Promise<SyncNegotiateResult>;
  pullRemoteLayer(
    projectId: string,
    spaceId: string,
    layerId: string,
  ): Promise<SyncPullResult>;
  pullRemoteBlob(hash: string): Promise<Uint8Array>;
  pushRemote(payload: SyncPushPayload): Promise<SyncApplyPushResult>;
}

export interface RemoteSyncClientOptions {
  readonly serverUrl: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetch?: SyncFetch;
}

export type SyncFetch = (input: URL, init?: RequestInit) => Promise<Response>;

// Measure serialized UTF-8 bytes, including base64 expansion, against the
// server's default JSON limit. Existing valid single requests remain valid.
export const MAX_SYNC_PUSH_BYTES = 50 * 1024 * 1024;

export function isMissingSyncScope(error: unknown): boolean {
  return (
    error instanceof HumanBoardError &&
    ["E_PROJECT_NOT_FOUND", "E_SPACE_NOT_FOUND"].includes(error.code)
  );
}

export interface LocalSyncProvider {
  getSyncService(): SyncService;
}

export interface LocalPushResult {
  readonly payload: SyncPushPayload;
  readonly response: SyncApplyPushResult;
}

export interface RemotePullResult {
  readonly negotiation: SyncNegotiateResult;
  readonly layers: readonly SyncLayerPayload[];
  readonly response: SyncApplyPushResult;
}

function isHumanBoardErrorCode(code: string): code is HumanBoardErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_EXIT_CODES, code);
}

function normalizeServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new HumanBoardError("E_CONNECT", "Invalid HumanBoard server URL", {
      server_url: value,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HumanBoardError("E_CONNECT", "Invalid HumanBoard server URL", {
      server_url: value,
      protocol: url.protocol,
    });
  }
  return url;
}

function blobHash(data: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

async function responseError(
  response: Response,
  url: URL,
): Promise<HumanBoardError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // Fall through to the status-based error below.
  }
  if (payload !== null && typeof payload === "object" && "error" in payload) {
    const raw = (payload as { error?: unknown }).error;
    if (raw !== null && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const rawCode =
        typeof record.code === "string" ? record.code : "E_CONNECT";
      const code = isHumanBoardErrorCode(rawCode) ? rawCode : "E_CONNECT";
      const details =
        record.details !== null &&
        typeof record.details === "object" &&
        !Array.isArray(record.details)
          ? (record.details as Record<string, unknown>)
          : {};
      return new HumanBoardError(
        code,
        typeof record.message === "string"
          ? record.message
          : `HumanBoard server returned HTTP ${response.status}`,
        { ...details, status: response.status, url: url.href },
      );
    }
  }
  const code =
    response.status === 401 || response.status === 403 ? "E_AUTH" : "E_CONNECT";
  return new HumanBoardError(
    code,
    `HumanBoard server returned HTTP ${response.status}`,
    { status: response.status, url: url.href },
  );
}

export class RemoteSyncClient implements SyncTransport {
  private readonly base: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: SyncFetch;

  constructor(options: RemoteSyncClientOptions) {
    this.base = normalizeServerUrl(options.serverUrl);
    this.token = options.token ?? "";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async negotiateRemote(
    projectId: string,
    spaceId: string,
    have: readonly string[],
    refs: SyncRefs = {},
  ): Promise<SyncNegotiateResult> {
    const response = await this.request("/sync/negotiate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        project_id: projectId,
        space_id: spaceId,
        have,
        refs,
      }),
    });
    return (await response.json()) as SyncNegotiateResult;
  }

  async pullRemoteLayer(
    projectId: string,
    spaceId: string,
    layerId: string,
  ): Promise<SyncPullResult> {
    const query = new URLSearchParams({
      project_id: projectId,
      space_id: spaceId,
    });
    const response = await this.request(
      `/layers/${encodeURIComponent(layerId)}?${query.toString()}`,
      { method: "GET" },
    );
    return (await response.json()) as SyncPullResult;
  }

  async pullRemoteBlob(hash: string): Promise<Uint8Array> {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new HumanBoardError("E_USAGE", "Invalid blob hash", { hash });
    }
    const response = await this.request(`/blobs/${hash}`, { method: "GET" });
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = blobHash(data);
    if (actual !== hash) {
      throw new HumanBoardError(
        "E_HASH_MISMATCH",
        `Blob ${hash} content hash does not match`,
        { expected: hash, actual },
      );
    }
    return data;
  }

  async pushRemote(payload: SyncPushPayload): Promise<SyncApplyPushResult> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) <= MAX_SYNC_PUSH_BYTES) {
      return this.postPush(body);
    }
    // Keep all Layers together: asset display-number remapping is per payload.
    // Blob-only pushes are content-addressed and safe to retry after interruption.
    const finalPayload = {
      ...payload,
      blobs: payload.blobs.map((blob) =>
        typeof blob === "string" ? blob : blob.hash,
      ),
    };
    const finalBody = JSON.stringify(finalPayload);
    const blobBodies = payload.blobs
      .filter((blob) => typeof blob !== "string")
      .map((blob) =>
        JSON.stringify({
          project_id: payload.project_id,
          space_id: payload.space_id,
          ...(payload.scope ? { scope: payload.scope } : {}),
          layers: [],
          blobs: [blob],
          meta: [],
        }),
      );
    // Check every part before sending anything, including non-blob metadata.
    if (
      [finalBody, ...blobBodies].some(
        (part) => Buffer.byteLength(part) > MAX_SYNC_PUSH_BYTES,
      )
    ) {
      throw new HumanBoardError(
        "E_USAGE",
        "A sync item exceeds the bounded request size",
        {
          max_bytes: MAX_SYNC_PUSH_BYTES,
        },
      );
    }
    for (const part of blobBodies) await this.postPush(part);
    return this.postPush(finalBody);
  }

  private async postPush(body: string): Promise<SyncApplyPushResult> {
    const response = await this.request("/sync/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body,
    });
    return (await response.json()) as SyncApplyPushResult;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.base);
    const headers = new Headers(init.headers);
    if (this.token.length > 0) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new HumanBoardError(
        "E_CONNECT",
        "Cannot connect to HumanBoard server",
        {
          url: url.href,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!response.ok) {
      throw await responseError(response, url);
    }
    return response;
  }
}

export async function remoteClientFromConfig(
  paths: RuntimePaths,
  options: {
    readonly timeoutMs?: number;
    readonly fetch?: SyncFetch;
  } = {},
): Promise<RemoteSyncClient | null> {
  const config = await readServerConfig(paths);
  if (config === null) {
    return null;
  }
  return new RemoteSyncClient({
    serverUrl: config.server_url,
    token: config.token,
    ...options,
  });
}

export function negotiateRemote(
  client: SyncTransport,
  projectId: string,
  spaceId: string,
  have: readonly string[],
  refs?: SyncRefs,
): Promise<SyncNegotiateResult> {
  return client.negotiateRemote(projectId, spaceId, have, refs);
}

export function pullRemoteLayer(
  client: SyncTransport,
  projectId: string,
  spaceId: string,
  layerId: string,
): Promise<SyncPullResult> {
  return client.pullRemoteLayer(projectId, spaceId, layerId);
}

export function pushRemote(
  client: SyncTransport,
  payload: SyncPushPayload,
): Promise<SyncApplyPushResult> {
  return client.pushRemote(payload);
}

export async function pushLocalToRemote(
  local: LocalSyncProvider,
  client: SyncTransport,
  projectId: string,
  spaceId: string,
): Promise<LocalPushResult> {
  const sync = local.getSyncService();
  const inventory = await sync.inventory(projectId, spaceId);
  const negotiate = () =>
    negotiateRemote(client, projectId, spaceId, [], {
      blobs: [],
      messages: inventory.message_ids ?? [],
    });
  let remote: SyncNegotiateResult;
  let initializedRemote = false;
  try {
    remote = await negotiate();
  } catch (error) {
    if (!isMissingSyncScope(error)) throw error;
    const localScope = (await sync.negotiate(projectId, spaceId, [])).scope;
    if (!localScope) throw error;
    await client.pushRemote({
      project_id: projectId,
      space_id: spaceId,
      scope: localScope,
      layers: [],
      blobs: [],
      meta: [],
    });
    // Older servers reject the bootstrap; never report success without verifying.
    remote = await negotiate();
    initializedRemote = true;
  }
  await sync.applyPush(projectId, spaceId, {
    project_id: projectId,
    space_id: spaceId,
    layers: [],
    blobs: [],
    meta: remote.meta,
    ...(remote.chat ? { chat: remote.chat } : {}),
  });
  const remoteLayerIds = new Set(remote.missing);
  const missingLayerIds = inventory.layer_ids.filter(
    (layerId) => !remoteLayerIds.has(layerId),
  );
  const payload = await sync.pushIncremental(
    projectId,
    spaceId,
    missingLayerIds,
    remote.blobs,
    remote.chat_have ?? [],
  );
  const response = await pushRemote(client, payload);
  if (
    initializedRemote &&
    response.rejected.length === 0 &&
    inventory.active_layer_id
  ) {
    await client.negotiateRemote(projectId, spaceId, [], {
      active: inventory.active_layer_id,
    });
  }
  return { payload, response };
}

export async function pullRemoteToLocal(
  local: LocalSyncProvider,
  client: SyncTransport,
  projectId: string,
  spaceId: string,
): Promise<RemotePullResult> {
  const sync = local.getSyncService();
  let inventory;
  let needsBootstrap = false;
  try {
    inventory = await sync.inventory(projectId, spaceId);
  } catch (error) {
    if (
      !(error instanceof HumanBoardError) ||
      !["E_PROJECT_NOT_FOUND", "E_SPACE_NOT_FOUND"].includes(error.code)
    )
      throw error;
    inventory = { layer_ids: [], blob_hashes: [], active_layer_id: null };
    needsBootstrap = true;
  }
  const negotiation = await negotiateRemote(
    client,
    projectId,
    spaceId,
    inventory.layer_ids,
    {
      active: inventory.active_layer_id,
      blobs: inventory.blob_hashes,
      messages: inventory.message_ids ?? [],
    },
  );

  const pulledLayers: SyncPullResult[] = [];
  for (const layerId of negotiation.missing) {
    pulledLayers.push(
      await pullRemoteLayer(client, projectId, spaceId, layerId),
    );
  }
  pulledLayers.sort(
    (left, right) =>
      left.layer.seq - right.layer.seq ||
      left.layer.id.localeCompare(right.layer.id),
  );

  const blobMap = new Map<`sha256:${string}`, SyncBlobPayload>();
  for (const hash of negotiation.blobs) {
    const data = await client.pullRemoteBlob(hash);
    blobMap.set(hash, {
      hash,
      data_base64: Buffer.from(data).toString("base64"),
    });
  }
  for (const pulled of pulledLayers) {
    for (const blob of pulled.blobs) {
      if (!blobMap.has(blob.hash)) {
        blobMap.set(blob.hash, blob);
      }
    }
  }

  const layers: SyncLayerPayload[] = pulledLayers.map((pulled) => ({
    layer: pulled.layer,
    scene: pulled.scene,
    assets: pulled.assets,
  }));
  const payload: SyncPushPayload = {
    project_id: projectId,
    space_id: spaceId,
    layers,
    blobs: [...blobMap.values()],
    meta: negotiation.meta,
    ...(negotiation.chat ? { chat: negotiation.chat } : {}),
  };
  if (needsBootstrap) {
    if (!negotiation.scope)
      throw new HumanBoardError(
        "E_CONNECT",
        "Remote server does not support first-replica metadata; update the remote server before pulling into an empty data directory",
      );
    await sync.bootstrapReplica(projectId, spaceId, negotiation.scope);
  }
  const response = await sync.applyPush(projectId, spaceId, payload);
  if (
    needsBootstrap &&
    response.rejected.length === 0 &&
    negotiation.refs.active
  ) {
    // Reuse the existing empty-focus reconciliation only after its Layer exists locally.
    await sync.negotiate(projectId, spaceId, [], {
      active: negotiation.refs.active,
    });
  }
  return { negotiation, layers, response };
}
