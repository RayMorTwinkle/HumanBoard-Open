import {
  SceneSchema,
  UlidSchema,
  sceneContentHash,
  type AssetRef,
  type Scene,
} from "@humanboard/schema";
import {
  importSyncChat,
  readSyncChat,
  type SyncChatPayload,
} from "./chat-sync";
export type { SyncChatPayload } from "./chat-sync";

import { HumanBoardError } from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/ports";
import { SystemClock, UlidGenerator } from "../domain/ports";
import type {
  Asset,
  Layer,
  MetaField,
  MetaFieldInput,
  MetaMergeConflict,
  NewLayerRecord,
  Project,
  Space,
  ULID,
} from "../domain/types";
import { OWNER_ID } from "../domain/types";
import type { BlobAdapter } from "../storage/blob-adapter";
import type { StorageAdapter } from "../storage/storage-adapter";

export interface SyncRefs {
  readonly messages?: readonly string[];
  readonly active?: ULID | null;
  readonly blobs?: readonly string[];
}

export interface SyncBlobPayload {
  readonly hash: `sha256:${string}`;
  readonly data_base64: string;
}

export interface SyncLayerPayload {
  readonly layer: Layer;
  readonly scene: Scene;
  readonly assets: readonly Asset[];
}

export interface SyncPullResult extends SyncLayerPayload {
  readonly project_id: ULID;
  readonly space_id: ULID;
  readonly blobs: readonly SyncBlobPayload[];
}

export interface SyncPushPayload {
  /** Identity-preserving bootstrap for a new remote Project / Space. */
  readonly scope?: NonNullable<SyncNegotiateResult["scope"]>;
  readonly chat?: SyncChatPayload;
  readonly project_id: ULID;
  readonly space_id: ULID;
  readonly layers: readonly SyncLayerPayload[];
  readonly blobs: readonly (SyncBlobPayload | string)[];
  readonly meta: readonly MetaFieldInput[];
}

export type SyncMetaField = MetaFieldInput;
export type SyncMetaConflict = MetaMergeConflict;

export interface SyncNegotiateResult {
  readonly chat?: SyncChatPayload;
  readonly chat_have?: readonly string[];
  readonly scope?: { readonly project: Project; readonly space: Space };
  readonly missing: readonly ULID[];
  readonly blobs: readonly `sha256:${string}`[];
  readonly refs: {
    readonly active: ULID | null;
  };
  readonly meta: readonly SyncMetaField[];
}

export interface SyncInventory {
  readonly message_ids?: readonly string[];
  readonly layer_ids: readonly ULID[];
  readonly blob_hashes: readonly `sha256:${string}`[];
  readonly active_layer_id: ULID | null;
}

export interface SyncRejectedLayer {
  readonly layer_id: string;
  readonly code: string;
  readonly message: string;
}

export interface SyncSeqMapEntry {
  readonly from: number;
  readonly to: number;
}

export interface SyncWarning {
  readonly code: "W_SEQ_REASSIGNED";
  readonly message: string;
  readonly layer_id: string;
  readonly from: number;
  readonly to: number;
}

export interface SyncApplyPushResult {
  readonly messages_imported?: number;
  readonly accepted: readonly ULID[];
  readonly rejected: readonly SyncRejectedLayer[];
  readonly seq_map: Readonly<Record<string, SyncSeqMapEntry>>;
  readonly meta_conflicts: readonly SyncMetaConflict[];
  readonly warnings: readonly SyncWarning[];
}

