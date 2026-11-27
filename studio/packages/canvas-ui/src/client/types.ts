import type { AssetRef, Edge, Node, Scene, Stroke } from "@humanboard/schema";
import type { SceneAstDiff, SceneAstSummary } from "@humanboard/core-engine";

export type Tool =
  | "select"
  | "pen"
  | "highlighter"
  | "eraser"
  | "node"
  | "edge";

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly asset_id?: string;
  readonly layer_id?: string;
  readonly total_layers?: number;
  readonly visible_layers?: number;
}

export interface LayerSummary {
  readonly id: string;
  readonly space_id: string;
  readonly seq: number;
  readonly short_id: string;
  readonly title: string;
  readonly title_source: string;
  readonly kind: string;
  readonly parent_id: string | null;
  readonly redo_of: string | null;
  readonly created_at: string;
  readonly author: {
    readonly kind: string;
    readonly name?: string;
  };
  readonly schema_version: number;
}

export interface SpaceSummary {
  readonly id: string;
  readonly name: string;
  readonly layer_count: number;
  readonly active_layer_id?: string | null;
  readonly cover_layer_id?: string | null;
}

export interface StatusData {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly root: string | null;
  };
  readonly space: {
    readonly deleted?: boolean;
    readonly id: string;
    readonly name: string;
  };
  readonly active_layer: string | null;
  readonly layers: readonly LayerSummary[];
  readonly layers_truncated: boolean;
  readonly total_layers: number;
  readonly spaces: readonly SpaceSummary[];
  readonly deleted_spaces?: readonly SpaceSummary[];
  readonly warnings: readonly Warning[];
}

export interface LayerEdge {
  readonly from: string;
  readonly to: string;
}

export interface LayersData {
  readonly space: {
    readonly deleted?: boolean;
    readonly id: string;
    readonly name: string;
  };
  readonly active_layer: string | null;
  readonly layers: readonly LayerSummary[];
  readonly edges: readonly LayerEdge[];
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RenderInfo {
  readonly url: string;
  readonly bounds: Bounds;
  readonly padding: number;
  readonly expires_at: string | null;
}

export interface AssetManifestItem {
  readonly description?: string;
  readonly asset_id: string;
  readonly display_no: string;
  readonly type: "image" | "url";
  readonly title: string;
  readonly title_source: string | null;
  readonly source_url: string | null;
  readonly blob_hash: string | null;
  readonly rect: Bounds;
  readonly z: number;
}

export interface GetData {
  readonly layer: LayerSummary;
  readonly content_hash: string;
  readonly ast?: {
    readonly diagram?: Scene["diagram"];
    readonly nodes: readonly Node[];
    readonly edges: readonly Edge[];
  };
  readonly strokes: {
    readonly count: number;
    readonly items: readonly Stroke[] | null;
  };
  readonly assets: readonly AssetManifestItem[];
  readonly render?: RenderInfo;
  readonly warnings: readonly Warning[];
}

export interface DiffVisual {
  readonly coordinate_space: string;
  readonly bounds: Bounds;
  readonly background_opacity: number;
  readonly before: { readonly url: string; readonly bounds: Bounds };
  readonly after: { readonly url: string; readonly bounds: Bounds };
  readonly highlight: { readonly url: string; readonly bounds: Bounds };
  readonly boxes: readonly DiffBox[];
}

export interface DiffBox {
  readonly id?: string;
  readonly kind?: "stroke" | "node";
  readonly rect?: Bounds;
  readonly stroke_ids?: readonly string[];
  readonly node_ids?: readonly string[];
}

export interface DiffData {
  readonly has_strokes?: boolean;
  readonly mode: string;
  readonly summary: string;
  readonly ancestor?: boolean;
  readonly ast?: SceneAstDiff;
  readonly ast_summary?: SceneAstSummary;
  readonly base: {
    readonly id: string;
    readonly short_id: string;
    readonly seq: number;
  };
  readonly target: {
    readonly id: string;
    readonly short_id: string;
    readonly seq: number;
  };
  readonly visual?: DiffVisual;
  readonly warnings: readonly Warning[];
}

export interface DraftData {
  readonly draft_id: string;
  readonly parent_id: string | null;
  readonly space_id: string;
  readonly kind: string;
  readonly redo_of: string | null;
  readonly expires_at: string;
  readonly preview_url: string;
  readonly overwritten: boolean;
  readonly registered_assets: readonly unknown[];
  readonly warnings: readonly Warning[];
}

export interface CommitData {
  readonly layer_id: string;
  readonly seq: number;
  readonly short_id: string;
  readonly kind: string;
  readonly title: string;
  readonly title_source: string;
  readonly parent_id: string | null;
  readonly content_hash: string;
  readonly diff: {
    readonly mode: string;
    readonly summary: string;
  };
  readonly warnings: readonly Warning[];
}

export interface InspectImageData {
  readonly asset: {
    readonly asset_id: string;
    readonly display_no: string;
    readonly type: "image";
    readonly title: string;
    readonly source: {
      readonly kind: string;
      readonly width: number;
      readonly height: number;
    };
  };
  readonly layer: {
    readonly id: string;
    readonly short_id: string;
    readonly seq: number;
  } | null;
  readonly content: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly overlaid_strokes: readonly string[];
  };
  readonly warnings: readonly Warning[];
}

