import { describe, expect, test } from "bun:test";

import type { Edge, Node, Scene, Stroke } from "@humanboard/schema";

import { renderDiffToPNGs, renderDiffToSVGs, renderSceneToPNG } from "../src";

function emptyScene(): Scene {
  return { nodes: [], edges: [], strokes: [], assets: [] };
}

function node(id: string, rect: Node["rect"], title = id): Node {
  return {
    id,
    kind: "state",
    title,
    rect,
  };
}

function stroke(
  id: string,
  points: [number, number][],
  pressure?: number[],
): Stroke {
  return {
    id,
    tool: "pen",
    color: "#FF0000",
    width: 2,
    points,
    ...(pressure === undefined ? {} : { pressure }),
  };
}

function edge(id: string, from: Edge["from"], to: Edge["to"]): Edge {
  return { id, from, to };
}

function viewBox(svg: string): string {
  const match = /viewBox="([^"]+)"/.exec(svg);
  if (!match) {
    throw new Error("SVG has no viewBox");
  }
  return match[1]!;
}

function firstRect(
  svg: string,
  kind: "stroke" | "node",
): { x: number; y: number; w: number; h: number } {
  const match = new RegExp(
    `<rect data-diff-box="${kind}"[^>]* x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`,
  ).exec(svg);
  if (!match) {
    throw new Error(`SVG has no ${kind} diff box`);
  }
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    w: Number(match[3]),
    h: Number(match[4]),
  };
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

describe("renderDiffToSVGs bounds", () => {
  test("uses one shared bounds for before, after, and highlight", () => {
    const base: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("base", [
          [100, 100],
          [180, 140],
        ]),
      ],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [node("far", { x: 2000, y: 1000, w: 120, h: 60 })],
      strokes: [
        stroke("base", [
          [100, 100],
          [180, 140],
        ]),
      ],
    };

    const result = renderDiffToSVGs(base, target);
    const shared = viewBox(result.before);
    expect(viewBox(result.after)).toBe(shared);
    expect(viewBox(result.highlight)).toBe(shared);
    expect(result.bounds.x).toBe(-48);
    expect(result.bounds.y).toBe(-48);
  });

  test("unions negative coordinates across both sides of a diff", () => {
    const base: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("left", [
          [-200, -100],
          [-150, -60],
        ]),
      ],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [node("deeper-left", { x: -800, y: -500, w: 100, h: 80 })],
      strokes: [
        stroke("left", [
          [-200, -100],
          [-150, -60],
        ]),
      ],
    };

    const result = renderDiffToSVGs(base, target);
    const shared = viewBox(result.before);
    expect(viewBox(result.after)).toBe(shared);
    expect(viewBox(result.highlight)).toBe(shared);
    expect(result.bounds.x).toBeLessThanOrEqual(-848);
    expect(result.bounds.y).toBeLessThanOrEqual(-548);
  });
});

describe("renderDiffToSVGs highlight branches", () => {
  test("keeps unchanged strokes in the dimmed base and highlights new/changed strokes", () => {
    const unchanged = stroke(
      "unchanged",
      [
        [10, 10],
        [20, 20],
      ],
      [0.5, 0.5],
    );
    const changed = stroke("changed", [
      [100, 100],
      [150, 150],
    ]);
    const pressureChanged = stroke(
      "pressure",
      [
        [300, 300],
        [350, 350],
      ],
      [0.2, 0.2],
    );
    const removed = stroke("removed", [
      [500, 500],
      [550, 550],
    ]);
    const added = stroke("added", [
      [700, 700],
      [750, 750],
    ]);

    const base: Scene = {
      ...emptyScene(),
      strokes: [unchanged, changed, pressureChanged, removed],
    };
    const target: Scene = {
      ...emptyScene(),
      strokes: [
        unchanged,
        stroke("changed", [
          [120, 120],
          [180, 180],
        ]),
        stroke(
          "pressure",
          [
            [300, 300],
            [350, 350],
          ],
          [0.8, 0.8],
        ),
        added,
      ],
    };

    const { highlight } = renderDiffToSVGs(base, target);
    const baseStart = highlight.indexOf('data-highlight="base"');
    const incrementalStart = highlight.indexOf(
      'data-highlight="incremental-strokes"',
    );
    const boxesStart = highlight.indexOf('data-highlight="boxes"');
    const baseGroup = highlight.slice(baseStart, incrementalStart);
    const incrementalGroup = highlight.slice(incrementalStart, boxesStart);

    expect(baseGroup).toContain('data-stroke-id="unchanged"');
    expect(baseGroup).not.toContain('data-stroke-id="changed"');
    expect(baseGroup).not.toContain('data-stroke-id="removed"');
    expect(incrementalGroup).toContain('data-stroke-id="changed"');
    expect(incrementalGroup).toContain('data-stroke-id="pressure"');
    expect(incrementalGroup).toContain('data-stroke-id="added"');
    expect(highlight).not.toContain('data-stroke-id="removed"');
  });

  test("places a red box centered on one incremental stroke bbox", () => {
    const base = emptyScene();
    const target: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("increment", [
          [100, 100],
          [200, 160],
        ]),
      ],
    };

    const { highlight } = renderDiffToSVGs(base, target);
    const box = firstRect(highlight, "stroke");
    const boxCenter = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const strokeCenter = { x: (100 + 200) / 2, y: (100 + 160) / 2 };

    expect(Math.abs(boxCenter.x - strokeCenter.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(boxCenter.y - strokeCenter.y)).toBeLessThanOrEqual(2);
    expect(highlight).toContain('data-stroke-ids="increment"');
    expect(highlight).toContain('stroke="#FF4A3A"');
    expect(highlight).toContain('fill-opacity="0.05"');
  });

  test("renders purple dashed boxes for added nodes and edges", () => {
    const base: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { x: 0, y: 0, w: 100, h: 60 })],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [
        node("n1", { x: 0, y: 0, w: 100, h: 60 }),
        node("n2", { x: 300, y: 0, w: 100, h: 60 }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "n1", side: "right", offset: 0.5 },
          { node_id: "n2", side: "left", offset: 0.5 },
        ),
      ],
    };

    const { highlight } = renderDiffToSVGs(base, target);
    expect(highlight).toContain('data-diff-box="node" data-node-id="n2"');
    expect(highlight).toContain('data-diff-box="node" data-edge-id="e1"');
    expect(highlight).toContain('stroke="#A78BFA"');
    expect(highlight).toContain('stroke-dasharray="6 4"');
  });

  test("applies the configured grayscale background opacity", () => {
    const base: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("s1", [
          [0, 0],
          [10, 10],
        ]),
      ],
    };
    const target = base;

    const defaultResult = renderDiffToSVGs(base, target);
    expect(defaultResult.highlight).toContain(
      'data-highlight="base" opacity="0.28" filter="url(#hb-grayscale)"',
    );
    expect(defaultResult.highlight).toContain('id="hb-grayscale"');

    const custom = renderDiffToSVGs(base, target, { backgroundOpacity: 0.5 });
    expect(custom.highlight).toContain(
      'data-highlight="base" opacity="0.5" filter="url(#hb-grayscale)"',
    );
  });
});

