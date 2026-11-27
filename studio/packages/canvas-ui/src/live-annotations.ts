import { computeDiffBoxes } from "@humanboard/core-engine/scene-diff-svg";
import type { Scene } from "@humanboard/schema";
/** Node renderers can contain nested SVGs; overlays belong at the root end. */
export function appendCanvasOverlays(
  svg: string,
  ...overlays: string[]
): string {
  return svg.replace(/<\/svg>$/, overlays.join("") + "</svg>");
}
/** Presentation overlay only; never written to Scene, capture, or model renders. */
export function liveAnnotationOverlay(base: Scene, current: Scene): string {
  return `<g data-live-annotations="true" pointer-events="none">${computeDiffBoxes(
    base,
    current,
  )
    .filter((b) => b.kind === "stroke")
    .map((b) => {
      const { x, y, w, h } = b.rect;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff6757" stroke-width="1.5" stroke-dasharray="6 5" rx="6"/><text x="${x + 5}" y="${y - 6}" fill="#ff9a8d" font-size="10" font-family="sans-serif">未保存批注</text>`;
    })
    .join("")}</g>`;
}
