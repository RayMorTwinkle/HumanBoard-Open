import {
  SceneSchema,
  canonicalJson,
  type Edge,
  type Node,
  type Rect,
  type Scene,
  type Stroke,
} from "@humanboard/schema/scene";

import { HumanBoardError } from "../domain/errors";
import {
  edgeGeometry,
  computeScenesBounds,
  escapeSvgXml,
  formatSvgNumber,
  renderSceneBodyFromParsed,
  renderSceneEdges,
  renderSceneToSVG,
  renderSvgDocument,
  svgAttr,
  type Bounds,
  type SceneBoundsOptions,
} from "./scene-svg";

export interface RenderDiffOptions extends SceneBoundsOptions {
  readonly theme?: "light" | "dark";
  readonly background?: string;
  readonly assetImages?: Readonly<Record<string, string>>;
  readonly assetTitles?: Readonly<Record<string, string>>;
  readonly assetCards?: Readonly<
    Record<string, { readonly url: string; readonly description?: string }>
  >;
  readonly backgroundOpacity?: number;
  readonly clusterThreshold?: number;
  readonly boxPadding?: number;
}

export interface DiffSVGs {
  readonly bounds: Bounds;
  readonly before: string;
  readonly after: string;
  readonly highlight: string;
}

export interface SceneDiffBox {
  readonly id: string;
  readonly kind: "stroke" | "node";
  readonly rect: Rect;
  readonly stroke_ids?: string[];
  readonly node_ids?: string[];
  readonly edge_ids?: string[];
}

interface Box {
  readonly rect: Rect;
  readonly strokeIds: string[];
}

const DEFAULT_BACKGROUND_OPACITY = 0.28;
const DEFAULT_CLUSTER_THRESHOLD = 48;
const DEFAULT_BOX_PADDING = 8;
const RED_BOX = "#FF4A3A";
const PURPLE_BOX = "#A78BFA";

function optionNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new HumanBoardError(
      "E_USAGE",
      `${name} must be a non-negative number`,
    );
  }
  return resolved;
}

function opacity(value: number | undefined): number {
  const resolved = value ?? DEFAULT_BACKGROUND_OPACITY;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new HumanBoardError(
      "E_USAGE",
      "backgroundOpacity must be between 0 and 1",
    );
  }
  return resolved;
}

function strokeFingerprint(stroke: Stroke): string {
  const value: Record<string, unknown> = {
    points: stroke.points,
    tool: stroke.tool,
    color: stroke.color,
    width: stroke.width,
  };
  if (stroke.pressure !== undefined) {
    value.pressure = stroke.pressure;
  }
  return canonicalJson(value);
}

function sameStroke(left: Stroke, right: Stroke): boolean {
  return strokeFingerprint(left) === strokeFingerprint(right);
}