describe("PNG rasterization", () => {
  test("renders a non-empty PNG with the PNG magic bytes", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { x: 100, y: 100, w: 200, h: 100 }, "hello")],
    };
    const png = renderSceneToPNG(scene);

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    expect(isPng(png)).toBe(true);
  });

  test("rasterizes all three diff SVGs", () => {
    const base: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("s1", [
          [0, 0],
          [20, 20],
        ]),
      ],
    };
    const target: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("s1", [
          [20, 20],
          [40, 40],
        ]),
      ],
      nodes: [node("n1", { x: 100, y: 100, w: 100, h: 50 })],
    };

    const result = renderDiffToPNGs(base, target);
    for (const png of [result.before, result.after, result.highlight]) {
      expect(Buffer.isBuffer(png)).toBe(true);
      expect(png.length).toBeGreaterThan(0);
      expect(isPng(png)).toBe(true);
    }
  });
});

test("dark before/after/highlight share transparent bounds and the dark node palette", () => {
  const base: Scene = {
    ...emptyScene(),
    nodes: [node("n1", { x: 10, y: 20, w: 180, h: 76 })],
  };
  const target: Scene = {
    ...base,
    nodes: [...base.nodes, node("n2", { x: 300, y: 20, w: 180, h: 76 })],
  };
  const result = renderDiffToSVGs(base, target, { theme: "dark" });
  for (const svg of [result.before, result.after, result.highlight]) {
    expect(svg).toContain('fill="transparent"');
    expect(svg).toContain('fill="#1B2333" stroke="#7C9CFF"');
    expect(svg).toContain(
      `viewBox="${result.bounds.x} ${result.bounds.y} ${result.bounds.w} ${result.bounds.h}"`,
    );
  }
  expect(result.highlight).toContain('data-diff-box="node"');
  expect(result.highlight).toContain('id="hb-grayscale"');
});

test("highlight draws added nodes and edges, not just their boxes, beside new ink", () => {
  const old = node("old", { x: 10, y: 20, w: 180, h: 76 });
  const base: Scene = { ...emptyScene(), nodes: [old] };
  const added = node("added", { x: 300, y: 20, w: 180, h: 76 }, "新增节点");
  const link: Edge = {
    id: "link",
    from: { node_id: "old", side: "right", offset: 0.5 },
    to: { node_id: "added", side: "left", offset: 0.5 },
  };
  const target: Scene = {
    ...base,
    nodes: [old, added],
    edges: [link],
    strokes: [
      stroke("ink", [
        [40, 200],
        [120, 240],
      ]),
    ],
  };
  const { highlight } = renderDiffToSVGs(base, target);
  const objects = highlight.slice(
    highlight.indexOf('data-highlight="incremental-objects"'),
    highlight.indexOf('data-highlight="incremental-strokes"'),
  );
  expect(objects).toContain('data-node-id="added"');
  expect(objects).toContain(">新增节点</text>");
  expect(objects).toContain('data-edge-id="link"');
  expect(objects).not.toContain('data-node-id="old"');
  expect(highlight).toContain('data-stroke-id="ink"');
  expect(highlight).toMatch(/data-diff-box="node"[^>]*data-node-id="added"/);
});
