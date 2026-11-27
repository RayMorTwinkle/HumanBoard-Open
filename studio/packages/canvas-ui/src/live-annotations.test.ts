import { expect, test } from "bun:test";
import { renderSceneToSVG } from "@humanboard/core-engine/scene-svg";
import {
  appendCanvasOverlays,
  liveAnnotationOverlay,
} from "./live-annotations";
import { emptyScene } from "./editor";
test("live annotation overlays are outside nested node SVGs and never become saved content", () => {
  const base = emptyScene();
  base.nodes = [
    {
      id: "n",
      kind: "service",
      title: "Service",
      rect: { x: 100, y: 100, w: 200, h: 100 },
    },
  ];
  const current = {
    ...base,
    strokes: [
      {
        id: "human",
        tool: "pen" as const,
        color: "red",
        width: 3,
        points: [
          [500, 400],
          [550, 440],
        ] as [number, number][],
      },
    ],
  };
  const svg = renderSceneToSVG(current, { theme: "dark" });
  const overlay = liveAnnotationOverlay(base, current);
  const result = appendCanvasOverlays(svg, overlay);
  expect(result).toEndWith(overlay + "</svg>");
  expect(result.indexOf("data-live-annotations")).toBeGreaterThan(
    result.lastIndexOf('<g data-layer="strokes"'),
  );
  expect(svg).not.toContain("data-live-annotations");
  expect(JSON.stringify(current)).not.toContain("data-live-annotations");
});