function strokeBBox(stroke: Stroke): Rect | null {
  if (stroke.points.length === 0) {
    return null;
  }
  let left = stroke.points[0]![0];
  let top = stroke.points[0]![1];
  let right = left;
  let bottom = top;
  for (const [x, y] of stroke.points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function expandBox(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

function mergeBoxes(left: Box, right: Box): Box {
  const x = Math.min(left.rect.x, right.rect.x);
  const y = Math.min(left.rect.y, right.rect.y);
  const rightEdge = Math.max(
    left.rect.x + left.rect.w,
    right.rect.x + right.rect.w,
  );
  const bottomEdge = Math.max(
    left.rect.y + left.rect.h,
    right.rect.y + right.rect.h,
  );
  return {
    rect: { x, y, w: rightEdge - x, h: bottomEdge - y },
    strokeIds: [...left.strokeIds, ...right.strokeIds],
  };
}

function boxDistance(left: Rect, right: Rect): number {
  const leftRight = left.x + left.w;
  const rightRight = right.x + right.w;
  const leftBottom = left.y + left.h;
  const rightBottom = right.y + right.h;
  const dx =
    leftRight < right.x
      ? right.x - leftRight
      : rightRight < left.x
        ? left.x - rightRight
        : 0;
  const dy =
    leftBottom < right.y
      ? right.y - leftBottom
      : rightBottom < left.y
        ? left.y - rightBottom
        : 0;
  return Math.hypot(dx, dy);
}

function clusterStrokeBoxes(
  incremental: readonly Stroke[],
  padding: number,
  threshold: number,
): Box[] {
  const boxes: Box[] = [];
  for (const stroke of incremental) {
    const bbox = strokeBBox(stroke);
    if (bbox) {
      boxes.push({
        rect: expandBox(bbox, padding),
        strokeIds: [stroke.id],
      });
    }
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (
      let leftIndex = 0;
      leftIndex < boxes.length && !merged;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < boxes.length;
        rightIndex += 1
      ) {
        if (
          boxDistance(boxes[leftIndex]!.rect, boxes[rightIndex]!.rect) <=
          threshold
        ) {
          boxes[leftIndex] = mergeBoxes(boxes[leftIndex]!, boxes[rightIndex]!);
          boxes.splice(rightIndex, 1);
          merged = true;
          break;
        }
      }
    }
  }

  return boxes;
}

function rectElement(
  rect: Rect,
  color: string,
  kind: "stroke" | "node",
  data: Record<string, string>,
): string {
  const attributes = Object.entries(data)
    .map(([key, value]) => svgAttr(`data-${key}`, value))
    .join(" ");
  return `<rect ${svgAttr("data-diff-box", kind)} ${attributes} ${svgAttr("x", formatSvgNumber(rect.x))} ${svgAttr("y", formatSvgNumber(rect.y))} ${svgAttr("width", formatSvgNumber(rect.w))} ${svgAttr("height", formatSvgNumber(rect.h))} fill="${color}" fill-opacity="0.05" stroke="${color}" stroke-width="2"${kind === "node" ? ' stroke-dasharray="6 4"' : ""} />`;
}

function edgeBBox(
  edge: Edge,
  nodesById: ReadonlyMap<string, Node>,
  padding: number,
  structured = false,
): Rect | null {
  const fromNode = nodesById.get(edge.from.node_id);
  const toNode = nodesById.get(edge.to.node_id);
  if (!fromNode || !toNode) {
    return null;
  }
  // A Bezier stays inside the hull of its control points.
  const g = edgeGeometry(
    edge,
    fromNode.rect,
    toNode.rect,
    structured
      ? [...nodesById.values()]
          .filter(
            (n) =>
              n.id !== fromNode.id && n.id !== toNode.id && n.kind !== "group",
          )
          .map((n) => n.rect)
      : [],
  );
  const points = [
    ...(g.points ?? [g.start, g.end]),
    ...(g.c1 && g.c2 ? [g.c1, g.c2] : []),
  ];
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const right = Math.max(...points.map((p) => p.x));
  const bottom = Math.max(...points.map((p) => p.y));
  return expandBox(
    { x: left, y: top, w: right - left, h: bottom - top },
    padding,
  );
}

function highlightBody(
  base: Scene,
  target: Scene,
  bounds: Bounds,
  backgroundOpacity: number,
  clusterThreshold: number,
  boxPadding: number,
  options: RenderDiffOptions,
): string {
  const targetStrokesById = new Map(
    target.strokes.map((stroke) => [stroke.id, stroke]),
  );
  const baseStrokesById = new Map(
    base.strokes.map((stroke) => [stroke.id, stroke]),
  );
  const unchangedStrokes = base.strokes.filter((stroke) => {
    const targetStroke = targetStrokesById.get(stroke.id);
    return targetStroke !== undefined && sameStroke(stroke, targetStroke);
  });
  const incrementalStrokes = target.strokes.filter((stroke) => {
    const baseStroke = baseStrokesById.get(stroke.id);
    return baseStroke === undefined || !sameStroke(baseStroke, stroke);
  });

  const grayscaleBase: Scene = {
    ...base,
    strokes: unchangedStrokes,
  };
  const baseBody = renderSceneBodyFromParsed(grayscaleBase, bounds, options);
  const incrementalBody = renderSceneBodyFromParsed(
    { nodes: [], edges: [], strokes: incrementalStrokes, assets: [] },
    bounds,
  );
  // Added objects are drawn in full color; the base layer only knows the old scene.
  const baseAssetIds = new Set(base.assets.map((asset) => asset.asset_id));
  const addedNodes = target.nodes.filter(
    (node) => !base.nodes.some((b) => b.id === node.id),
  );
  const addedEdges = target.edges.filter(
    (edge) => !base.edges.some((b) => b.id === edge.id),
  );
  const objectsBody =
    renderSceneBodyFromParsed(
      {
        nodes: addedNodes,
        edges: [],
        strokes: [],
        assets: target.assets.filter((a) => !baseAssetIds.has(a.asset_id)),
      },
      bounds,
      options,
    ) +
    renderSceneEdges(addedEdges, target.nodes, {
      ...options,
      routeStructuredEdges: !!target.diagram,
    });

  const boxes: string[] = [];
  for (const box of clusterStrokeBoxes(
    incrementalStrokes,
    boxPadding,
    clusterThreshold,
  )) {
    boxes.push(
      rectElement(box.rect, RED_BOX, "stroke", {
        "stroke-ids": box.strokeIds.join(","),
      }),
    );
  }

  const baseNodeIds = new Set(base.nodes.map((node) => node.id));
  const baseEdgeIds = new Set(base.edges.map((edge) => edge.id));
  const targetNodesById = new Map(target.nodes.map((node) => [node.id, node]));
  for (const node of target.nodes) {
    if (!baseNodeIds.has(node.id)) {
      boxes.push(
        rectElement(expandBox(node.rect, boxPadding), PURPLE_BOX, "node", {
          "node-id": node.id,
        }),
      );
    }
  }
  for (const edge of target.edges) {
    if (!baseEdgeIds.has(edge.id)) {
      const bbox = edgeBBox(
        edge,
        targetNodesById,
        boxPadding,
        !!target.diagram,
      );
      if (bbox) {
        boxes.push(
          rectElement(bbox, PURPLE_BOX, "node", {
            "edge-id": edge.id,
          }),
        );
      }
    }
  }

  return [
    `<g data-highlight="base" ${svgAttr("opacity", formatSvgNumber(backgroundOpacity))} filter="url(#hb-grayscale)">${baseBody}</g>`,
    `<g data-highlight="incremental-objects">${objectsBody}</g>`,
    `<g data-highlight="incremental-strokes">${incrementalBody}</g>`,
    `<g data-highlight="boxes">${boxes.join("")}</g>`,
  ].join("");
}

export function renderDiffToSVGs(
  baseInput: Scene,
  targetInput: Scene,
  options: RenderDiffOptions = {},
): DiffSVGs {
  const base = SceneSchema.parse(baseInput);
  const target = SceneSchema.parse(targetInput);
  const bounds = computeScenesBounds([base, target], options);
  const background =
    options.background ??
    (options.theme === "dark" ? "transparent" : "#FFFFFF");
  const backgroundOpacity = opacity(options.backgroundOpacity);
  const clusterThreshold = optionNumber(
    options.clusterThreshold,
    DEFAULT_CLUSTER_THRESHOLD,
    "clusterThreshold",
  );
  const boxPadding = optionNumber(
    options.boxPadding,
    DEFAULT_BOX_PADDING,
    "boxPadding",
  );

  const sceneOptions = {
    theme: options.theme,
    assetImages: options.assetImages,
    assetTitles: options.assetTitles,
    assetCards: options.assetCards,
    bounds,
    background,
  };
  const before = renderSceneToSVG(base, sceneOptions);
  const after = renderSceneToSVG(target, sceneOptions);
  const defs =
    '<defs><filter id="hb-grayscale" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0" /></filter></defs>';
  const highlight = renderSvgDocument(
    highlightBody(
      base,
      target,
      bounds,
      backgroundOpacity,
      clusterThreshold,
      boxPadding,
      options,
    ),
    bounds,
    background,
    defs,
    "HumanBoard Diff Highlight",
  );

  return { bounds, before, after, highlight };
}

export function computeDiffBoxes(
  baseInput: Scene,
  targetInput: Scene,
  options: Pick<RenderDiffOptions, "clusterThreshold" | "boxPadding"> = {},
): SceneDiffBox[] {
  const base = SceneSchema.parse(baseInput);
  const target = SceneSchema.parse(targetInput);
  const clusterThreshold = optionNumber(
    options.clusterThreshold,
    DEFAULT_CLUSTER_THRESHOLD,
    "clusterThreshold",
  );
  const boxPadding = optionNumber(
    options.boxPadding,
    DEFAULT_BOX_PADDING,
    "boxPadding",
  );
  const baseStrokesById = new Map(
    base.strokes.map((stroke) => [stroke.id, stroke]),
  );
  const incremental = target.strokes.filter((stroke) => {
    const baseStroke = baseStrokesById.get(stroke.id);
    return baseStroke === undefined || !sameStroke(baseStroke, stroke);
  });

  const boxes: SceneDiffBox[] = [];
  for (const [index, box] of clusterStrokeBoxes(
    incremental,
    boxPadding,
    clusterThreshold,
  ).entries()) {
    boxes.push({
      id: `A${index + 1}`,
      kind: "stroke",
      rect: box.rect,
      stroke_ids: box.strokeIds,
    });
  }

  const baseNodeIds = new Set(base.nodes.map((node) => node.id));
  const baseEdgeIds = new Set(base.edges.map((edge) => edge.id));
  const targetNodesById = new Map(target.nodes.map((node) => [node.id, node]));
  const nodeIds: string[] = [];
  for (const node of target.nodes) {
    if (!baseNodeIds.has(node.id)) {
      nodeIds.push(node.id);
      boxes.push({
        id: `N${nodeIds.length}`,
        kind: "node",
        rect: expandBox(node.rect, boxPadding),
        node_ids: [node.id],
      });
    }
  }

  let edgeBoxIndex = 0;
  for (const edge of target.edges) {
    if (baseEdgeIds.has(edge.id)) {
      continue;
    }
    const bbox = edgeBBox(edge, targetNodesById, boxPadding, !!target.diagram);
    if (bbox) {
      edgeBoxIndex += 1;
      boxes.push({
        id: `N${nodeIds.length + edgeBoxIndex}`,
        kind: "node",
        rect: bbox,
        node_ids: [],
        edge_ids: [edge.id],
      });
    }
  }

  return boxes;
}

export function diffBoxCenter(box: Rect): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

export function strokeBoundingBox(stroke: Stroke): Rect | null {
  return strokeBBox(stroke);
}

export function incrementalStrokes(base: Scene, target: Scene): Stroke[] {
  const baseById = new Map(base.strokes.map((stroke) => [stroke.id, stroke]));
  return target.strokes.filter((stroke) => {
    const previous = baseById.get(stroke.id);
    return previous === undefined || !sameStroke(previous, stroke);
  });
}
