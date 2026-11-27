import type { Scene } from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import type {
  AgentMessage,
  AgentSession,
  Asset,
  AssetUpdate,
  Draft,
  Layer,
  MetaField,
  MetaFieldInput,
  MetaMergeResult,
  NewAgentMessage,
  NewLayerRecord,
  Project,
  Space,
  ULID,
} from "../domain/types";
import type {
  AppendLayerInput,
  CommitDraftStorageInput,
  StorageAdapter,
} from "./storage-adapter";
import { frozenClone } from "./value";

function seqKey(spaceId: ULID, seq: number): string {
  return `${spaceId}:${seq}`;
}

function displayNoKey(spaceId: ULID, displayNo: string): string {
  return `${spaceId}:${displayNo}`;
}

function metaKey(spaceId: ULID, field: string): string {
  return `${spaceId}:${field}`;
}

function compareMeta(
  left: Pick<MetaFieldInput, "lamport" | "device_id">,
  right: Pick<MetaFieldInput, "lamport" | "device_id">,
): number {
  if (left.lamport !== right.lamport) {
    return left.lamport - right.lamport;
  }
  if (left.device_id === right.device_id) {
    return 0;
  }
  return left.device_id < right.device_id ? -1 : 1;
}

function metaInput(field: MetaField): MetaFieldInput {
  return {
    field: field.field,
    value: field.value,
    lamport: field.lamport,
    device_id: field.device_id,
  };
}

export interface MemoryStorageAdapterOptions {
  readonly deviceId?: string;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly projects = new Map<ULID, Project>();
  private readonly spaces = new Map<ULID, Space>();
  private readonly layers = new Map<ULID, Layer>();
  private readonly layersBySpace = new Map<ULID, Layer[]>();
  private readonly layerScenes = new Map<ULID, Scene>();
  private readonly nextSeqBySpace = new Map<ULID, number>();
  private readonly layerSeqKeys = new Set<string>();
  private readonly assets = new Map<ULID, Asset>();
  private readonly assetsByDisplayNo = new Map<string, Asset>();
  private readonly agentSessionsById = new Map<ULID, AgentSession>();
  private readonly agentSessionByScope = new Map<string, AgentSession>();
  private readonly agentMessagesBySession = new Map<ULID, AgentMessage[]>();
  private readonly draftsById = new Map<ULID, Draft>();
  private readonly draftIdBySession = new Map<string, ULID>();
  private readonly metaFields = new Map<string, MetaField>();
  private readonly deviceId: string;

  constructor(options: MemoryStorageAdapterOptions = {}) {
    const configured = options.deviceId?.trim();
    this.deviceId =
      configured !== undefined && configured.length > 0
        ? configured
        : `memory-${crypto.randomUUID()}`;
  }

  async getProject(projectId: ULID): Promise<Project | null> {
    const project = this.projects.get(projectId);
    return project ? frozenClone(project) : null;
  }

  async createProject(project: Project): Promise<Project> {
    if (this.projects.has(project.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Project ${project.id} already exists`,
      );
    }

    const stored = frozenClone(project);
    this.projects.set(project.id, stored);
    return frozenClone(stored);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()]
      .sort(
        (left, right) =>
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .map(frozenClone);
  }

  async getSpace(spaceId: ULID): Promise<Space | null> {
    const space = this.spaces.get(spaceId);
    return space ? frozenClone(space) : null;
  }

  async listSpaces(projectId: ULID): Promise<Space[]> {
    return [...this.spaces.values()]
      .filter((space) => space.project_id === projectId)
      .sort(
        (left, right) =>
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .map(frozenClone);
  }

  async createSpace(space: Space): Promise<Space> {
    if (!this.projects.has(space.project_id)) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${space.project_id} does not exist`,
      );
    }
    if (this.spaces.has(space.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Space ${space.id} already exists`,
      );
    }

    const stored = frozenClone(space);
    this.spaces.set(space.id, stored);
    this.writeMetaFieldInternal(space.id, "space.name", space.name);
    return frozenClone(stored);
  }

  async setSpaceActiveLayer(spaceId: ULID, layerId: ULID): Promise<Space> {
    const space = this.spaces.get(spaceId);
    if (!space) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }

    const layer = this.layers.get(layerId);
    if (!layer || layer.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${layerId} does not exist`,
      );
    }

    const updated = frozenClone({ ...space, active_layer_id: layerId });
    this.spaces.set(spaceId, updated);
    return frozenClone(updated);
  }

