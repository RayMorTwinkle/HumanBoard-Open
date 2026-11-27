import { summarizeEdits } from "./editor";
import type { Scene, Stroke } from "@humanboard/schema";

import type {
  CaptureUncommittedSummary,
  FrontendCapturePayload,
  GetData,
  ScenePatchStrokeInput,
} from "./client/types";

export function sceneFromGetData(data: GetData): Scene {
  if (!data.ast || data.strokes.items === null) {
    throw new Error(
      "当前 Layer 缺少完整 Scene；需要 get --format both --with-strokes",
    );
  }
  return {
    ...(data.ast.diagram ? { diagram: data.ast.diagram } : {}),
    nodes: [...data.ast.nodes],
    edges: [...data.ast.edges],
    strokes: [...data.strokes.items],
    assets: data.assets.map((asset) => ({
      asset_id: asset.asset_id,
      display_no: asset.display_no,
      rect: asset.rect,
      z: asset.z,
    })),
  };
}

export function uncommittedStrokeSummary(
  strokes: readonly Stroke[],
): CaptureUncommittedSummary {
  return {
    strokes: { added: strokes.length, erased: 0 },
    nodes: { added: [], updated: [], moved: [], removed: [] },
    edges: { added: [], updated: [], removed: [] },
    assets: { added: [], moved: [], removed: [] },
  };
}

export function buildFrontendCapturePayload(
  currentLayer: GetData,
  uncommittedStrokes: readonly Stroke[],
  workingScene?: Scene | null,
  registeredAssets: GetData["assets"] = [],
): FrontendCapturePayload {
  const committed = sceneFromGetData(currentLayer);
  const scene: Scene = workingScene ?? {
    ...committed,
    strokes: [...committed.strokes, ...uncommittedStrokes],
  };
  return {
    based_on_layer: currentLayer.layer.id,
    based_on_seq: currentLayer.layer.seq,
    scene,
    layer: currentLayer.layer,
    assets: scene.assets.map((ref) => ({
      ...(currentLayer.assets.find((a) => a.asset_id === ref.asset_id) ??
        registeredAssets.find((a) => a.asset_id === ref.asset_id))!,
      ...ref,
    })),
    has_uncommitted: JSON.stringify(committed) !== JSON.stringify(scene),
    uncommitted: summarizeEdits(committed, scene),
    captured_at: new Date().toISOString(),
  };
}

export function strokePatch(strokes: readonly Stroke[]): ScenePatchStrokeInput {
  return { add_strokes: [...strokes] };
}
