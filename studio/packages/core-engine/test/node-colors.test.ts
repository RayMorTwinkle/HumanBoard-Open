import { expect, test } from "bun:test";
import { NODE_COLORS, nodeColorPalette } from "@humanboard/schema";
import { renderSceneToSVG } from "../src/render/scene-svg";
import { sceneWithNode } from "./helpers";
function luminance(hex: string) {
  const v = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}
test("one color derives readable surfaces and text in both themes", () => {
  for (const dark of [false, true])
    for (const base of [
      ...Object.keys(NODE_COLORS),
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
    ]) {
      const p = nodeColorPalette(base, dark)!;
      const a = luminance(p.fill),
        b = luminance(p.text);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    }
});
test("new unified color takes precedence, while old independent styles still render", () => {
  const scene = sceneWithNode("color");
  scene.nodes[0]!.style = { fill: "#123456", borderColor: "#654321" };
  expect(renderSceneToSVG(scene)).toContain('fill="#123456"');
  expect(renderSceneToSVG(scene)).toContain('stroke="#654321"');
  scene.nodes[0]!.style = { ...scene.nodes[0]!.style, color: "teal" };
  const svg = renderSceneToSVG(scene),
    palette = nodeColorPalette("teal", false)!;
  expect(svg).toContain(`fill="${palette.fill}"`);
  expect(svg).toContain(`stroke="${NODE_COLORS.teal}"`);
  expect(svg).not.toContain('fill="#123456"');
});
