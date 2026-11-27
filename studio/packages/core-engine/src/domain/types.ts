import type { Scene } from "@humanboard/schema";

export type ULID = string;

export const OWNER_ID = "local" as const;

export const LAYER_KINDS = ["root", "derive", "redo", "transform"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export const TITLE_SOURCES = ["agent", "human", "builtin", "pending"] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

export const AUTHOR_KINDS = ["human", "cli", "builtin"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export interface Author {
  readonly kind: AuthorKind;
  readonly name?: string;
}

export interface Project {
  readonly id: ULID;
  readonly name: string;
  readonly root: string | null;
  readonly owner_id: string;
  readonly created_at: string;
}

export interface Space {
  readonly id: ULID;
  readonly project_id: ULID;
  readonly name: string;
  readonly active_layer_id: ULID | null;
  readonly owner_id: string;
  readonly created_at: string;
}

export interface Layer {
  readonly id: ULID;
  readonly space_id: ULID;
  readonly seq: number;
  readonly seq_origin?: number | null;
  readonly parent_id: ULID | null;
  readonly kind: LayerKind;
  readonly redo_of: ULID | null;
  readonly title: string;
  readonly title_source: TitleSource;
  readonly created_at: string;
  readonly author: Author;
  readonly schema_version: number;
  readonly content_hash: `sha256:${string}`;
  readonly owner_id: string;
}

export type NewLayerRecord = Omit<Layer, "seq">;

export interface LayerSnapshot {
  readonly layer: Layer;
  readonly scene: Scene;
}

export interface Asset {
  readonly description?: string;
  readonly asset_id: ULID;
  readonly space_id: ULID;
  readonly display_no: string;
  readonly type: "image" | "url";
  readonly title: string;
  readonly title_source: TitleSource | null;
  readonly blob_hash: `sha256:${string}` | null;
  readonly source_url: string | null;
  readonly owner_id: string;
  readonly created_at: string;
}

export interface AssetUpdate {
  readonly description?: string;
  readonly title?: string;
  readonly title_source?: TitleSource | null;
  readonly blob_hash?: `sha256:${string}` | null;
}

export interface MetaField {
  readonly space_id: ULID;
  readonly field: string;
  readonly value: string;
  readonly lamport: number;
  readonly device_id: string;
}

export interface MetaFieldInput {
  readonly field: string;
  readonly value: string;
  readonly lamport: number;
  readonly device_id: string;
}

export interface MetaMergeConflict {
  readonly field: string;
  readonly incoming: MetaFieldInput;
  readonly current: MetaFieldInput;
  readonly winner: "incoming" | "current";
}

export interface MetaMergeResult {
  readonly merged: readonly MetaField[];
  readonly conflicts: readonly MetaMergeConflict[];
}

export type DraftStatus = "open" | "consumed";

export interface Draft {
  readonly id: ULID;
  readonly session_id: string;
  readonly project_id: ULID;
  readonly space_id: ULID;
  readonly parent_id: ULID | null;
  readonly kind: LayerKind;
  readonly redo_of: ULID | null;
  readonly scene: Scene;
  readonly author: Author;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly status: DraftStatus;
  readonly committed_layer_id: ULID | null;
}

export interface AgentSession {
  readonly id: ULID;
  readonly project_id: ULID;
  readonly space_id: ULID;
  readonly created_at: string;
  readonly updated_at: string;
}

export type AgentMessageRole = "user" | "assistant";

export interface AgentToolTrace {
  id: string;
  tool: string;
  step: number;
  status: "running" | "completed" | "failed";
  summary: string;
  started_at: string;
  finished_at?: string;
}

export interface AgentReasoningStep {
  readonly step: number;
  readonly content: string;
}

export interface AgentMessage {
  readonly reasoning_steps?: readonly AgentReasoningStep[];
  readonly tool_trace?: readonly AgentToolTrace[];
  readonly id: ULID;
  readonly session_id: ULID;
  readonly seq: number;
  readonly role: AgentMessageRole;
  readonly content: string;
  readonly base_layer_id: ULID | null;
  readonly result_layer_id: ULID | null;
  readonly created_at: string;
}

export type NewAgentMessage = Omit<AgentMessage, "seq">;

export interface AssetSourceFile {
  readonly kind: "file";
  readonly path: string;
}

export interface AssetSourceUrl {
  readonly kind: "url";
  readonly url: string;
}

export type AssetSource = AssetSourceFile | AssetSourceUrl;

export interface ScenePatchAssetUpsert {
  readonly asset_id?: string;
  readonly source?: AssetSource;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly z: number;
  readonly display_no?: never;
}

export interface ScenePatch {
  readonly diagram?: import("@humanboard/schema").Diagram | null;
  readonly upsert_nodes?: readonly (Partial<
    import("@humanboard/schema").Node
  > & {
    readonly id: string;
  })[];
  readonly remove_nodes?: readonly string[];
  readonly upsert_edges?: readonly (Partial<
    import("@humanboard/schema").Edge
  > & {
    readonly id: string;
  })[];
  readonly remove_edges?: readonly string[];
  readonly add_strokes?: readonly import("@humanboard/schema").Stroke[];
  readonly remove_strokes?: readonly string[];
  readonly upsert_assets?: readonly ScenePatchAssetUpsert[];
  readonly remove_assets?: readonly string[];
  readonly add_assets?: readonly ScenePatchAssetUpsert[];
}