export interface InspectUrlData {
  readonly asset: {
    readonly asset_id: string;
    readonly display_no: string;
    readonly type: "url";
    readonly title: string;
    readonly source_url: string;
  };
  readonly content: {
    readonly kind: "markdown";
    readonly markdown: string;
    readonly fetched_at: string;
    readonly truncated: boolean;
    readonly untrusted: true;
    readonly title: string;
    readonly final_url: string;
    readonly content_type: string;
  };
  readonly warnings: readonly Warning[];
}

export type InspectData = InspectImageData | InspectUrlData;

export interface CaptureData {
  readonly based_on_layer: string;
  readonly based_on_seq: number;
  readonly has_uncommitted: boolean;
  readonly uncommitted: CaptureUncommittedSummary;
  readonly snapshot_id: string;
  readonly captured_at: string;
  readonly layer: Partial<LayerSummary> & {
    readonly title?: string;
    readonly title_source?: string;
    readonly kind?: string;
  };
  readonly render: {
    readonly url: string;
    readonly bounds: Bounds;
  };
  readonly assets: readonly AssetManifestItem[];
}

export interface CommandErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CommandEnvelope<T> {
  readonly exitCode: number;
  readonly data?: T;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: CommandErrorPayload;
}

export interface HealthData {
  readonly ok: true;
  readonly service: "humanboard";
  readonly host: string;
  readonly port: number;
}

export interface CaptureUncommittedSummary {
  readonly strokes: {
    readonly added: number;
    readonly erased: number;
  };
  readonly nodes: {
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly moved: readonly string[];
    readonly removed: readonly string[];
  };
  readonly edges: {
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  };
  readonly assets: {
    readonly added: readonly string[];
    readonly moved: readonly string[];
    readonly removed: readonly string[];
  };
}

export interface FrontendSessionRegistration {
  readonly session_id: string;
  readonly heartbeat_ms: number;
}

export interface FrontendCaptureRequest {
  readonly request_id: string;
  readonly timeout_ms: number;
}

export interface FrontendCapturePayload {
  readonly based_on_layer: string;
  readonly based_on_seq: number;
  readonly scene: Scene;
  readonly layer: LayerSummary;
  readonly assets: readonly AssetManifestItem[];
  readonly has_uncommitted: boolean;
  readonly uncommitted: CaptureUncommittedSummary;
  readonly captured_at: string;
}

export interface FrontendCaptureResponse {
  readonly accepted: boolean;
}

