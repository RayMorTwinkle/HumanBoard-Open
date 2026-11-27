import type { Rect } from "@humanboard/schema";
/** Grid lives in SVG world coordinates, so fitting the paper scales ink and dots together. */
export function withPaperGrid(svg: string, bounds: Rect, dark: boolean): string {
  const grid = `<defs><pattern id="hb-paper-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1" fill="${dark ? "#ffffff" : "#000000"}" opacity="${dark ? ".08" : ".12"}"/></pattern></defs><rect data-ui-grid="true" x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="url(#hb-paper-grid)"/>`;
  return svg.replace(/(<svg\b[^>]*>)/, `$1${grid}`);
}
