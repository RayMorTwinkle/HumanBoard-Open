import { isSpaceDeleted } from "./space-visibility";
import { coordinateDriftWarnings, type SceneWarning } from "./scene-lint";
import {
  describeSchemaIssues,
  resolveSceneDefaults,
  SceneSchema,
  sceneContentHash,
  type Scene,
} from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/ports";
import { SystemClock, UlidGenerator } from "../domain/ports";
import type {
  Asset,
  Author,
  Draft,
  Layer,
  LayerKind,
  NewLayerRecord,
  ScenePatch,
  Space,
  TitleSource,
  ULID,
} from "../domain/types";
import { OWNER_ID } from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";
import { validateSceneAssetRefs } from "./scene-assets";
import { ScenePatchService } from "./scene-patch-service";

export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const SCHEMA_VERSION = 1;
export const MAX_TITLE_CODE_POINTS = 40;

export interface DraftServiceOptions {
  readonly storage: StorageAdapter;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly draftTtlMs?: number;
}

export interface CreateDraftRequest {
  readonly sessionId: string;
  readonly projectId: ULID;
  readonly spaceId: ULID;
  readonly kind?: LayerKind;
  readonly parentId?: ULID | null;
  readonly scene?: Scene;
  readonly patch?: ScenePatch;
  readonly author: Author;
}

export interface CreateDraftResult {
  readonly draft: Draft;
  readonly overwritten: boolean;
  readonly registered_assets: Asset[];
}

export interface CommitDraftRequest {
  readonly sessionId: string;
  readonly draftId?: ULID;
  readonly title?: string;
  readonly titleSource?: Exclude<TitleSource, "pending">;
}

export interface CommitDraftResult {
  readonly warnings: readonly SceneWarning[];
  readonly layer: Layer;
  readonly short_id: string;
}

interface ResolvedTarget {
  readonly kind: LayerKind;
  readonly parent_id: ULID | null;
  readonly redo_of: ULID | null;
  readonly scene_base_id: ULID | null;
}

function emptyScene(): Scene {
  return {
    nodes: [],
    edges: [],
    strokes: [],
    assets: [],
  };
}

function requireSession(sessionId: string): string {
  if (sessionId.trim().length === 0) {
    throw new HumanBoardError("E_USAGE", "sessionId must not be empty");
  }
  return sessionId;
}

export class DraftService {
  private readonly storage: StorageAdapter;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly draftTtlMs: number;
  private readonly patches: ScenePatchService;

  constructor(options: DraftServiceOptions) {
    if (options.draftTtlMs !== undefined && options.draftTtlMs <= 0) {
      throw new HumanBoardError("E_USAGE", "draftTtlMs must be positive");
    }

    this.storage = options.storage;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new UlidGenerator(this.clock);
    this.draftTtlMs = options.draftTtlMs ?? DRAFT_TTL_MS;
    this.patches = new ScenePatchService({
      storage: this.storage,
      clock: this.clock,
      ids: this.ids,
    });
  }

