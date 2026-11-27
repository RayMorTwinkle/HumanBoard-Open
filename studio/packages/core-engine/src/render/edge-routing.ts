import type { Anchor, Edge, Rect } from "@humanboard/schema/scene";

type Point = { x: number; y: number };
export interface EdgeGeometry {
  start: Point;
  end: Point;
  c1?: Point;
  c2?: Point;
  points?: Point[];
}

function crosses(a: Point, b: Point, r: Rect): boolean {
  let lo = 0,
    hi = 1;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ]) {
    if (Math.abs(p!) < 1e-9) {
      if (q! <= 0) return false;
    } else if (p! < 0) lo = Math.max(lo, q! / p!);
    else hi = Math.min(hi, q! / p!);
    if (lo >= hi) return false;
  }
  return true;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
});
const clear = (points: Point[], obstacles: readonly Rect[]) =>
  points.every(
    (b, i) => !i || obstacles.every((r) => !crosses(points[i - 1]!, b, r)),
  );
function simplify(points: Point[]) {
  const result: Point[] = [];
  for (const p of points) {
    if (result.length && distance(result[result.length - 1]!, p) < 0.001)
      continue;
    while (result.length > 1) {
      const a = result[result.length - 2]!,
        b = result[result.length - 1]!;
      if (
        Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) >
          0.001 ||
        (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) < 0
      )
        break;
      result.pop();
    }
    result.push(p);
  }
  return result;
}

/** Obstacles are supplied only for structure diagrams; explicit free-board routes stay intact. */
export function edgeGeometry(
  edge: Edge,
  from: Rect,
  to: Rect,
  obstacles: readonly Rect[] = [],
): EdgeGeometry {
  const original = baseGeometry(edge, from, to);
  if (
    !obstacles.length ||
    clear(
      edgePathPoints(original),
      obstacles.map((r) => inflate(r, 6)),
    )
  )
    return original;
  const a = SIDE_NORMAL[edge.from.side],
    b = SIDE_NORMAL[edge.to.side];
  const start = {
    x: original.start.x + a.x * 24,
    y: original.start.y + a.y * 24,
  };
  const end = { x: original.end.x + b.x * 24, y: original.end.y + b.y * 24 };
  const blocked = [...obstacles, from, to].map((r) => inflate(r, 12));
  const candidates: Point[][] = [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  ];
  for (const r of blocked) {
    for (const x of [r.x, r.x + r.w])
      candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]);
    for (const y of [r.y, r.y + r.h])
      candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]);
  }
  candidates.sort((p, q) => length(p) - length(q));
  let route = candidates.find((p) => clear(p, blocked));
  if (!route) route = gridRoute(start, end, blocked);
  if (!route) return original; // Impossible/oversized routes retain advisory lint warnings.
  const points = simplify([original.start, ...route, original.end]);
  if (!clear(points, obstacles)) return original;
  return { start: original.start, end: original.end, points };
}
function length(points: Point[]) {
  return points
    .slice(1)
    .reduce((sum, p, i) => sum + distance(points[i]!, p), 0);
}

