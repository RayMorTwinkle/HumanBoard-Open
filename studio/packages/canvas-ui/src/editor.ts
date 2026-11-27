import type { Scene, Stroke } from "@humanboard/schema";
import type { CaptureUncommittedSummary } from "./client/types";

export const emptyScene = (): Scene => ({
  nodes: [],
  edges: [],
  strokes: [],
  assets: [],
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const scenesEqual = (a: Scene, b: Scene): boolean => same(a, b);

/** Erasing follows the visible polyline, including gaps between pointer samples. */
export function strokeTouchesEraser(
  stroke: Stroke,
  point: readonly [number, number],
  radius: number,
): boolean {
  const hitRadius = radius + Math.max(0, stroke.width) / 2;
  if (stroke.points.length === 1)
    return (
      Math.hypot(
        point[0] - stroke.points[0]![0],
        point[1] - stroke.points[0]![1],
      ) <= hitRadius
    );
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1]!,
      b = stroke.points[i]!;
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      length2 = dx * dx + dy * dy;
    const t = length2
      ? Math.max(
          0,
          Math.min(
            1,
            ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2,
          ),
        )
      : 0;
    if (
      Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)) <=
      hitRadius
    )
      return true;
  }
  return false;
}

export function summarizeEdits(
  base: Scene,
  next: Scene,
): CaptureUncommittedSummary {
  const delta = <T>(
    before: readonly T[],
    after: readonly T[],
    key: (x: T) => string,
  ) => {
    const a = new Map(before.map((x) => [key(x), x]));
    const b = new Map(after.map((x) => [key(x), x]));
    return {
      added: [...b.keys()].filter((id) => !a.has(id)),
      removed: [...a.keys()].filter((id) => !b.has(id)),
      changed: [...b.keys()].filter(
        (id) => a.has(id) && !same(a.get(id), b.get(id)),
      ),
    };
  };
  const nodes = delta(base.nodes, next.nodes, (x) => x.id);
  const edges = delta(base.edges, next.edges, (x) => x.id);
  const strokes = delta(base.strokes, next.strokes, (x) => x.id);
  const assets = delta(base.assets, next.assets, (x) => x.asset_id);
  return {
    strokes: {
      added: strokes.added.length + strokes.changed.length,
      erased: strokes.removed.length,
    },
    nodes: {
      added: nodes.added,
      removed: nodes.removed,
      moved: nodes.changed.filter(
        (id) =>
          !same(
            base.nodes.find((n) => n.id === id)!.rect,
            next.nodes.find((n) => n.id === id)!.rect,
          ),
      ),
      updated: nodes.changed.filter((id) => {
        const { rect: a, ...before } = base.nodes.find((n) => n.id === id)!;
        const { rect: b, ...after } = next.nodes.find((n) => n.id === id)!;
        return !same(before, after);
      }),
    },
    edges: {
      added: edges.added,
      removed: edges.removed,
      updated: edges.changed,
    },
    assets: {
      added: assets.added,
      removed: assets.removed,
      moved: assets.changed,
    },
  };
}

export function scenePatch(base: Scene, next: Scene) {
  const changed = <T>(a: T[], b: T[], key: (v: T) => string) =>
    b.filter(
      (x) =>
        !same(
          a.find((y) => key(x) === key(y)),
          x,
        ),
    );
  const removed = <T>(a: T[], b: T[], key: (v: T) => string) =>
    a.filter((x) => !b.some((y) => key(x) === key(y))).map(key);
  return {
    ...(!same(base.diagram, next.diagram)
      ? { diagram: next.diagram ?? null }
      : {}),
    upsert_nodes: next.diagram
      ? []
      : changed(base.nodes, next.nodes, (x) => x.id),
    remove_nodes: next.diagram
      ? []
      : removed(base.nodes, next.nodes, (x) => x.id),
    upsert_edges: next.diagram
      ? []
      : changed(base.edges, next.edges, (x) => x.id),
    remove_edges: next.diagram
      ? []
      : removed(base.edges, next.edges, (x) => x.id),
    add_strokes: changed(base.strokes, next.strokes, (x) => x.id),
    remove_strokes: removed(base.strokes, next.strokes, (x) => x.id),
    upsert_assets: changed(base.assets, next.assets, (x) => x.asset_id).map(
      ({ display_no, ...ref }) => ref,
    ),
    remove_assets: removed(base.assets, next.assets, (x) => x.asset_id),
  };
}
