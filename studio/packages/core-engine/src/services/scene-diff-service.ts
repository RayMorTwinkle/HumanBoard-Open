import {
  canonicalJson,
  type AssetRef,
  type Edge,
  type Node,
  type Rect,
  type Scene,
  type Stroke,
} from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import type { Layer, ULID } from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";

export type SceneDiffMode = "empty" | "transform" | "ast" | "visual" | "mixed";

export interface NodeRectChange {
  readonly id: string;
  readonly from: Rect;
  readonly to: Rect;
}

export interface FieldUpdate {
  readonly id: string;
  readonly fields: string[];
}

export interface SceneAstDiff {
  readonly nodes: {
    readonly added: Node[];
    readonly removed: Node[];
    readonly moved: NodeRectChange[];
    readonly resized: NodeRectChange[];
    readonly updated: FieldUpdate[];
  };
  readonly edges: {
    readonly added: Edge[];
    readonly removed: Edge[];
    readonly updated: FieldUpdate[];
  };
  readonly assets: {
    readonly added: AssetRef[];
    readonly removed: AssetRef[];
    readonly updated: FieldUpdate[];
  };
}

export interface SceneVisualDiff {
  readonly strokes: {
    readonly added: Stroke[];
    readonly removed: Stroke[];
    readonly updated: FieldUpdate[];
  };
}

export interface SceneAstSummary {
  readonly nodes: number;
  readonly edges: number;
  readonly notable: string[];
}

export interface SceneDiffResult {
  readonly mode: SceneDiffMode;
  readonly ancestor: boolean;
  readonly summary: string;
  readonly ast?: SceneAstDiff;
  readonly ast_summary?: SceneAstSummary;
  readonly visual?: SceneVisualDiff;
}

export interface SceneDiffOptions {
  readonly ancestor?: boolean;
}

const NODE_CONTENT_FIELDS = ["kind", "title", "sub", "style"] as const;
const EDGE_CONTENT_FIELDS = ["from", "to", "label", "style"] as const;
const STROKE_CONTENT_FIELDS = [
  "tool",
  "color",
  "width",
  "points",
  "pressure",
] as const;
const ASSET_CONTENT_FIELDS = ["display_no", "rect", "z"] as const;

function stableValue(value: unknown): string {
  return value === undefined ? "undefined" : canonicalJson(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right);
}

function changedFields<T extends object>(
  base: T,
  target: T,
  fields: readonly string[],
): string[] {
  return fields.filter(
    (field) =>
      !sameValue(
        (base as Record<string, unknown>)[field],
        (target as Record<string, unknown>)[field],
      ),
  );
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.w === right.w &&
    left.h === right.h
  );
}

function diffNodes(baseNodes: readonly Node[], targetNodes: readonly Node[]) {
  const baseById = new Map(baseNodes.map((node) => [node.id, node]));
  const targetById = new Map(targetNodes.map((node) => [node.id, node]));
  const added = targetNodes.filter((node) => !baseById.has(node.id));
  const removed = baseNodes.filter((node) => !targetById.has(node.id));
  const moved: NodeRectChange[] = [];
  const resized: NodeRectChange[] = [];
  const updated: FieldUpdate[] = [];

  for (const baseNode of baseNodes) {
    const targetNode = targetById.get(baseNode.id);
    if (!targetNode) {
      continue;
    }

    const fields = changedFields(baseNode, targetNode, NODE_CONTENT_FIELDS);
    if (fields.length > 0) {
      updated.push({ id: baseNode.id, fields });
    }

    if (!sameRect(baseNode.rect, targetNode.rect)) {
      const positionChanged =
        baseNode.rect.x !== targetNode.rect.x ||
        baseNode.rect.y !== targetNode.rect.y;
      const sizeChanged =
        baseNode.rect.w !== targetNode.rect.w ||
        baseNode.rect.h !== targetNode.rect.h;

      if (fields.length === 0 && positionChanged) {
        moved.push({
          id: baseNode.id,
          from: baseNode.rect,
          to: targetNode.rect,
        });
      }
      if (fields.length === 0 && !positionChanged && sizeChanged) {
        resized.push({
          id: baseNode.id,
          from: baseNode.rect,
          to: targetNode.rect,
        });
      }
    }
  }

  return { added, removed, moved, resized, updated };
}

