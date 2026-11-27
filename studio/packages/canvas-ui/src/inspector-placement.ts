import type { Rect } from "@humanboard/schema";
/** CSS-pixel placement only: never changes the selected object's world rect. */
export function placeInspector(
  selected: Rect,
  viewport: Rect,
  size: { w: number; h: number },
): { x: number; y: number } {
  const margin = 12,
    gap = 16;
  const minX = viewport.x + margin,
    minY = viewport.y + margin;
  const maxX = Math.max(minX, viewport.x + viewport.w - size.w - margin),
    maxY = Math.max(minY, viewport.y + viewport.h - size.h - margin);
  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x)),
    clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  const candidates = [
    { x: selected.x + selected.w + gap, y: clampY(selected.y) },
    { x: selected.x - size.w - gap, y: clampY(selected.y) },
    { x: clampX(selected.x), y: selected.y + selected.h + gap },
    { x: clampX(selected.x), y: selected.y - size.h - gap },
  ];
  return (
    candidates.find(
      (p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY,
    ) ?? {
      x: clampX(selected.x + selected.w + gap),
      y: clampY(selected.y + selected.h + gap),
    }
  );
}