export interface SyncServiceOptions {
  readonly storage: StorageAdapter;
  readonly blobs: BlobAdapter;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

interface MaterializedScene {
  readonly scene: Scene;
  readonly changed: boolean;
}

function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function base64ToBytes(data: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch (error) {
    throw new HumanBoardError("E_USAGE", "Invalid base64 blob payload", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function isHash(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function wireMeta(field: MetaField): SyncMetaField {
  return {
    field: field.field,
    value: field.value,
    lamport: field.lamport,
    device_id: field.device_id,
  };
}

function requireMeta(value: unknown, spaceId: ULID): SyncMetaField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HumanBoardError("E_USAGE", "Invalid meta register");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.space_id !== undefined && record.space_id !== spaceId) ||
    typeof record.field !== "string" ||
    record.field.length === 0 ||
    typeof record.value !== "string" ||
    !Number.isSafeInteger(record.lamport) ||
    (record.lamport as number) < 1 ||
    typeof record.device_id !== "string" ||
    record.device_id.length === 0
  ) {
    throw new HumanBoardError("E_USAGE", "Invalid meta register", {
      field: record.field,
      space_id: record.space_id,
    });
  }
  return {
    field: record.field,
    value: record.value,
    lamport: record.lamport as number,
    device_id: record.device_id,
  };
}

function requireLayer(value: unknown): Layer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HumanBoardError("E_USAGE", "Sync layer must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.space_id !== "string" ||
    !Number.isInteger(record.seq) ||
    (typeof record.parent_id !== "string" && record.parent_id !== null) ||
    typeof record.kind !== "string" ||
    typeof record.title !== "string" ||
    typeof record.title_source !== "string" ||
    typeof record.created_at !== "string" ||
    record.author === null ||
    typeof record.author !== "object" ||
    !Number.isInteger(record.schema_version) ||
    !isHash(record.content_hash) ||
    typeof record.owner_id !== "string"
  ) {
    throw new HumanBoardError("E_USAGE", "Invalid sync layer payload");
  }
  return record as unknown as Layer;
}

function requireAsset(value: unknown): Asset {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HumanBoardError("E_USAGE", "Sync asset must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.asset_id !== "string" ||
    typeof record.space_id !== "string" ||
    typeof record.display_no !== "string" ||
    (record.type !== "image" && record.type !== "url") ||
    typeof record.title !== "string" ||
    (record.description !== undefined &&
      (typeof record.description !== "string" ||
        Array.from(record.description).length > 240)) ||
    (record.title_source !== null &&
      record.title_source !== "agent" &&
      record.title_source !== "human" &&
      record.title_source !== "builtin" &&
      record.title_source !== "pending") ||
    (record.blob_hash !== null && !isHash(record.blob_hash)) ||
    (record.source_url !== null && typeof record.source_url !== "string") ||
    typeof record.owner_id !== "string" ||
    typeof record.created_at !== "string"
  ) {
    throw new HumanBoardError("E_USAGE", "Invalid sync asset payload");
  }
  return record as unknown as Asset;
}

function parseScene(value: unknown): Scene {
  try {
    return SceneSchema.parse(value);
  } catch (error) {
    throw new HumanBoardError("E_USAGE", "Invalid sync Scene payload", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export class SyncService {
  private readonly storage: StorageAdapter;
  private readonly blobs: BlobAdapter;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(options: SyncServiceOptions) {
    this.storage = options.storage;
    this.blobs = options.blobs;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new UlidGenerator(this.clock);
  }

  async inventory(projectId: ULID, spaceId: ULID): Promise<SyncInventory> {
    const space = await this.requireSpace(projectId, spaceId);
    const layers = await this.storage.listLayers(spaceId);
    const blobHashes = new Set<`sha256:${string}`>();
    for (const layer of layers) {
      const scene = await this.storage.getLayerScene(layer.id);
      if (!scene) {
        throw new HumanBoardError(
          "E_INTERNAL",
          `Layer ${layer.id} has no stored Scene`,
        );
      }
      for (const asset of await this.assetsForScene(spaceId, scene)) {
        if (asset.blob_hash !== null) {
          blobHashes.add(asset.blob_hash);
        }
      }
    }
    return {
      layer_ids: layers.map((layer) => layer.id),
      message_ids: (await readSyncChat(this.storage, projectId, spaceId)).have,
      blob_hashes: [...blobHashes].sort(),
      active_layer_id: space.active_layer_id,
    };
  }

  /** Create missing replica containers with the original IDs; never invent a root Layer. */
  async bootstrapReplica(
    projectId: ULID,
    spaceId: ULID,
    scope: NonNullable<SyncNegotiateResult["scope"]>,
  ): Promise<void> {
    const project = scope?.project,
      space = scope?.space;
    if (
      !project ||
      !space ||
      !UlidSchema.safeParse(projectId).success ||
      !UlidSchema.safeParse(spaceId).success ||
      project.id !== projectId ||
      space.id !== spaceId ||
      space.project_id !== projectId ||
      [project, space].some(
        (v) =>
          typeof v.name !== "string" ||
          !v.name.trim() ||
          typeof v.created_at !== "string" ||
          !Number.isFinite(Date.parse(v.created_at)),
      )
    ) {
      throw new HumanBoardError(
        "E_USAGE",
        "Remote replica scope is invalid or does not match the requested identities",
      );
    }
    const existingSpace = await this.storage.getSpace(spaceId);
    if (existingSpace && existingSpace.project_id !== projectId)
      throw new HumanBoardError(
        "E_USAGE",
        "Replica Space already belongs to another Project",
      );
    if (!(await this.storage.getProject(projectId)))
      await this.storage.createProject({
        id: projectId,
        name: project.name,
        root: null,
        owner_id: OWNER_ID,
        created_at: project.created_at,
      });
    if (!existingSpace)
      await this.storage.createSpace({
        id: spaceId,
        project_id: projectId,
        name: space.name,
        active_layer_id: null,
        owner_id: OWNER_ID,
        created_at: space.created_at,
      });
  }

  async negotiate(
    projectId: ULID,
    spaceId: ULID,
    have: readonly ULID[],
    refs: SyncRefs = {},
  ): Promise<SyncNegotiateResult> {
    if (
      refs.active !== undefined &&
      refs.active !== null &&
      typeof refs.active !== "string"
    ) {
      throw new HumanBoardError("E_USAGE", "Invalid active Layer ref");
    }
    const requestedSpace = await this.requireSpace(projectId, spaceId);
    const space = await this.reconcileActiveRef(requestedSpace, refs.active);
    const haveSet = new Set(have);
    const localLayers = await this.storage.listLayers(spaceId);
    const missingLayers = localLayers.filter((layer) => !haveSet.has(layer.id));
    const availableBlobs = new Set(refs.blobs ?? []);
    const missingBlobs = new Set<`sha256:${string}`>();

    for (const layer of missingLayers) {
      const scene = await this.storage.getLayerScene(layer.id);
      if (!scene) {
        throw new HumanBoardError(
          "E_INTERNAL",
          `Layer ${layer.id} has no stored Scene`,
        );
      }
      for (const asset of await this.assetsForScene(spaceId, scene)) {
        if (asset.blob_hash !== null && !availableBlobs.has(asset.blob_hash)) {
          missingBlobs.add(asset.blob_hash);
        }
      }
    }

    const chat = await readSyncChat(
      this.storage,
      projectId,
      spaceId,
      refs.messages,
    );
    return {
      ...(chat.chat ? { chat: chat.chat } : {}),
      chat_have: chat.have,
      missing: missingLayers.map((layer) => layer.id),
      scope: {
        project: { ...(await this.storage.getProject(projectId))!, root: null },
        space,
      },
      blobs: [...missingBlobs].sort(),
      refs: { active: space.active_layer_id },
      meta: (await this.storage.listMetaFields(spaceId)).map(wireMeta),
    };
  }

  async pullLayer(
    projectId: ULID,
    spaceId: ULID,
    layerId: ULID,
  ): Promise<SyncPullResult> {
    await this.requireSpace(projectId, spaceId);
    const layer = await this.storage.getLayer(layerId);
    if (!layer || layer.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${layerId} does not exist in Space ${spaceId}`,
        { layer_id: layerId, space_id: spaceId },
      );
    }
    const payload = await this.layerPayload(layer);
    return {
      project_id: projectId,
      space_id: spaceId,
      ...payload,
      blobs: await this.blobsForAssets(payload.assets),
    };
  }

  async push(
    projectId: ULID,
    spaceId: ULID,
    layerIds: readonly ULID[],
  ): Promise<SyncPushPayload> {
    return this.buildPush(projectId, spaceId, layerIds, {
      allIfEmpty: true,
      knownRemoteBlobHashes: [],
    });
  }

  async pushIncremental(
    projectId: ULID,
    spaceId: ULID,
    layerIds: readonly ULID[],
    knownRemoteBlobHashes: readonly string[] = [],
    knownRemoteMessageIds: readonly string[] = [],
  ): Promise<SyncPushPayload> {
    return this.buildPush(projectId, spaceId, layerIds, {
      allIfEmpty: false,
      knownRemoteBlobHashes,
      knownRemoteMessageIds,
    });
  }

  private async buildPush(
    projectId: ULID,
    spaceId: ULID,
    layerIds: readonly ULID[],
    options: {
      readonly allIfEmpty: boolean;
      readonly knownRemoteBlobHashes: readonly string[];
      readonly knownRemoteMessageIds?: readonly string[];
    },
  ): Promise<SyncPushPayload> {
    await this.requireSpace(projectId, spaceId);
    const allLayers = await this.storage.listLayers(spaceId);
    const selected =
      layerIds.length === 0
        ? options.allIfEmpty
          ? allLayers
          : []
        : layerIds.map((id) => {
            const layer = allLayers.find((item) => item.id === id);
            if (!layer) {
              throw new HumanBoardError(
                "E_LAYER_NOT_FOUND",
                `Layer ${id} does not exist in Space ${spaceId}`,
                { layer_id: id, space_id: spaceId },
              );
            }
            return layer;
          });

    const knownRemoteBlobs = new Set(
      options.knownRemoteBlobHashes.filter(isHash),
    );
    const layers: SyncLayerPayload[] = [];
    const blobMap = new Map<
      `sha256:${string}`,
      SyncBlobPayload | `sha256:${string}`
    >();
    for (const layer of selected) {
      const payload = await this.layerPayload(layer);
      layers.push(payload);
      for (const asset of payload.assets) {
        if (asset.blob_hash === null || blobMap.has(asset.blob_hash)) {
          continue;
        }
        if (knownRemoteBlobs.has(asset.blob_hash)) {
          blobMap.set(asset.blob_hash, asset.blob_hash);
          continue;
        }
        blobMap.set(asset.blob_hash, {
          hash: asset.blob_hash,
          data_base64: bytesToBase64(
            await this.blobs.readBlob(asset.blob_hash),
          ),
        });
      }
    }
    const chat = await readSyncChat(
      this.storage,
      projectId,
      spaceId,
      options.knownRemoteMessageIds,
    );
    return {
      ...(chat.chat ? { chat: chat.chat } : {}),
      project_id: projectId,
      space_id: spaceId,
      layers,
      blobs: [...blobMap.values()],
      meta: (await this.storage.listMetaFields(spaceId)).map(wireMeta),
    };
  }

  async applyPush(
    projectId: ULID,
    spaceId: ULID,
    payload: SyncPushPayload,
  ): Promise<SyncApplyPushResult> {
    if (payload.project_id !== projectId || payload.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_USAGE",
        "Sync payload scope does not match the target Space",
        {
          payload_project_id: payload.project_id,
          payload_space_id: payload.space_id,
          project_id: projectId,
          space_id: spaceId,
        },
      );
    }
    const incomingMeta = payload.meta.map((field) =>
      requireMeta(field, spaceId),
    );
    if (payload.scope) {
      await this.bootstrapReplica(projectId, spaceId, payload.scope);
    }
    await this.requireSpace(projectId, spaceId);

    for (const blob of payload.blobs) {
      if (typeof blob === "string") {
        await this.blobs.readBlob(blob);
        continue;
      }
      if (!isHash(blob.hash)) {
        throw new HumanBoardError(
          "E_HASH_MISMATCH",
          "Invalid blob hash in sync payload",
          { hash: blob.hash },
        );
      }
      const actual = await this.blobs.writeBlob(
        base64ToBytes(blob.data_base64),
      );
      if (actual !== blob.hash) {
        throw new HumanBoardError(
          "E_HASH_MISMATCH",
          `Blob ${blob.hash} content hash does not match`,
          { expected: blob.hash, actual },
        );
      }
    }

    const localLayers = await this.storage.listLayers(spaceId);
    let maxSeq = localLayers.reduce(
      (current, layer) => Math.max(current, layer.seq),
      0,
    );
    const knownLayerIds = new Set(localLayers.map((layer) => layer.id));
    const assetMap = new Map<string, Asset>();
    const accepted: ULID[] = [];
    const rejected: SyncRejectedLayer[] = [];
    const seqMap: Record<string, SyncSeqMapEntry> = {};
    const warnings: SyncWarning[] = [];
    const seenLayerIds = new Set<string>();

    // seq is device-local and may no longer describe DAG topology after a sync.
    const pending = [...payload.layers].sort(
      (a, b) => (a?.layer?.seq ?? 0) - (b?.layer?.seq ?? 0),
    );
    const remaining = new Set(pending.map((item) => item?.layer?.id));
    const ordered: typeof pending = [];
    while (pending.length) {
      let index = pending.findIndex(
        (item) =>
          !item?.layer?.parent_id || !remaining.has(item.layer.parent_id),
      );
      // Cycles reach validation and are rejected as unavailable parents.
      if (index < 0) index = 0;
      const [item] = pending.splice(index, 1);
      remaining.delete(item!.layer?.id);
      ordered.push(item!);
    }

    for (const rawLayer of ordered) {
      let layer: Layer;
      try {
        layer = requireLayer(rawLayer.layer);
      } catch (error) {
        rejected.push({
          layer_id:
            rawLayer.layer !== null &&
            typeof rawLayer.layer === "object" &&
            "id" in rawLayer.layer &&
            typeof rawLayer.layer.id === "string"
              ? rawLayer.layer.id
              : "unknown",
          code: "E_USAGE",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      let scene: Scene;
      try {
        scene = parseScene(rawLayer.scene);
      } catch (error) {
        rejected.push({
          layer_id: layer.id,
          code: "E_USAGE",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const actualHash = sceneContentHash(scene);
      if (actualHash !== layer.content_hash) {
        rejected.push({
          layer_id: layer.id,
          code: "E_HASH_MISMATCH",
          message: `Layer ${layer.id} content_hash does not match its Scene`,
        });
        continue;
      }

      if (seenLayerIds.has(layer.id)) {
        rejected.push({
          layer_id: layer.id,
          code: "E_USAGE",
          message: "Duplicate Layer in sync payload",
        });
        continue;
      }
      seenLayerIds.add(layer.id);

      if (layer.space_id !== spaceId) {
        rejected.push({
          layer_id: layer.id,
          code: "E_LAYER_NOT_FOUND",
          message: `Layer ${layer.id} belongs to another Space`,
        });
        continue;
      }

      const existing = await this.storage.getLayer(layer.id);
      if (existing) {
        let sameContent: boolean;
        try {
          sameContent = await this.existingLayerMatchesIncoming(
            existing,
            scene,
            rawLayer.assets,
          );
        } catch (error) {
          rejected.push({
            layer_id: layer.id,
            code: error instanceof HumanBoardError ? error.code : "E_INTERNAL",
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (
          !sameContent ||
          existing.parent_id !== layer.parent_id ||
          existing.kind !== layer.kind ||
          existing.redo_of !== layer.redo_of
        ) {
          rejected.push({
            layer_id: layer.id,
            code: "E_HASH_MISMATCH",
            message: `Layer ${layer.id} already exists with different content`,
          });
          continue;
        }
        accepted.push(layer.id);
        continue;
      }

      if (layer.parent_id !== null && !knownLayerIds.has(layer.parent_id)) {
        rejected.push({
          layer_id: layer.id,
          code: "E_LAYER_NOT_FOUND",
          message: `Parent Layer ${layer.parent_id} is not available`,
        });
        continue;
      }

      let materialized: MaterializedScene;
      try {
        materialized = await this.materializeAssets(
          spaceId,
          rawLayer.assets,
          scene,
          assetMap,
        );
      } catch (error) {
        rejected.push({
          layer_id: layer.id,
          code:
            error instanceof HumanBoardError ? error.code : "E_ASSET_NOT_FOUND",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const desiredSeq = layer.seq;
      const localSeq = maxSeq + 1;
      const reassign = desiredSeq !== localSeq;
      const nextLayer: NewLayerRecord = {
        ...layer,
        seq_origin: reassign ? desiredSeq : (layer.seq_origin ?? null),
        owner_id: OWNER_ID,
        content_hash: sceneContentHash(
          materialized.scene,
        ) as `sha256:${string}`,
      };

      try {
        const stored = await this.storage.appendLayerAtSeq(
          { layer: nextLayer, scene: materialized.scene },
          localSeq,
        );
        accepted.push(stored.id);
        knownLayerIds.add(stored.id);
        maxSeq = Math.max(maxSeq, stored.seq);
        if (reassign) {
          seqMap[stored.id] = { from: desiredSeq, to: stored.seq };
          warnings.push({
            code: "W_SEQ_REASSIGNED",
            message: `Layer ${stored.id} was reassigned from seq ${desiredSeq} to ${stored.seq}`,
            layer_id: stored.id,
            from: desiredSeq,
            to: stored.seq,
          });
        }
      } catch (error) {
        rejected.push({
          layer_id: layer.id,
          code: error instanceof HumanBoardError ? error.code : "E_INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const metaResult = await this.storage.mergeMetaFields(
      spaceId,
      incomingMeta.map((field) => {
        const match = /^asset\.([^.]+)\.(.+)$/.exec(field.field);
        const mapped = match ? assetMap.get(match[1]!) : undefined;
        return mapped && match
          ? { ...field, field: `asset.${mapped.asset_id}.${match[2]}` }
          : field;
      }),
    );
    const imported = payload.chat
      ? await importSyncChat(this.storage, projectId, spaceId, payload.chat)
      : undefined;
    return {
      ...(imported === undefined ? {} : { messages_imported: imported }),
      accepted,
      rejected,
      seq_map: seqMap,
      meta_conflicts: metaResult.conflicts,
      warnings,
    };
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    return this.blobs.readBlob(hash);
  }

  private async requireSpace(projectId: ULID, spaceId: ULID): Promise<Space> {
    const project = await this.storage.getProject(projectId);
    if (!project) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${projectId} does not exist`,
        { project_id: projectId },
      );
    }
    const space = await this.storage.getSpace(spaceId);
    if (!space || space.project_id !== projectId) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist in Project ${projectId}`,
        { project_id: projectId, space_id: spaceId },
      );
    }
    return space;
  }

  private async reconcileActiveRef(
    space: Space,
    incomingActive: ULID | null | undefined,
  ): Promise<Space> {
    // A ref is a focus hint, not a merge register: fill an empty local ref,
    // but never move an existing human focus.
    if (incomingActive === undefined || incomingActive === null) {
      return space;
    }
    if (space.active_layer_id !== null) {
      return space;
    }
    const layer = await this.storage.getLayer(incomingActive);
    if (!layer || layer.space_id !== space.id) {
      return space;
    }
    return this.storage.setSpaceActiveLayer(space.id, incomingActive);
  }

  private async existingLayerMatchesIncoming(
    existing: Layer,
    incomingScene: Scene,
    rawAssets: readonly unknown[],
  ): Promise<boolean> {
    if (sceneContentHash(incomingScene) === existing.content_hash) {
      return true;
    }

    const existingScene = await this.storage.getLayerScene(existing.id);
    if (!existingScene) {
      return false;
    }
    if (existingScene.assets.length !== incomingScene.assets.length) {
      return false;
    }

    const incomingAssets = new Map<string, Asset>();
    for (const rawAsset of rawAssets) {
      const asset = requireAsset(rawAsset);
      if (incomingAssets.has(asset.asset_id)) {
        return false;
      }
      incomingAssets.set(asset.asset_id, asset);
    }

    const unmatched = [...existingScene.assets];
    const remapped: AssetRef[] = [];
    for (const incomingRef of incomingScene.assets) {
      const incomingAsset = incomingAssets.get(incomingRef.asset_id);
      if (!incomingAsset) {
        return false;
      }

      let matchIndex = -1;
      for (let index = 0; index < unmatched.length; index += 1) {
        const localRef = unmatched[index]!;
        if (
          localRef.z !== incomingRef.z ||
          localRef.rect.x !== incomingRef.rect.x ||
          localRef.rect.y !== incomingRef.rect.y ||
          localRef.rect.w !== incomingRef.rect.w ||
          localRef.rect.h !== incomingRef.rect.h
        ) {
          continue;
        }
        const localAsset = await this.storage.getAsset(localRef.asset_id);
        if (
          localAsset !== null &&
          localAsset.space_id === existing.space_id &&
          localAsset.type === incomingAsset.type &&
          localAsset.blob_hash === incomingAsset.blob_hash &&
          localAsset.source_url === incomingAsset.source_url
        ) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) {
        return false;
      }
      remapped.push(unmatched[matchIndex]!);
      unmatched.splice(matchIndex, 1);
    }

    const equivalent = SceneSchema.parse({
      ...incomingScene,
      assets: remapped,
    });
    return sceneContentHash(equivalent) === existing.content_hash;
  }

  private async layerPayload(layer: Layer): Promise<SyncLayerPayload> {
    const scene = await this.storage.getLayerScene(layer.id);
    if (!scene) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Layer ${layer.id} has no stored Scene`,
      );
    }
    return {
      layer,
      scene,
      assets: await this.assetsForScene(layer.space_id, scene),
    };
  }

  private async assetsForScene(spaceId: ULID, scene: Scene): Promise<Asset[]> {
    const assets = new Map<ULID, Asset>();
    for (const ref of scene.assets) {
      if (assets.has(ref.asset_id)) {
        continue;
      }
      const asset = await this.storage.getAsset(ref.asset_id);
      if (!asset || asset.space_id !== spaceId) {
        throw new HumanBoardError(
          "E_ASSET_NOT_FOUND",
          `Asset ${ref.asset_id} does not exist in Space ${spaceId}`,
          { asset_id: ref.asset_id, space_id: spaceId },
        );
      }
      if (asset.display_no !== ref.display_no) {
        throw new HumanBoardError(
          "E_ASSET_NOT_FOUND",
          `Asset ${ref.asset_id} display_no does not match its Space record`,
          { asset_id: ref.asset_id },
        );
      }
      assets.set(asset.asset_id, asset);
    }
    return [...assets.values()];
  }

  private async blobsForAssets(
    assets: readonly Asset[],
  ): Promise<SyncBlobPayload[]> {
    const blobs = new Map<`sha256:${string}`, SyncBlobPayload>();
    for (const asset of assets) {
      if (asset.blob_hash === null || blobs.has(asset.blob_hash)) {
        continue;
      }
      blobs.set(asset.blob_hash, {
        hash: asset.blob_hash,
        data_base64: bytesToBase64(await this.blobs.readBlob(asset.blob_hash)),
      });
    }
    return [...blobs.values()];
  }

  private async materializeAssets(
    spaceId: ULID,
    rawAssets: readonly unknown[],
    scene: Scene,
    assetMap: Map<string, Asset>,
  ): Promise<MaterializedScene> {
    const incoming = new Map<string, Asset>();
    for (const rawAsset of rawAssets) {
      const asset = requireAsset(rawAsset);
      if (incoming.has(asset.asset_id)) {
        throw new HumanBoardError(
          "E_USAGE",
          `Duplicate asset ${asset.asset_id} in sync payload`,
        );
      }
      incoming.set(asset.asset_id, asset);
    }

    for (const ref of scene.assets) {
      if (assetMap.has(ref.asset_id)) {
        continue;
      }
      const remote = incoming.get(ref.asset_id);
      if (remote === undefined) {
        const local = await this.storage.getAsset(ref.asset_id);
        if (!local || local.space_id !== spaceId) {
          throw new HumanBoardError(
            "E_ASSET_NOT_FOUND",
            `Asset ${ref.asset_id} is missing from the sync payload`,
            { asset_id: ref.asset_id },
          );
        }
        assetMap.set(ref.asset_id, local);
        continue;
      }

      if (remote.blob_hash !== null) {
        await this.blobs.readBlob(remote.blob_hash);
      }

      const existingById = await this.storage.getAsset(remote.asset_id);
      const existingByDisplay = await this.storage.getAssetByDisplayNo(
        spaceId,
        remote.display_no,
      );
      const reusable =
        existingById !== null &&
        existingById.space_id === spaceId &&
        existingById.display_no === remote.display_no &&
        existingById.blob_hash === remote.blob_hash &&
        existingById.type === remote.type;
      if (reusable) {
        assetMap.set(remote.asset_id, existingById);
        continue;
      }

      const canReuseId = existingById === null;
      const canReuseDisplay =
        existingByDisplay === null ||
        existingByDisplay.asset_id === remote.asset_id;
      const assetId =
        canReuseId && canReuseDisplay ? remote.asset_id : this.ids.next();
      const displayNo = canReuseDisplay
        ? remote.display_no
        : await this.storage.nextAssetDisplayNo(spaceId);
      const localAsset = await this.storage.createAsset({
        asset_id: assetId,
        space_id: spaceId,
        display_no: displayNo,
        type: remote.type,
        title: remote.title,
        ...(remote.description === undefined
          ? {}
          : { description: remote.description }),
        title_source: remote.title_source,
        blob_hash: remote.blob_hash,
        source_url: remote.source_url,
        owner_id: OWNER_ID,
        created_at: remote.created_at,
      });
      assetMap.set(remote.asset_id, localAsset);
    }

    const refs: AssetRef[] = scene.assets.map((ref) => {
      const local = assetMap.get(ref.asset_id);
      if (!local) {
        throw new HumanBoardError(
          "E_ASSET_NOT_FOUND",
          `Asset ${ref.asset_id} could not be materialized`,
        );
      }
      return {
        ...ref,
        asset_id: local.asset_id,
        display_no: local.display_no,
      };
    });
    const remapped = SceneSchema.parse({ ...scene, assets: refs });
    return {
      scene: remapped,
      changed: refs.some(
        (ref, index) =>
          ref.asset_id !== scene.assets[index]!.asset_id ||
          ref.display_no !== scene.assets[index]!.display_no,
      ),
    };
  }
}
