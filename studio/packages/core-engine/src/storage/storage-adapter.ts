import type { Scene } from "@humanboard/schema";

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

export interface CommitDraftStorageInput {
  readonly draft_id: ULID;
  readonly layer: NewLayerRecord;
  readonly scene: Scene;
}

export interface AppendLayerInput {
  readonly layer: NewLayerRecord;
  readonly scene: Scene;
}

/**
 * Storage boundary for the domain layer.
 *
 * `appendLayer` owns local `seq` allocation and must enforce
 * `UNIQUE (space_id, seq)`. `commitDraft` must atomically append the layer and
 * mark the draft consumed.
 */
export interface StorageAdapter {
  getProject(projectId: ULID): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  createProject(project: Project): Promise<Project>;

  getSpace(spaceId: ULID): Promise<Space | null>;
  listSpaces(projectId: ULID): Promise<Space[]>;
  createSpace(space: Space): Promise<Space>;
  setSpaceActiveLayer(spaceId: ULID, layerId: ULID): Promise<Space>;

  getLayer(layerId: ULID): Promise<Layer | null>;
  getLayerScene(layerId: ULID): Promise<Scene | null>;
  listLayers(spaceId: ULID): Promise<Layer[]>;
  appendLayer(input: AppendLayerInput): Promise<Layer>;
  appendLayerAtSeq(input: AppendLayerInput, seq: number): Promise<Layer>;

  getAsset(assetId: ULID): Promise<Asset | null>;
  getAssetByDisplayNo(spaceId: ULID, displayNo: string): Promise<Asset | null>;
  listAssets(spaceId: ULID): Promise<Asset[]>;
  nextAssetDisplayNo(spaceId: ULID): Promise<string>;
  createAsset(asset: Asset): Promise<Asset>;
  updateAsset(assetId: ULID, update: AssetUpdate): Promise<Asset>;

  getMetaField(spaceId: ULID, field: string): Promise<MetaField | null>;
  listMetaFields(spaceId: ULID): Promise<MetaField[]>;
  writeMetaField(
    spaceId: ULID,
    field: string,
    value: string,
  ): Promise<MetaField>;
  mergeMetaFields(
    spaceId: ULID,
    fields: readonly MetaFieldInput[],
  ): Promise<MetaMergeResult>;

  getAgentSession(
    projectId: ULID,
    spaceId: ULID,
  ): Promise<AgentSession | null>;
  createAgentSession(session: AgentSession): Promise<AgentSession>;
  listAgentMessages(sessionId: ULID): Promise<AgentMessage[]>;
  appendAgentMessage(message: NewAgentMessage): Promise<AgentMessage>;
  updateLayerTitleIfPending(
    layerId: ULID,
    title: string,
    titleSource: Exclude<import("../domain/types").TitleSource, "pending">,
  ): Promise<Layer | null>;
  updateAssetTitleIfPending(
    assetId: ULID,
    title: string,
    titleSource: Exclude<import("../domain/types").TitleSource, "pending">,
  ): Promise<Asset | null>;

  getDraftBySession(sessionId: string): Promise<Draft | null>;
  getDraftById(draftId: ULID): Promise<Draft | null>;
  saveDraft(draft: Draft): Promise<Draft>;
  deleteDraft(draftId: ULID): Promise<void>;
  commitDraft(input: CommitDraftStorageInput): Promise<Layer>;
}