/** Bounded rectilinear visibility grid, used only when simple channels are blocked. */
function gridRoute(
  start: Point,
  end: Point,
  blocked: Rect[],
): Point[] | undefined {
  const xs = [
    ...new Set([start.x, end.x, ...blocked.flatMap((r) => [r.x, r.x + r.w])]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([start.y, end.y, ...blocked.flatMap((r) => [r.y, r.y + r.h])]),
  ].sort((a, b) => a - b);
  if (xs.length * ys.length > 12000) return;
  const key = (x: number, y: number) => y * xs.length + x;
  const source = key(xs.indexOf(start.x), ys.indexOf(start.y)),
    target = key(xs.indexOf(end.x), ys.indexOf(end.y));
  const open = new Set([source]),
    cost = new Map([[source, 0]]),
    previous = new Map<number, number>();
  const point = (id: number) => ({
    x: xs[id % xs.length]!,
    y: ys[Math.floor(id / xs.length)]!,
  });
  const valid = new Map<string, boolean>();
  for (let step = 0; open.size && step < 12000; step++) {
    let best = -1,
      score = Infinity;
    for (const id of open) {
      const s = cost.get(id)! + distance(point(id), end);
      if (s < score) {
        score = s;
        best = id;
      }
    }
    if (best === target) {
      const result = [point(best)];
      while (previous.has(best)) {
        best = previous.get(best)!;
        result.unshift(point(best));
      }
      return simplify(result);
    }
    open.delete(best);
    const x = best % xs.length,
      y = Math.floor(best / xs.length),
      p = point(best);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx! < 0 || ny! < 0 || nx! >= xs.length || ny! >= ys.length) continue;
      const id = key(nx!, ny!),
        q = point(id),
        cacheKey = best < id ? `${best}:${id}` : `${id}:${best}`;
      let pass = valid.get(cacheKey);
      if (pass === undefined) {
        pass = clear([p, q], blocked);
        valid.set(cacheKey, pass);
      }
      const candidate = cost.get(best)! + distance(p, q);
      if (pass && candidate < (cost.get(id) ?? Infinity)) {
        cost.set(id, candidate);
        previous.set(id, best);
        open.add(id);
      }
    }
  }
}

export function edgePathPoints(g: EdgeGeometry, steps = 48): Point[] {
  if (g.points) return g.points;
  if (!g.c1 || !g.c2) return [g.start, g.end];
  const { start: a, end: d, c1: b, c2: c } = g;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps,
      u = 1 - t;
    return {
      x:
        u * u * u * a.x +
        3 * u * u * t * b.x +
        3 * u * t * t * c.x +
        t * t * t * d.x,
      y:
        u * u * u * a.y +
        3 * u * u * t * b.y +
        3 * u * t * t * c.y +
        t * t * t * d.y,
    };
  });
}
export function edgeLabelPoint(g: EdgeGeometry): Point {
  if (g.points) {
    const segments = g.points.slice(1).map((b, i) => ({ a: g.points![i]!, b }));
    // Prefer a long horizontal channel so the label does not straddle a bend.
    segments.sort(
      (s, t) =>
        (Math.abs(t.a.y - t.b.y) < 0.01 ? 1 : 0) -
          (Math.abs(s.a.y - s.b.y) < 0.01 ? 1 : 0) ||
        distance(t.a, t.b) - distance(s.a, s.b),
    );
    const s = segments[0];
    if (s) return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
  }
  if (g.c1 && g.c2)
    return {
      x: (g.start.x + 3 * g.c1.x + 3 * g.c2.x + g.end.x) / 8,
      y: (g.start.y + 3 * g.c1.y + 3 * g.c2.y + g.end.y) / 8,
    };
  return { x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2 };
}

export function computeAnchorPoint(
  rect: Rect,
  anchor: Anchor,
): { x: number; y: number } {
  switch (anchor.side) {
    case "top":
      return { x: rect.x + rect.w * anchor.offset, y: rect.y };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h * anchor.offset };
    case "bottom":
      return { x: rect.x + rect.w * anchor.offset, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h * anchor.offset };
  }
}

const SIDE_NORMAL = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
} as const;

/** Endpoints, plus Bezier control points when the edge is curved. */
function baseGeometry(edge: Edge, fromRect: Rect, toRect: Rect): EdgeGeometry {
  const start = computeAnchorPoint(fromRect, edge.from);
  const end = computeAnchorPoint(toRect, edge.to);
  if (edge.style?.curve !== true) return { start, end };
  const reach = Math.min(
    160,
    Math.max(40, Math.hypot(end.x - start.x, end.y - start.y) * 0.45),
  );
  const a = SIDE_NORMAL[edge.from.side],
    b = SIDE_NORMAL[edge.to.side];
  return {
    start,
    end,
    c1: { x: start.x + a.x * reach, y: start.y + a.y * reach },
    c2: { x: end.x + b.x * reach, y: end.y + b.y * reach },
  };
}