  async getLayer(layerId: ULID): Promise<Layer | null> {
    const layer = this.layers.get(layerId);
    return layer ? frozenClone(layer) : null;
  }

  async getLayerScene(layerId: ULID): Promise<Scene | null> {
    const scene = this.layerScenes.get(layerId);
    return scene ? frozenClone(scene) : null;
  }

  async listLayers(spaceId: ULID): Promise<Layer[]> {
    return [...(this.layersBySpace.get(spaceId) ?? [])]
      .sort((left, right) => left.seq - right.seq)
      .map(frozenClone);
  }

  async appendLayer(input: AppendLayerInput): Promise<Layer> {
    return this.appendLayerInternal(input.layer, input.scene);
  }

  async appendLayerAtSeq(input: AppendLayerInput, seq: number): Promise<Layer> {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new HumanBoardError(
        "E_USAGE",
        `Layer sequence must be a positive integer: ${seq}`,
      );
    }
    return this.appendLayerInternal(input.layer, input.scene, seq);
  }

  async getAsset(assetId: ULID): Promise<Asset | null> {
    const asset = this.assets.get(assetId);
    return asset ? frozenClone(asset) : null;
  }

  async getAssetByDisplayNo(
    spaceId: ULID,
    displayNo: string,
  ): Promise<Asset | null> {
    const asset = this.assetsByDisplayNo.get(displayNoKey(spaceId, displayNo));
    return asset ? frozenClone(asset) : null;
  }

  async listAssets(spaceId: ULID): Promise<Asset[]> {
    return [...this.assets.values()]
      .filter((asset) => asset.space_id === spaceId)
      .sort((left, right) => left.display_no.localeCompare(right.display_no))
      .map(frozenClone);
  }

  async nextAssetDisplayNo(spaceId: ULID): Promise<string> {
    if (!this.spaces.has(spaceId)) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }

    const maximum = [...this.assets.values()]
      .filter((asset) => asset.space_id === spaceId)
      .reduce((current, asset) => {
        const displayNo = Number.parseInt(asset.display_no, 10);
        return Number.isFinite(displayNo)
          ? Math.max(current, displayNo)
          : current;
      }, 0);
    return String(maximum + 1).padStart(3, "0");
  }

  async createAsset(asset: Asset): Promise<Asset> {
    if (!this.spaces.has(asset.space_id)) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${asset.space_id} does not exist`,
      );
    }
    if (this.assets.has(asset.asset_id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Asset ${asset.asset_id} already exists`,
      );
    }

    const displayKey = displayNoKey(asset.space_id, asset.display_no);
    if (this.assetsByDisplayNo.has(displayKey)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Asset display number ${asset.display_no} already exists in Space ${asset.space_id}`,
      );
    }

    const stored = frozenClone(asset);
    this.assets.set(asset.asset_id, stored);
    this.assetsByDisplayNo.set(displayKey, stored);
    if (asset.description)
      this.writeMetaFieldInternal(
        asset.space_id,
        `asset.${asset.asset_id}.description`,
        asset.description,
      );
    if (asset.title.length > 0) {
      this.writeMetaFieldInternal(
        asset.space_id,
        `asset.${asset.asset_id}.title`,
        asset.title,
      );
    }
    return frozenClone(stored);
  }

  async updateAsset(assetId: ULID, update: AssetUpdate): Promise<Asset> {
    const existing = this.assets.get(assetId);
    if (!existing) {
      throw new HumanBoardError(
        "E_ASSET_NOT_FOUND",
        `Asset ${assetId} does not exist`,
      );
    }

    const next: Asset = {
      ...existing,
      ...(update.description === undefined
        ? {}
        : { description: update.description }),
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.title_source === undefined
        ? {}
        : { title_source: update.title_source }),
      ...(update.blob_hash === undefined
        ? {}
        : { blob_hash: update.blob_hash }),
    };
    const stored = frozenClone(next);
    this.assets.set(assetId, stored);
    this.assetsByDisplayNo.set(
      displayNoKey(stored.space_id, stored.display_no),
      stored,
    );
    if (
      update.description !== undefined &&
      update.description !== existing.description
    )
      this.writeMetaFieldInternal(
        stored.space_id,
        `asset.${assetId}.description`,
        update.description,
      );
    if (
      update.title !== undefined &&
      update.title !== existing.title &&
      update.title.length > 0
    ) {
      this.writeMetaFieldInternal(
        stored.space_id,
        `asset.${stored.asset_id}.title`,
        update.title,
      );
    }
    return frozenClone(stored);
  }

  async getMetaField(spaceId: ULID, field: string): Promise<MetaField | null> {
    const meta = this.metaFields.get(metaKey(spaceId, field));
    return meta ? frozenClone(meta) : null;
  }

  async listMetaFields(spaceId: ULID): Promise<MetaField[]> {
    return [...this.metaFields.values()]
      .filter((field) => field.space_id === spaceId)
      .sort((left, right) => left.field.localeCompare(right.field))
      .map(frozenClone);
  }

  async writeMetaField(
    spaceId: ULID,
    field: string,
    value: string,
  ): Promise<MetaField> {
    if (!this.spaces.has(spaceId)) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }
    return frozenClone(this.writeMetaFieldInternal(spaceId, field, value));
  }

  async mergeMetaFields(
    spaceId: ULID,
    fields: readonly MetaFieldInput[],
  ): Promise<MetaMergeResult> {
    if (!this.spaces.has(spaceId)) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }
    const merged: MetaField[] = [];
    const conflicts: MetaMergeResult["conflicts"][number][] = [];
    const incomingByField = new Map<string, MetaFieldInput>();
    for (const incoming of fields) {
      this.assertMetaInput(incoming);
      const previous = incomingByField.get(incoming.field);
      if (previous === undefined || compareMeta(incoming, previous) > 0) {
        incomingByField.set(incoming.field, incoming);
      }
    }

    for (const incoming of [...incomingByField.values()].sort((left, right) =>
      left.field.localeCompare(right.field),
    )) {
      const current = this.metaFields.get(metaKey(spaceId, incoming.field));
      const winner =
        current === undefined || compareMeta(incoming, current) > 0
          ? "incoming"
          : "current";
      if (current !== undefined && current.value !== incoming.value) {
        conflicts.push({
          field: incoming.field,
          incoming: { ...incoming },
          current: metaInput(current),
          winner,
        });
      }
      if (winner === "current") {
        continue;
      }
      const stored = this.storeMetaField(spaceId, incoming);
      merged.push(stored);
      this.applyMetaValue(stored);
    }
    return {
      merged: merged.map(frozenClone),
      conflicts,
    };
  }

  async getAgentSession(
    projectId: ULID,
    spaceId: ULID,
  ): Promise<AgentSession | null> {
    const session = this.agentSessionByScope.get(`${projectId}:${spaceId}`);
    return session ? frozenClone(session) : null;
  }

  async createAgentSession(session: AgentSession): Promise<AgentSession> {
    if (!this.projects.has(session.project_id)) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${session.project_id} does not exist`,
      );
    }
    const space = this.spaces.get(session.space_id);
    if (!space || space.project_id !== session.project_id) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${session.space_id} does not exist in Project ${session.project_id}`,
      );
    }
    const scope = `${session.project_id}:${session.space_id}`;
    if (this.agentSessionByScope.has(scope)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Agent session already exists for Project ${session.project_id} and Space ${session.space_id}`,
      );
    }
    const stored = frozenClone(session);
    this.agentSessionsById.set(stored.id, stored);
    this.agentSessionByScope.set(scope, stored);
    return frozenClone(stored);
  }

  async listAgentMessages(sessionId: ULID): Promise<AgentMessage[]> {
    return [...(this.agentMessagesBySession.get(sessionId) ?? [])]
      .sort(
        (left, right) =>
          left.seq - right.seq ||
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .map(frozenClone);
  }

  async appendAgentMessage(message: NewAgentMessage): Promise<AgentMessage> {
    const session = this.agentSessionsById.get(message.session_id);
    if (!session) {
      throw new HumanBoardError(
        "E_NOT_FOUND",
        `Agent session ${message.session_id} does not exist`,
      );
    }
    const messages = this.agentMessagesBySession.get(message.session_id) ?? [];
    if (messages.some((item) => item.id === message.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Agent message ${message.id} already exists`,
      );
    }
    const seq =
      messages.reduce((maximum, item) => Math.max(maximum, item.seq), 0) + 1;
    const stored = frozenClone({ ...message, seq });
    messages.push(stored);
    this.agentMessagesBySession.set(message.session_id, messages);
    const updatedSession = frozenClone({
      ...session,
      updated_at: message.created_at,
    });
    this.agentSessionsById.set(updatedSession.id, updatedSession);
    this.agentSessionByScope.set(
      `${updatedSession.project_id}:${updatedSession.space_id}`,
      updatedSession,
    );
    return frozenClone(stored);
  }

  async updateLayerTitleIfPending(
    layerId: ULID,
    title: string,
    titleSource: Exclude<import("../domain/types").TitleSource, "pending">,
  ): Promise<Layer | null> {
    const layer = this.layers.get(layerId);
    if (!layer) {
      return null;
    }
    if (layer.title.length > 0 || layer.title_source !== "pending") {
      return null;
    }
    const updated = frozenClone({
      ...layer,
      title,
      title_source: titleSource,
    });
    this.layers.set(layerId, updated);
    const layers = this.layersBySpace.get(updated.space_id) ?? [];
    const index = layers.findIndex((item) => item.id === layerId);
    if (index !== -1) {
      layers[index] = updated;
    }
    this.writeMetaFieldInternal(
      updated.space_id,
      `layer.${updated.id}.title`,
      title,
    );
    return frozenClone(updated);
  }

  async updateAssetTitleIfPending(
    assetId: ULID,
    title: string,
    titleSource: Exclude<import("../domain/types").TitleSource, "pending">,
  ): Promise<Asset | null> {
    const asset = this.assets.get(assetId);
    if (!asset) {
      return null;
    }
    if (asset.title.length > 0 || asset.title_source !== "pending") {
      return null;
    }
    const updated = frozenClone({
      ...asset,
      title,
      title_source: titleSource,
    });
    this.assets.set(assetId, updated);
    this.assetsByDisplayNo.set(
      displayNoKey(updated.space_id, updated.display_no),
      updated,
    );
    this.writeMetaFieldInternal(
      updated.space_id,
      `asset.${updated.asset_id}.title`,
      title,
    );
    return frozenClone(updated);
  }

  async getDraftBySession(sessionId: string): Promise<Draft | null> {
    const draftId = this.draftIdBySession.get(sessionId);
    if (!draftId) {
      return null;
    }

    const draft = this.draftsById.get(draftId);
    return draft ? frozenClone(draft) : null;
  }

  async getDraftById(draftId: ULID): Promise<Draft | null> {
    const draft = this.draftsById.get(draftId);
    return draft ? frozenClone(draft) : null;
  }

  async saveDraft(draft: Draft): Promise<Draft> {
    const existingId = this.draftIdBySession.get(draft.session_id);
    if (existingId && existingId !== draft.id) {
      const existing = this.draftsById.get(existingId);
      if (existing && existing.session_id !== draft.session_id) {
        throw new HumanBoardError(
          "E_INTERNAL",
          `Draft session ${draft.session_id} is inconsistent`,
        );
      }
      this.draftsById.delete(existingId);
    }

    const existingSameId = this.draftsById.get(draft.id);
    if (existingSameId && existingSameId.session_id !== draft.session_id) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Draft ${draft.id} belongs to another session`,
      );
    }

    const stored = frozenClone(draft);
    this.draftsById.set(draft.id, stored);
    this.draftIdBySession.set(draft.session_id, draft.id);
    return frozenClone(stored);
  }

  async deleteDraft(draftId: ULID): Promise<void> {
    const draft = this.draftsById.get(draftId);
    if (!draft) {
      return;
    }

    this.draftsById.delete(draftId);
    if (this.draftIdBySession.get(draft.session_id) === draftId) {
      this.draftIdBySession.delete(draft.session_id);
    }
  }

  async commitDraft(input: CommitDraftStorageInput): Promise<Layer> {
    const draft = this.draftsById.get(input.draft_id);
    if (!draft) {
      throw new HumanBoardError(
        "E_NO_DRAFT",
        `Draft ${input.draft_id} does not exist`,
      );
    }
    if (draft.status === "consumed") {
      throw new HumanBoardError(
        "E_DRAFT_CONSUMED",
        `Draft ${input.draft_id} has already been committed`,
      );
    }
    if (draft.space_id !== input.layer.space_id) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Draft ${draft.id} and Layer ${input.layer.id} belong to different Spaces`,
      );
    }

    const layer = this.appendLayerInternal(input.layer, input.scene);
    const consumed = frozenClone({
      ...draft,
      status: "consumed" as const,
      committed_layer_id: layer.id,
    });
    this.draftsById.set(draft.id, consumed);
    return layer;
  }

  private appendLayerInternal(
    layer: NewLayerRecord,
    scene: Scene,
    requestedSeq?: number,
  ): Layer {
    if (!this.spaces.has(layer.space_id)) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${layer.space_id} does not exist`,
      );
    }
    if (this.layers.has(layer.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Layer ${layer.id} already exists`,
      );
    }
    if (layer.parent_id !== null) {
      const parent = this.layers.get(layer.parent_id);
      if (!parent || parent.space_id !== layer.space_id) {
        throw new HumanBoardError(
          "E_LAYER_NOT_FOUND",
          `Parent layer ${layer.parent_id} does not exist in Space ${layer.space_id}`,
        );
      }
    }

    const nextSeq = (this.nextSeqBySpace.get(layer.space_id) ?? 0) + 1;
    const seq = requestedSeq ?? nextSeq;
    const key = seqKey(layer.space_id, seq);
    if (this.layerSeqKeys.has(key)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Layer sequence ${seq} already exists in Space ${layer.space_id}`,
      );
    }

    const stored = frozenClone({
      ...layer,
      seq,
      seq_origin: layer.seq_origin ?? null,
    });
    this.layers.set(stored.id, stored);
    this.layerScenes.set(stored.id, frozenClone(scene));
    this.layerSeqKeys.add(key);
    this.nextSeqBySpace.set(
      layer.space_id,
      Math.max(this.nextSeqBySpace.get(layer.space_id) ?? 0, seq),
    );

    const spaceLayers = this.layersBySpace.get(layer.space_id) ?? [];
    spaceLayers.push(stored);
    this.layersBySpace.set(layer.space_id, spaceLayers);
    if (stored.title.length > 0) {
      this.writeMetaFieldInternal(
        stored.space_id,
        `layer.${stored.id}.title`,
        stored.title,
      );
    }
    return frozenClone(stored);
  }

  private assertMetaInput(input: MetaFieldInput): void {
    if (
      typeof input.field !== "string" ||
      input.field.length === 0 ||
      typeof input.value !== "string" ||
      !Number.isSafeInteger(input.lamport) ||
      input.lamport < 1 ||
      typeof input.device_id !== "string" ||
      input.device_id.length === 0
    ) {
      throw new HumanBoardError("E_USAGE", "Invalid meta register");
    }
  }

  private writeMetaFieldInternal(
    spaceId: ULID,
    field: string,
    value: string,
  ): MetaField {
    const existing = this.metaFields.get(metaKey(spaceId, field));
    const stored = this.storeMetaField(spaceId, {
      field,
      value,
      lamport: (existing?.lamport ?? 0) + 1,
      device_id: this.deviceId,
    });
    this.applyMetaValue(stored);
    return stored;
  }

  private storeMetaField(spaceId: ULID, input: MetaFieldInput): MetaField {
    this.assertMetaInput(input);
    const stored = frozenClone({
      space_id: spaceId,
      field: input.field,
      value: input.value,
      lamport: input.lamport,
      device_id: input.device_id,
    });
    this.metaFields.set(metaKey(spaceId, input.field), stored);
    return frozenClone(stored);
  }

  private applyMetaValue(meta: MetaField): void {
    if (meta.field === "space.name") {
      const space = this.spaces.get(meta.space_id);
      if (space) {
        this.spaces.set(
          meta.space_id,
          frozenClone({ ...space, name: meta.value }),
        );
      }
      return;
    }

    const layerMatch = /^layer\.([^.]+)\.title$/.exec(meta.field);
    if (layerMatch?.[1] !== undefined) {
      const layer = this.layers.get(layerMatch[1]);
      if (layer && layer.space_id === meta.space_id) {
        const updated = frozenClone({ ...layer, title: meta.value });
        this.layers.set(layer.id, updated);
        const layers = this.layersBySpace.get(layer.space_id) ?? [];
        const index = layers.findIndex((item) => item.id === layer.id);
        if (index !== -1) {
          layers[index] = updated;
        }
      }
      return;
    }

    const assetMatch = /^asset\.([^.]+)\.(title|description)$/.exec(meta.field);
    if (assetMatch?.[1] !== undefined) {
      const asset = this.assets.get(assetMatch[1]);
      if (asset && asset.space_id === meta.space_id) {
        const updated = frozenClone({
          ...asset,
          ...(assetMatch[2] === "description"
            ? { description: meta.value }
            : { title: meta.value }),
        });
        this.assets.set(asset.asset_id, updated);
        this.assetsByDisplayNo.set(
          displayNoKey(updated.space_id, updated.display_no),
          updated,
        );
      }
    }
  }
}
