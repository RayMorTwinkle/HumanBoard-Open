import {
  edgeGeometry,
  edgePathPoints,
  edgeLabelPoint,
} from "@humanboard/core-engine/scene-svg";
import type { Rect, Scene } from "@humanboard/schema";
export type ResizeCorner = "nw" | "ne" | "sw" | "se";
export interface CanvasFrame {
  bounds: Rect;
  image: { left: number; top: number; width: number; height: number };
}
/** A gesture keeps this frame even when its contents grow beyond the old bounds. */
export function scenePoint(
  client: readonly [number, number],
  frame: CanvasFrame,
): [number, number] | null {
  const { image, bounds } = frame;
  if (image.width <= 0 || image.height <= 0) return null;
  return [
    bounds.x + ((client[0] - image.left) / image.width) * bounds.w,
    bounds.y + ((client[1] - image.top) / image.height) * bounds.h,
  ];
}
export function resizeRect(
  rect: Rect,
  corner: ResizeCorner,
  delta: readonly [number, number],
  keepAspect = false,
  minimum = 16,
): Rect {
  const west = corner.includes("w"),
    north = corner.includes("n");
  let w = Math.max(minimum, rect.w + (west ? -delta[0] : delta[0]));
  let h = Math.max(minimum, rect.h + (north ? -delta[1] : delta[1]));
  if (keepAspect && rect.w > 0 && rect.h > 0) {
    const sx = 1 + (west ? -delta[0] : delta[0]) / rect.w;
    const sy = 1 + (north ? -delta[1] : delta[1]) / rect.h;
    const scale = Math.max(
      Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy,
      minimum / rect.w,
      minimum / rect.h,
    );
    w = rect.w * scale;
    h = rect.h * scale;
  }
  return {
    x: west ? rect.x + rect.w - w : rect.x,
    y: north ? rect.y + rect.h - h : rect.y,
    w,
    h,
  };
}
export function objectRect(scene: Scene, id: string | null): Rect | undefined {
  if (!id) return;
  return id.startsWith("asset:")
    ? scene.assets.find((a) => a.asset_id === id.slice(6))?.rect
    : scene.nodes.find((n) => n.id === id)?.rect;
}
export function updateObjectRect(scene: Scene, id: string, rect: Rect): Scene {
  const previous = objectRect(scene, id);
  if (
    !previous ||
    !Object.values(rect).every(Number.isFinite) ||
    (rect.w < 16 && rect.w !== previous.w) ||
    (rect.h < 16 && rect.h !== previous.h)
  )
    return scene;
  return id.startsWith("asset:")
    ? {
        ...scene,
        assets: scene.assets.map((a) =>
          a.asset_id === id.slice(6) ? { ...a, rect } : a,
        ),
      }
    : {
        ...scene,
        nodes: scene.nodes.map((n) => (n.id === id ? { ...n, rect } : n)),
      };
}
export function hitResizeCorner(
  rect: Rect,
  client: readonly [number, number],
  frame: CanvasFrame,
  radius = 10,
): ResizeCorner | null {
  for (const corner of ["nw", "ne", "sw", "se"] as const) {
    const x = rect.x + (corner.includes("e") ? rect.w : 0),
      y = rect.y + (corner.includes("s") ? rect.h : 0);
    const px =
      frame.image.left +
      ((x - frame.bounds.x) / frame.bounds.w) * frame.image.width;
    const py =
      frame.image.top +
      ((y - frame.bounds.y) / frame.bounds.h) * frame.image.height;
    if (
      Math.abs(client[0] - px) <= radius &&
      Math.abs(client[1] - py) <= radius
    )
      return corner;
  }
  return null;
}

/** Choose facing anchors without moving either node. Users can refine them later. */
export { facingAnchors } from "@humanboard/schema/scene";
export function removeObject(scene: Scene, id: string): Scene {
  if (id.startsWith("edge:"))
    return { ...scene, edges: scene.edges.filter((e) => e.id !== id.slice(5)) };
  return id.startsWith("asset:")
    ? {
        ...scene,
        assets: scene.assets.filter((a) => a.asset_id !== id.slice(6)),
      }
    : {
        ...scene,
        nodes: scene.nodes.filter((n) => n.id !== id),
        edges: scene.edges.filter(
          (e) => e.from.node_id !== id && e.to.node_id !== id,
        ),
      };
}

/** Hit-testing in screen pixels keeps thin edges selectable at every zoom. */
export function hitEdge(
  scene: Scene,
  client: readonly [number, number],
  frame: CanvasFrame,
): string | null {
  const world = scenePoint(client, frame);
  if (!world) return null;
  // Cards remain draggable; container backgrounds must not swallow their edges.
  if (
    scene.nodes.some(
      (n) =>
        n.kind !== "group" &&
        world[0] >= n.rect.x &&
        world[0] <= n.rect.x + n.rect.w &&
        world[1] >= n.rect.y &&
        world[1] <= n.rect.y + n.rect.h,
    )
  )
    return null;
  const point = (p: { x: number; y: number }) => ({
    x:
      frame.image.left +
      ((p.x - frame.bounds.x) * frame.image.width) / frame.bounds.w,
    y:
      frame.image.top +
      ((p.y - frame.bounds.y) * frame.image.height) / frame.bounds.h,
  });
  for (const e of [...scene.edges].reverse()) {
    const a = scene.nodes.find((n) => n.id === e.from.node_id),
      b = scene.nodes.find((n) => n.id === e.to.node_id);
    if (!a || !b) continue;
    const g = edgeGeometry(
      e,
      a.rect,
      b.rect,
      scene.diagram
        ? scene.nodes
            .filter((n) => n.id !== a.id && n.id !== b.id && n.kind !== "group")
            .map((n) => n.rect)
        : [],
    );
    const points = edgePathPoints(g).map(point);
    const mid = point(edgeLabelPoint(g));
    const scale = frame.image.width / frame.bounds.w;
    const labelWidth =
      [...(e.label ?? "")].reduce(
        (n, c) => n + (/[\u2E80-\uFFFF]/.test(c) ? 12 : 7),
        0,
      ) * scale;
    if (
      e.label &&
      Math.abs(client[0] - mid.x) <= labelWidth / 2 + 5 &&
      Math.abs(client[1] - (mid.y - 14 * scale)) <= 10 * scale + 4
    )
      return e.id;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1]!,
        q = points[i]!,
        dx = q.x - p.x,
        dy = q.y - p.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((client[0] - p.x) * dx + (client[1] - p.y) * dy) /
            (dx * dx + dy * dy || 1),
        ),
      );
      if (Math.hypot(client[0] - p.x - t * dx, client[1] - p.y - t * dy) <= 7)
        return e.id;
    }
  }
  return null;
}
