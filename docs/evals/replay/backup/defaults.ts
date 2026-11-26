import { compileDiagram, DiagramSchema } from "./diagram";
import type { Rect } from "./schema";

/** Size a new card gets when its rect only says where it goes. */
export const DEFAULT_NODE_SIZE = { w: 184, h: 68 } as const;

type Side = "top" | "right" | "bottom" | "left";

/** The two sides that face each other, judged from the cards' centers. */
export function facingAnchors(from: Rect, to: Rect): { from: Side; to: Side } {
  const dx = to.x + to.w / 2 - from.x - from.w / 2,
    dy = to.y + to.h / 2 - from.y - from.h / 2;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? { from: "right", to: "left" }
      : { from: "left", to: "right" }
    : dy >= 0
      ? { from: "bottom", to: "top" }
      : { from: "top", to: "bottom" };
}

type Loose = Record<string, unknown>;
const isRecord = (v: unknown): v is Loose =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Fills what an author may leave out, before validation. Only missing values are
 * filled and the result is stored fully spelled out, so hashes and later reads see
 * ordinary explicit coordinates — nothing is laid out after the fact.
 *
 * - node `rect: {x, y}` gets the default card size
 * - edge `from` / `to` may be a bare node id or `{node_id}`; `side` defaults to the
 *   facing sides of the two cards and `offset` to 0.5
 */
export function resolveSceneDefaults<T>(scene: T): T {
  if (!isRecord(scene)) return scene;
  if (scene.diagram) {
    const d = DiagramSchema.parse(scene.diagram);
    const compiled = compileDiagram(
      d,
      Array.isArray(scene.nodes)
        ? (scene.nodes as import("./schema").Node[])
        : [],
    );
    Object.assign(scene, {
      diagram: d,
      nodes: compiled.nodes,
      edges: compiled.edges,
    });
  }
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  for (const node of nodes) {
    if (!isRecord(node) || !isRecord(node.rect)) continue;
    const rect = node.rect;
    if (isNumber(rect.x) && isNumber(rect.y)) {
      if (rect.w === undefined) rect.w = DEFAULT_NODE_SIZE.w;
      if (rect.h === undefined) rect.h = DEFAULT_NODE_SIZE.h;
    }
  }
  const rects = new Map<string, Rect>();
  for (const node of nodes)
    if (
      isRecord(node) &&
      typeof node.id === "string" &&
      isRecord(node.rect) &&
      [node.rect.x, node.rect.y, node.rect.w, node.rect.h].every(isNumber)
    )
      rects.set(node.id, node.rect as unknown as Rect);
  for (const edge of Array.isArray(scene.edges) ? scene.edges : []) {
    if (!isRecord(edge)) continue;
    for (const end of ["from", "to"] as const)
      if (typeof edge[end] === "string") edge[end] = { node_id: edge[end] };
    const from = edge.from,
      to = edge.to;
    if (!isRecord(from) || !isRecord(to)) continue;
    const a = rects.get(String(from.node_id)),
      b = rects.get(String(to.node_id));
    if ((from.side === undefined || to.side === undefined) && a && b) {
      const sides = facingAnchors(a, b);
      if (from.side === undefined) from.side = sides.from;
      if (to.side === undefined) to.side = sides.to;
    }
    if (from.offset === undefined) from.offset = 0.5;
    if (to.offset === undefined) to.offset = 0.5;
  }
  return scene;
}