export interface ActiveLayerResponse {
  readonly space_id: string;
  readonly active_layer_id: string;
}

export type ModelRole = "agent" | "vision" | "text";
export interface ModelSettingsUpdate {
  readonly role: ModelRole;
  readonly model?: string;
  readonly base_url?: string;
  readonly api_key?: string;
  readonly follow_agent?: boolean;
  readonly enabled?: boolean;
  readonly reset?: boolean;
  readonly clear_api_key?: boolean;
}
export interface AgentRoleConfig {
  readonly follow_agent?: boolean;
  readonly enabled?: boolean;
  readonly source?: "saved" | "environment";
  readonly base_url?: string | null;
  readonly configured: boolean;
  readonly model: string | null;
  readonly base_url_configured: boolean;
  readonly api_key_configured: boolean;
  readonly missing_env: readonly string[];
}

export interface AgentConfigData {
  readonly agent: AgentRoleConfig;
  readonly vision: AgentRoleConfig;
  readonly text: AgentRoleConfig;
  readonly titles?: AgentTitleStatus;
}

export interface AgentTitleEvent {
  readonly task: "layer" | "image";
  readonly target_id: string;
  readonly status: "completed" | "failed" | "skipped";
  readonly title?: string;
  readonly reason?: string;
  readonly at: string;
}

export interface AgentTitleStatus {
  readonly enabled: boolean;
  readonly vision: {
    readonly configured: boolean;
    readonly model: string | null;
    readonly missing_env: readonly string[];
  };
  readonly text: {
    readonly configured: boolean;
    readonly model: string | null;
    readonly missing_env: readonly string[];
  };
  readonly queue: {
    readonly pending: number;
    readonly running: boolean;
    readonly completed: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly recent: readonly AgentTitleEvent[];
}

export interface AgentChatDiff {
  readonly mode: string;
  readonly summary: string;
  readonly ancestor?: boolean;
  readonly ast?: unknown;
  readonly ast_summary?: unknown;
  readonly base_layer_id: string;
  readonly result_layer_id: string;
}

export interface AgentToolTraceData {
  readonly id: string;
  readonly tool: string;
  readonly step: number;
  readonly status: "running" | "completed" | "failed";
  readonly summary: string;
  readonly started_at: string;
  readonly finished_at?: string;
}
export interface AgentRunData {
  readonly reasoning_steps?: readonly { step: number; content: string }[];
  readonly partial_message?: string;
  readonly run_id: string;
  readonly phase: "thinking" | "tool";
  readonly step: number;
  readonly tool_trace: readonly AgentToolTraceData[];
}
export interface AgentChatData {
  readonly input_snapshot?: {
    readonly layer_id: string;
    readonly content_hash: string;
  };
  readonly session_id: string;
  readonly message_id: string;
  readonly assistant_message: string;
  readonly base_layer_id: string;
  readonly result_layer_id: string | null;
  readonly kind: "transform" | "derive" | "redo" | null;
  readonly title: string | null;
  readonly diff: AgentChatDiff | null;
  readonly tool_trace: readonly AgentToolTraceData[];
  readonly status: "completed" | "cancelled" | "limited" | "failed";
}

export interface AgentHistoryMessageData {
  readonly reasoning_steps?: readonly { step: number; content: string }[];
  readonly tool_trace?: readonly AgentToolTraceData[];
  readonly id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly base_layer_id: string | null;
  readonly result_layer_id: string | null;
  readonly created_at: string;
}

export interface AgentHistoryData {
  readonly session_id: string | null;
  readonly messages: readonly AgentHistoryMessageData[];
}

export interface ScenePatchStrokeInput {
  readonly add_strokes: readonly Stroke[];
}

export type { AssetRef, Edge, Node, Scene, Stroke };

export interface ProjectSyncData {
  readonly cloud_sync: boolean;
  readonly remote_configured: boolean;
  readonly running: boolean;
  readonly last_synced_at: string | null;
  readonly error: string | null;
}
