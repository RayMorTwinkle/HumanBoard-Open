import { describe, expect, test } from "bun:test";

import type { Stroke } from "@humanboard/schema";

import {
  renderInspectCompositePNG,
  renderInspectOverlay,
  renderInspectOverlayPNG,
} from "../src/render/inspect-overlay";

function stroke(
  id: string,
  points: [number, number][],
  overrides: Partial<Stroke> = {},
): Stroke {
  return {
    id,
    tool: "pen",
    color: "#FF0000",
    width: 2,
    points,
    ...overrides,
  };
}

const ASSET_RECT = { x: -100, y: 50, w: 200, h: 100 };

describe("renderInspectOverlay", () => {
  test("maps non-uniform image/rect scales and keeps only points inside the rect", () => {
    const svg = renderInspectOverlay({
      imageWidth: 1000,
      imageHeight: 200,
      assetRect: ASSET_RECT,
      strokes: [
        stroke("s1", [
          [-100, 50],
          [-50, 75],
          [0, 100],
          [150, 100],
        ]),
      ],
    });

    expect(svg).toContain(
      'data-stroke-id="s1" points="0,0 250,50 500,100"',
    );
    expect(svg).toContain('stroke-width="4"');
    expect(svg).not.toContain("750,100");
  });

  test("keeps inside points from a stroke that crosses the asset boundary", () => {
    const svg = renderInspectOverlay({
      imageWidth: 400,
      imageHeight: 200,
      assetRect: { x: 0, y: 0, w: 200, h: 100 },
      strokes: [
        stroke("cross", [
          [50, 20],
          [100, 40],
          [250, 20],
          [300, 40],
        ]),
      ],
    });

    expect(svg).toContain('data-stroke-id="cross" points="100,40 200,80"');
    expect(svg).not.toContain("500,40");
  });

  test("renders no stroke elements for an empty stroke list", () => {
    const svg = renderInspectOverlay({
      imageWidth: 320,
      imageHeight: 180,
      assetRect: { x: 0, y: 0, w: 320, h: 180 },
      strokes: [],
    });

    expect(svg).toContain('data-layer="inspect-strokes"');
    expect(svg).not.toContain("data-stroke-id=");
    expect(svg).toContain('viewBox="0 0 320 180"');
  });

  test("supports negative asset coordinates and transparent output", () => {
    const svg = renderInspectOverlay({
      imageWidth: 200,
      imageHeight: 100,
      assetRect: { x: -50, y: -20, w: 100, h: 50 },
      strokes: [stroke("s1", [[-50, -20], [50, 30]])],
    });

    expect(svg).toContain('points="0,0 200,100"');
    expect(svg).toContain('fill="transparent"');
  });

  test("embeds an original image before rendering overlay strokes", () => {
    const svg = renderInspectOverlay({
      imageWidth: 10,
      imageHeight: 10,
      assetRect: { x: 0, y: 0, w: 10, h: 10 },
      strokes: [stroke("s1", [[0, 0], [10, 10]])],
      imageData: new Uint8Array([1, 2, 3]),
      imageMimeType: "image/png",
    });

    expect(svg).toContain('href="data:image/png;base64,AQID"');
    expect(svg).toContain('data-layer="inspect-strokes"');
  });
});

describe("renderInspectOverlayPNG", () => {
  test("produces a PNG with the expected magic bytes", () => {
    const png = renderInspectOverlayPNG({
      imageWidth: 160,
      imageHeight: 90,
      assetRect: { x: 0, y: 0, w: 160, h: 90 },
      strokes: [stroke("s1", [[0, 0], [80, 45], [160, 90]])],
    });

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    expect(Array.from(png.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  test("composites a base image and overlay into one PNG", () => {
    const imageData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
      "base64",
    );
    const png = renderInspectCompositePNG({
      imageWidth: 1,
      imageHeight: 1,
      assetRect: { x: 0, y: 0, w: 1, h: 1 },
      strokes: [stroke("s1", [[0, 0]])],
      imageData,
      imageMimeType: "image/png",
    });
    expect(Array.from(png.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });
});
