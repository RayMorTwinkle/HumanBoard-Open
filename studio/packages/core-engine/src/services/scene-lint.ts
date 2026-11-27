import { canonicalJson, type Scene } from "@humanboard/schema";
import {
  edgeGeometry,
  edgePathPoints,
  edgeLabelPoint,
} from "../render/scene-svg";
export interface SceneWarning {
  readonly code: string;
  readonly message: string;
  readonly node_id?: string;
  readonly edge_id?: string;
}
/** Advisory only: never moves coordinates, rejects edits, or pretends to know user intent. */
export function coordinateDriftWarnings(
  base: Scene,
  target: Scene,
): SceneWarning[] {
  const previous = new Map(base.nodes.map((n) => [n.id, n]));
  const oldEdges = new Map(base.edges.map((e) => [e.id, e]));
  const newEdges = new Map(target.edges.map((e) => [e.id, e]));
  return target.nodes.flatMap((n) => {
    const old = previous.get(n.id);
    if (!old || canonicalJson(old.rect) === canonicalJson(n.rect)) return [];
    const fields = (v: typeof n) => ({
      kind: v.kind,
      title: v.title,
      ...(v.sub === undefined ? {} : { sub: v.sub }),
      ...(v.style === undefined ? {} : { style: v.style }),
    });
    if (canonicalJson(fields(old)) !== canonicalJson(fields(n))) return [];
    const changedAdjacent = [...base.edges, ...target.edges].some(
      (e) =>
        (e.from.node_id === n.id || e.to.node_id === n.id) &&
        (!oldEdges.has(e.id) || !newEdges.has(e.id)),
    );
    return changedAdjacent
      ? []
      : [
          {
            code: "W_COORD_DRIFT_SUSPECT",
            node_id: n.id,
            message:
              "rect 变化但无其他字段或相邻边增删；请确认这是显式移动，而非隐式重排。",
          },
        ];
  });
}
export function lintScene(scene: Scene): SceneWarning[] {
  const warnings: SceneWarning[] = [];
  const nodes = scene.nodes.filter((n) => n.kind !== "group");
  for (let i = 0; i < nodes.length && warnings.length < LIMIT; i++) {
    const n = nodes[i]!,
      r = n.rect;
    if (r.w < 32 || r.h < 28)
      warnings.push({
        code: "W_NODE_SMALL",
        node_id: n.id,
        message: "节点尺寸过小，标题可能无法阅读。",
      });
    for (let j = i + 1; j < nodes.length && warnings.length < LIMIT; j++) {
      const other = nodes[j]!,
        b = other.rect;
      if (
        Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x) > 8 &&
        Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y) > 8
      )
        warnings.push({
          code: "W_NODE_OVERLAP",
          node_id: n.id,
          message: `节点 ${n.id} 与 ${other.id} 重叠；若非有意叠放，请修正。`,
        });
    }
  }
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const routes: {
    edge: Scene["edges"][number];
    path: Point[];
    label: Point;
  }[] = [];
  for (const e of scene.edges) {
    const a = byId.get(e.from.node_id),
      b = byId.get(e.to.node_id);
    if (a && b) {
      const g = edgeGeometry(
        e,
        a.rect,
        b.rect,
        scene.diagram
          ? nodes
              .filter((n) => n.id !== a.id && n.id !== b.id)
              .map((n) => n.rect)
          : [],
      );
      routes.push({
        edge: e,
        path: edgePathPoints(g),
        label: edgeLabelPoint(g),
      });
    }
  }
  for (const { edge: e, path } of routes) {
    if (warnings.length >= LIMIT) break;
    for (const n of nodes) {
      if (n.id === e.from.node_id || n.id === e.to.node_id) continue;
      const hit = path.some(
        (to, i) => i > 0 && segmentCrosses(path[i - 1]!, to, n.rect),
      );
      if (hit) {
        warnings.push({
          code: "W_EDGE_CROSSES_NODE",
          edge_id: e.id,
          node_id: n.id,
          message: `连线 ${e.id} 穿过无关节点 ${n.id}，请查看预览。`,
        });
        break;
      }
    }
  }
  // Lines that share a card meet there by design; only unrelated pairs count.
  const crossings: [string, string][] = [];
  for (let i = 0; i < routes.length; i++)
    for (let j = i + 1; j < routes.length; j++) {
      const p = routes[i]!,
        q = routes[j]!;
      const ends = [p.edge.from.node_id, p.edge.to.node_id];
      if (
        ends.includes(q.edge.from.node_id) ||
        ends.includes(q.edge.to.node_id)
      )
        continue;
      if (pathsCross(p.path, q.path)) crossings.push([p.edge.id, q.edge.id]);
    }
  for (const [a, b] of crossings.slice(0, CROSSING_LIMIT)) {
    if (warnings.length >= LIMIT) break;
    warnings.push({
      code: "W_EDGE_CROSSES_EDGE",
      edge_id: a,
      message: `连线 ${a} 与 ${b} 交叉；可调整锚点或改用曲线绕开。`,
    });
  }
  if (crossings.length > CROSSING_LIMIT && warnings.length < LIMIT)
    warnings.push({
      code: "W_EDGE_CROSSES_EDGE",
      message: `另有 ${crossings.length - CROSSING_LIMIT} 处连线交叉。`,
    });
  const labels = routes.flatMap(({ edge: e, label }) =>
    e.label ? [{ id: e.id, edge: e, box: labelBox(e.label, label) }] : [],
  );
  for (const [i, label] of labels.entries()) {
    if (warnings.length >= LIMIT) break;
    const card = nodes.find(
      (n) =>
        n.id !== label.edge.from.node_id &&
        n.id !== label.edge.to.node_id &&
        overlaps(label.box, n.rect),
    );
    const other = labels.slice(i + 1).find((o) => overlaps(label.box, o.box));
    if (card || other)
      warnings.push({
        code: "W_LABEL_OVERLAP",
        edge_id: label.id,
        ...(card ? { node_id: card.id } : {}),
        message: card
          ? `连线 ${label.id} 的标签压在节点 ${card.id} 上。`
          : `连线 ${label.id} 与 ${other!.id} 的标签重叠。`,
      });
  }
  return warnings;
}

const LIMIT = 30;
const CROSSING_LIMIT = 5;
type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

/** Matches the renderer: 12px text centered 8px above the route's midpoint. */
function labelBox(text: string, mid: Point): Box {
  const w = [...text].reduce(
    (sum, ch) => sum + (/[\u2E80-\uFFFF]/.test(ch) ? 12 : 7),
    0,
  );
  return { x: mid.x - w / 2, y: mid.y - 20, w, h: 14 };
}

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2
  );
}

function pathsCross(p: Point[], q: Point[]): boolean {
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++)
      if (segmentsIntersect(p[i - 1]!, p[i]!, q[j - 1]!, q[j]!)) return true;
  return false;
}

/** Proper crossings only; touching or collinear runs are not reported. */
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Liang-Barsky clipping of one segment against a card's interior. */
function segmentCrosses(
  from: { x: number; y: number },
  to: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  let lo = 0,
    hi = 1;
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const pairs = [
    [-dx, from.x - r.x - 2],
    [dx, r.x + r.w - 2 - from.x],
    [-dy, from.y - r.y - 2],
    [dy, r.y + r.h - 2 - from.y],
  ] as const;
  for (const [p, q] of pairs) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
    if (lo > hi) return false;
  }
  return true;
}