function diffEdges(baseEdges: readonly Edge[], targetEdges: readonly Edge[]) {
  const baseById = new Map(baseEdges.map((edge) => [edge.id, edge]));
  const targetById = new Map(targetEdges.map((edge) => [edge.id, edge]));
  const added = targetEdges.filter((edge) => !baseById.has(edge.id));
  const removed = baseEdges.filter((edge) => !targetById.has(edge.id));
  const updated: FieldUpdate[] = [];

  for (const baseEdge of baseEdges) {
    const targetEdge = targetById.get(baseEdge.id);
    if (!targetEdge) {
      continue;
    }
    const fields = changedFields(baseEdge, targetEdge, EDGE_CONTENT_FIELDS);
    if (fields.length > 0) {
      updated.push({ id: baseEdge.id, fields });
    }
  }

  return { added, removed, updated };
}

function diffAssets(
  baseAssets: readonly AssetRef[],
  targetAssets: readonly AssetRef[],
) {
  const baseById = new Map(baseAssets.map((asset) => [asset.asset_id, asset]));
  const targetById = new Map(
    targetAssets.map((asset) => [asset.asset_id, asset]),
  );
  const added = targetAssets.filter((asset) => !baseById.has(asset.asset_id));
  const removed = baseAssets.filter((asset) => !targetById.has(asset.asset_id));
  const updated: FieldUpdate[] = [];

  for (const baseAsset of baseAssets) {
    const targetAsset = targetById.get(baseAsset.asset_id);
    if (!targetAsset) {
      continue;
    }
    const fields = changedFields(baseAsset, targetAsset, ASSET_CONTENT_FIELDS);
    if (fields.length > 0) {
      updated.push({ id: baseAsset.asset_id, fields });
    }
  }

  return { added, removed, updated };
}

function diffStrokes(
  baseStrokes: readonly Stroke[],
  targetStrokes: readonly Stroke[],
) {
  const baseById = new Map(baseStrokes.map((stroke) => [stroke.id, stroke]));
  const targetById = new Map(
    targetStrokes.map((stroke) => [stroke.id, stroke]),
  );
  const added = targetStrokes.filter((stroke) => !baseById.has(stroke.id));
  const removed = baseStrokes.filter((stroke) => !targetById.has(stroke.id));
  const updated: FieldUpdate[] = [];

  for (const baseStroke of baseStrokes) {
    const targetStroke = targetById.get(baseStroke.id);
    if (!targetStroke) {
      continue;
    }
    const fields = changedFields(
      baseStroke,
      targetStroke,
      STROKE_CONTENT_FIELDS,
    );
    if (fields.length > 0) {
      updated.push({ id: baseStroke.id, fields });
    }
  }

  return { added, removed, updated };
}

function hasNodeChanges(nodes: SceneAstDiff["nodes"]): boolean {
  return (
    nodes.added.length > 0 ||
    nodes.removed.length > 0 ||
    nodes.moved.length > 0 ||
    nodes.resized.length > 0 ||
    nodes.updated.length > 0
  );
}

function hasEdgeChanges(edges: SceneAstDiff["edges"]): boolean {
  return (
    edges.added.length > 0 ||
    edges.removed.length > 0 ||
    edges.updated.length > 0
  );
}

function hasAssetChanges(assets: SceneAstDiff["assets"]): boolean {
  return (
    assets.added.length > 0 ||
    assets.removed.length > 0 ||
    assets.updated.length > 0
  );
}

function hasVisualChanges(visual: SceneVisualDiff): boolean {
  return (
    visual.strokes.added.length > 0 ||
    visual.strokes.removed.length > 0 ||
    visual.strokes.updated.length > 0
  );
}

function astSummary(target: Scene, ast: SceneAstDiff): SceneAstSummary {
  return {
    nodes: target.nodes.length,
    edges: target.edges.length,
    notable: ast.nodes.added.map((node) => node.title || node.id),
  };
}

function summaryFor(
  mode: SceneDiffMode,
  ast: SceneAstDiff,
  visual: SceneVisualDiff,
): string {
  const parts: string[] = [];

  if (mode === "empty") {
    return "";
  }
  if (mode === "transform") {
    return `@转化：首次结构化生成 ${astSummaryFromAst(ast).nodes} 个节点、${astSummaryFromAst(ast).edges} 条边`;
  }

  if (hasNodeChanges(ast.nodes)) {
    parts.push(
      `节点 +${ast.nodes.added.length}/-${ast.nodes.removed.length}/移${ast.nodes.moved.length}/缩放${ast.nodes.resized.length}/改${ast.nodes.updated.length}`,
    );
  }
  if (hasEdgeChanges(ast.edges)) {
    parts.push(
      `连线 +${ast.edges.added.length}/-${ast.edges.removed.length}/改${ast.edges.updated.length}`,
    );
  }
  if (hasAssetChanges(ast.assets)) {
    parts.push(
      `资产 +${ast.assets.added.length}/-${ast.assets.removed.length}/改${ast.assets.updated.length}`,
    );
  }
  if (hasVisualChanges(visual)) {
    parts.push(
      `笔迹 +${visual.strokes.added.length}/-${visual.strokes.removed.length}/改${visual.strokes.updated.length}`,
    );
  }

  return parts.join("；");
}

