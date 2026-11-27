import type { Rect, Scene } from "@humanboard/schema/scene";
type Point = { x: number; y: number };
export interface Camera extends Point {
  k: number;
}
export function extent(scene: Scene): Rect {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (x: number, y: number, w = 0, h = 0) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + w);
    bottom = Math.max(bottom, y + h);
  };
  for (const { rect } of [...scene.nodes, ...scene.assets])
    include(rect.x, rect.y, rect.w, rect.h);
  for (const s of scene.strokes) for (const [x, y] of s.points) include(x, y);
  return Number.isFinite(left)
    ? {
        x: left - 48,
        y: top - 48,
        w: Math.max(1, right - left) + 96,
        h: Math.max(1, bottom - top) + 96,
      }
    : { x: 0, y: 0, w: 760, h: 420 };
}
export function fit(bounds: Rect, w: number, h: number): Camera {
  const top = Math.min(68, h / 4),
    bottom = Math.min(100, h / 4);
  const k = Math.max(
    0.01,
    Math.min(1.25, w / bounds.w, (h - top - bottom) / bounds.h),
  );
  return {
    k,
    x: (w - k * bounds.w) / 2 - bounds.x * k,
    y: (h + top - bottom - k * bounds.h) / 2 - bounds.y * k,
  };
}
export function zoomAt(c: Camera, p: Point, factor: number): Camera {
  const k = Math.min(6, Math.max(0.01, c.k * factor)),
    r = k / c.k;
  return { k, x: p.x - (p.x - c.x) * r, y: p.y - (p.y - c.y) * r };
}