  async createDraft(request: CreateDraftRequest): Promise<CreateDraftResult> {
    const sessionId = requireSession(request.sessionId);

    if (request.scene !== undefined && request.patch !== undefined) {
      throw new HumanBoardError(
        "E_USAGE",
        "scene and patch inputs are mutually exclusive",
      );
    }

    const project = await this.storage.getProject(request.projectId);
    if (!project) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${request.projectId} does not exist`,
      );
    }

    const space = await this.storage.getSpace(request.spaceId);
    if (!space || space.project_id !== request.projectId) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${request.spaceId} does not exist in Project ${request.projectId}`,
      );
    }

    if (await isSpaceDeleted(this.storage, space.id))
      throw new HumanBoardError(
        "E_SPACE_DELETED",
        "Restore the deleted Space before editing.",
      );
    const target = await this.resolveTarget(request, space);
    const baseScene = await this.resolveBaseScene(target);
    let scene: Scene;
    let registeredAssets: Asset[] = [];

    if (request.patch !== undefined) {
      const applied = await this.patches.apply({
        baseScene,
        patch: request.patch,
        spaceId: space.id,
      });
      scene = applied.scene;
      registeredAssets = applied.registered_assets;
    } else {
      scene =
        request.scene !== undefined
          ? this.parseScene(request.scene)
          : baseScene;
    }

    await validateSceneAssetRefs(this.storage, scene, space.id);

    const now = this.clock.now();
    const nowIso = now.toISOString();
    const existing = await this.storage.getDraftBySession(sessionId);
    const overwritten = existing?.status === "open";
    const draft: Draft = {
      id: overwritten ? existing.id : this.ids.next(),
      session_id: sessionId,
      project_id: request.projectId,
      space_id: request.spaceId,
      parent_id: target.parent_id,
      kind: target.kind,
      redo_of: target.redo_of,
      scene,
      author: request.author,
      created_at: overwritten ? existing.created_at : nowIso,
      updated_at: nowIso,
      expires_at: new Date(now.getTime() + this.draftTtlMs).toISOString(),
      status: "open",
      committed_layer_id: null,
    };

    const saved = await this.storage.saveDraft(draft);
    return {
      draft: saved,
      overwritten,
      registered_assets: registeredAssets,
    };
  }

  async getDraft(sessionId: string): Promise<Draft> {
    const draft = await this.storage.getDraftBySession(
      requireSession(sessionId),
    );
    if (!draft) {
      throw new HumanBoardError(
        "E_NO_DRAFT",
        "No draft exists for this session",
      );
    }
    if (await isSpaceDeleted(this.storage, draft.space_id))
      throw new HumanBoardError(
        "E_SPACE_DELETED",
        "Restore the deleted Space before committing.",
      );
    if (draft.status === "consumed") {
      throw new HumanBoardError(
        "E_DRAFT_CONSUMED",
        `Draft ${draft.id} has already been committed`,
      );
    }
    return draft;
  }

  async clearDraft(sessionId: string): Promise<{ cleared: true }> {
    const draft = await this.storage.getDraftBySession(
      requireSession(sessionId),
    );
    if (!draft) {
      throw new HumanBoardError(
        "E_NO_DRAFT",
        "No draft exists for this session",
      );
    }
    await this.storage.deleteDraft(draft.id);
    return { cleared: true };
  }

  async commitDraft(request: CommitDraftRequest): Promise<CommitDraftResult> {
    const sessionId = requireSession(request.sessionId);
    const draft = request.draftId
      ? await this.storage.getDraftById(request.draftId)
      : await this.storage.getDraftBySession(sessionId);

    if (!draft || draft.session_id !== sessionId) {
      throw new HumanBoardError(
        "E_NO_DRAFT",
        request.draftId
          ? `Draft ${request.draftId} does not exist for this session`
          : "No draft exists for this session",
      );
    }
    if (await isSpaceDeleted(this.storage, draft.space_id))
      throw new HumanBoardError(
        "E_SPACE_DELETED",
        "Restore the deleted Space before committing.",
      );
    if (draft.status === "consumed") {
      throw new HumanBoardError(
        "E_DRAFT_CONSUMED",
        `Draft ${draft.id} has already been committed`,
        { draft_id: draft.id, layer_id: draft.committed_layer_id },
      );
    }
    if (Date.parse(draft.expires_at) <= this.clock.now().getTime()) {
      throw new HumanBoardError(
        "E_DRAFT_EXPIRED",
        `Draft ${draft.id} expired at ${draft.expires_at}`,
        { draft_id: draft.id, expires_at: draft.expires_at },
      );
    }

    const { title, title_source } = this.resolveCommitTitle(request);
    const layerId = this.ids.next();
    const layer: NewLayerRecord = {
      id: layerId,
      space_id: draft.space_id,
      seq_origin: null,
      parent_id: draft.parent_id,
      kind: draft.kind,
      redo_of: draft.redo_of,
      title,
      title_source,
      created_at: this.clock.now().toISOString(),
      author: draft.author,
      schema_version: SCHEMA_VERSION,
      content_hash: sceneContentHash(draft.scene) as `sha256:${string}`,
      owner_id: OWNER_ID,
    };

    const committed = await this.storage.commitDraft({
      draft_id: draft.id,
      layer,
      scene: draft.scene,
    });

    const base = draft.parent_id
      ? await this.storage.getLayerScene(draft.parent_id)
      : null;
    return {
      layer: committed,
      short_id: `L${committed.seq}`,
      warnings: base ? coordinateDriftWarnings(base, draft.scene) : [],
    };
  }

  private resolveCommitTitle(request: CommitDraftRequest): {
    title: string;
    title_source: TitleSource;
  } {
    if (request.title === undefined) {
      if (request.titleSource !== undefined) {
        throw new HumanBoardError(
          "E_USAGE",
          "titleSource cannot be provided without title",
        );
      }
      return { title: "", title_source: "pending" };
    }

    if (request.title.trim().length === 0) {
      throw new HumanBoardError("E_USAGE", "title must not be empty");
    }
    if (Array.from(request.title).length > MAX_TITLE_CODE_POINTS) {
      throw new HumanBoardError(
        "E_USAGE",
        `title must be at most ${MAX_TITLE_CODE_POINTS} characters`,
      );
    }

    return {
      title: request.title,
      title_source: request.titleSource ?? "agent",
    };
  }

  private async resolveTarget(
    request: CreateDraftRequest,
    space: Space,
  ): Promise<ResolvedTarget> {
    if (request.kind === "root") {
      if (request.parentId !== undefined && request.parentId !== null) {
        throw new HumanBoardError(
          "E_USAGE",
          "root drafts cannot have a parent",
        );
      }
      const existingLayers = await this.storage.listLayers(space.id);
      if (existingLayers.length > 0) {
        throw new HumanBoardError(
          "E_USAGE",
          "root drafts can only create the first layer in a Space",
        );
      }
      return {
        kind: "root",
        parent_id: null,
        redo_of: null,
        scene_base_id: null,
      };
    }

    const targetId = request.parentId ?? space.active_layer_id;

    if (request.kind === "redo") {
      if (!targetId) {
        throw new HumanBoardError(
          "E_NO_ACTIVE_VIEW",
          "Redo requires an active or explicitly selected layer",
        );
      }

      const target = await this.requireLayer(targetId, space.id);
      if (target.parent_id === null) {
        throw new HumanBoardError(
          "E_REDO_INVALID",
          `Layer ${target.id} is a root layer and cannot be redone`,
          { layer_id: target.id },
        );
      }

      return {
        kind: "redo",
        parent_id: target.parent_id,
        redo_of: target.id,
        scene_base_id: target.id,
      };
    }

    if (targetId) {
      const parent = await this.requireLayer(targetId, space.id);
      return {
        kind: request.kind ?? "derive",
        parent_id: parent.id,
        redo_of: null,
        scene_base_id: parent.id,
      };
    }

    if (request.kind === undefined) {
      const layers = await this.storage.listLayers(space.id);
      if (layers.length === 0) {
        return {
          kind: "root",
          parent_id: null,
          redo_of: null,
          scene_base_id: null,
        };
      }
    }

    throw new HumanBoardError(
      "E_NO_ACTIVE_VIEW",
      "No active or explicitly selected layer is available",
    );
  }

  private async resolveBaseScene(target: ResolvedTarget): Promise<Scene> {
    if (target.scene_base_id === null) {
      return emptyScene();
    }

    const scene = await this.storage.getLayerScene(target.scene_base_id);
    if (!scene) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${target.scene_base_id} does not have a stored Scene`,
      );
    }
    return structuredClone(scene);
  }

  private parseScene(scene: Scene): Scene {
    let resolved: unknown = scene;
    try {
      resolved = resolveSceneDefaults(structuredClone(scene));
      return SceneSchema.parse(resolved);
    } catch (error) {
      const issues = describeSchemaIssues(error, 8, resolved);
      throw new HumanBoardError(
        "E_USAGE",
        `Draft Scene does not match the schema: ${issues[0]}`,
        { issues },
      );
    }
  }

  private async requireLayer(layerId: ULID, spaceId: ULID): Promise<Layer> {
    const layer = await this.storage.getLayer(layerId);
    if (!layer || layer.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${layerId} does not exist in Space ${spaceId}`,
        { layer_id: layerId, space_id: spaceId },
      );
    }
    return layer;
  }
}