function astSummaryFromAst(ast: SceneAstDiff): {
  nodes: number;
  edges: number;
} {
  return {
    nodes: ast.nodes.added.length,
    edges: ast.edges.added.length,
  };
}

export function diffScenes(
  base: Scene,
  target: Scene,
  options: SceneDiffOptions = {},
): SceneDiffResult {
  const ast: SceneAstDiff = {
    nodes: diffNodes(base.nodes, target.nodes),
    edges: diffEdges(base.edges, target.edges),
    assets: diffAssets(base.assets, target.assets),
  };
  const visual: SceneVisualDiff = {
    strokes: diffStrokes(base.strokes, target.strokes),
  };
  const structuralChanged =
    hasNodeChanges(ast.nodes) ||
    hasEdgeChanges(ast.edges) ||
    hasAssetChanges(ast.assets);
  const visualChanged = hasVisualChanges(visual);
  const firstStructure = base.nodes.length === 0 && target.nodes.length > 0;
  const ancestor = options.ancestor ?? true;

  let mode: SceneDiffMode;
  if (firstStructure) {
    mode = "transform";
  } else if (!structuralChanged && !visualChanged) {
    mode = "empty";
  } else if (structuralChanged && visualChanged) {
    mode = "mixed";
  } else if (visualChanged) {
    mode = "visual";
  } else {
    mode = "ast";
  }

  const summary = summaryFor(mode, ast, visual);
  const summaryWithAncestor =
    ancestor || summary.length === 0 ? summary : `跨分支对比：${summary}`;

  if (mode === "empty") {
    return { mode, ancestor, summary: summaryWithAncestor };
  }
  if (mode === "transform") {
    return {
      mode,
      ancestor,
      summary: summaryWithAncestor,
      ast_summary: astSummary(target, ast),
    };
  }
  if (mode === "visual") {
    return { mode, ancestor, summary: summaryWithAncestor, visual };
  }
  if (mode === "mixed") {
    return { mode, ancestor, summary: summaryWithAncestor, ast, visual };
  }
  return { mode, ancestor, summary: summaryWithAncestor, ast };
}

export class SceneDiffService {
  constructor(private readonly storage: StorageAdapter) {}

  diffScenes(
    base: Scene,
    target: Scene,
    options: SceneDiffOptions = {},
  ): SceneDiffResult {
    return diffScenes(base, target, options);
  }

  async diffLayers(
    baseLayerId: ULID,
    targetLayerId: ULID,
  ): Promise<SceneDiffResult> {
    const baseLayer = await this.requireLayer(baseLayerId);
    const targetLayer = await this.requireLayer(targetLayerId);
    if (baseLayer.space_id !== targetLayer.space_id) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        "Cannot diff layers from different Spaces",
        { base_layer_id: baseLayerId, target_layer_id: targetLayerId },
      );
    }

    const baseScene = await this.storage.getLayerScene(baseLayerId);
    const targetScene = await this.storage.getLayerScene(targetLayerId);
    if (!baseScene || !targetScene) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        "One or both layers do not have a stored Scene",
      );
    }

    return diffScenes(baseScene, targetScene, {
      ancestor: await this.isAncestor(baseLayer, targetLayer),
    });
  }

  private async requireLayer(layerId: ULID): Promise<Layer> {
    const layer = await this.storage.getLayer(layerId);
    if (!layer) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${layerId} does not exist`,
      );
    }
    return layer;
  }

  private async isAncestor(
    baseLayer: Layer,
    targetLayer: Layer,
  ): Promise<boolean> {
    const visited = new Set<ULID>();
    let currentId = targetLayer.parent_id;

    while (currentId && !visited.has(currentId)) {
      if (currentId === baseLayer.id) {
        return true;
      }
      visited.add(currentId);
      const current = await this.storage.getLayer(currentId);
      currentId = current?.parent_id ?? null;
    }

    return false;
  }
}
