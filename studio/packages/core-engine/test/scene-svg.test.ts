import { describe, expect, test } from "bun:test";

import {
  sceneContentHash,
  type AssetRef,
  type Edge,
  type Node,
  type Scene,
  type Stroke,
} from "@humanboard/schema";

import { computeSceneBounds, renderSceneToSVG } from "../src/render/scene-svg";

function emptyScene(): Scene {
  return { nodes: [], edges: [], strokes: [], assets: [] };
}

test("node shells honor shape, fill and dashed borders in browser and PNG themes without moving anchors", () => {
  const scene: Scene = {
    ...emptyScene(),
    nodes: [
      node(
        "styled",
        { x: 100, y: 100, w: 240, h: 180 },
        {
          style: {
            shape: "diamond",
            fill: "#ffeecc",
            borderColor: "#ff4400",
            dashed: true,
          },
        },
      ),
    ],
  };
  const hash = sceneContentHash(scene);
  for (const theme of ["light", "dark"] as const) {
    const svg = renderSceneToSVG(scene, { theme });
    expect(svg).toContain('points="220,100 340,190 220,280 100,190"');
    expect(svg).toContain('fill="#ffeecc" stroke="#ff4400"');
    expect(svg).toContain('stroke-dasharray="8 6"');
  }
  expect(sceneContentHash(scene)).toBe(hash);
});

function node(
  id: string,
  rect: Node["rect"],
  overrides: Partial<Node> = {},
): Node {
  return {
    id,
    kind: "state",
    title: id,
    rect,
    ...overrides,
  };
}

function edge(
  id: string,
  from: Edge["from"],
  to: Edge["to"],
  overrides: Partial<Edge> = {},
): Edge {
  return { id, from, to, ...overrides };
}

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

function asset(assetId: string, displayNo: string, z: number): AssetRef {
  return {
    asset_id: assetId,
    display_no: displayNo,
    rect: { x: 100, y: 100, w: 320, h: 180 },
    z,
  };
}

describe("computeSceneBounds", () => {
  test("uses the minimum viewport, padding, and outward 8px rounding for an empty layer", () => {
    expect(computeSceneBounds(emptyScene())).toEqual({
      x: -48,
      y: -48,
      w: 1120,
      h: 736,
    });
  });

  test("keeps the minimum viewport when a node is fully inside it", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { x: 100, y: 100, w: 200, h: 100 })],
    };
    expect(computeSceneBounds(scene)).toEqual({
      x: -48,
      y: -48,
      w: 1120,
      h: 736,
    });
  });

  test("expands bounds for a node outside the minimum viewport", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { x: 2000, y: 1000, w: 100, h: 50 })],
    };
    expect(computeSceneBounds(scene)).toEqual({
      x: -48,
      y: -48,
      w: 2200,
      h: 1152,
    });
  });

  test("includes negative stroke coordinates and rounds outward", () => {
    const scene: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("s1", [
          [-13.2, 20.1],
          [5.7, 60.9],
        ]),
      ],
    };
    expect(computeSceneBounds(scene)).toEqual({
      x: -64,
      y: -48,
      w: 1136,
      h: 736,
    });
  });

  test("rounds decimal and negative edges away from content", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { x: -1, y: -1, w: 2, h: 2 })],
    };
    expect(computeSceneBounds(scene)).toEqual({
      x: -56,
      y: -56,
      w: 1128,
      h: 744,
    });
  });
});

describe("renderSceneToSVG layer order", () => {
  test("renders assets by z/asset_id, then nodes, edges, and strokes", () => {
    const scene: Scene = {
      assets: [
        asset("01ARZ3NDEK0000000000000003", "003", 2),
        asset("01ARZ3NDEK0000000000000002", "002", 1),
        asset("01ARZ3NDEK0000000000000001", "001", 1),
      ],
      nodes: [
        node("n2", { x: 0, y: 0, w: 100, h: 50 }),
        node("n1", { x: 200, y: 0, w: 100, h: 50 }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "n2", side: "right", offset: 0.5 },
          { node_id: "n1", side: "left", offset: 0.5 },
        ),
      ],
      strokes: [
        stroke("s1", [
          [0, 0],
          [10, 10],
        ]),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg.indexOf('data-layer="assets"')).toBeLessThan(
      svg.indexOf('data-layer="nodes"'),
    );
    expect(svg.indexOf('data-layer="nodes"')).toBeLessThan(
      svg.indexOf('data-layer="edges"'),
    );
    expect(svg.indexOf('data-layer="edges"')).toBeLessThan(
      svg.indexOf('data-layer="strokes"'),
    );
    expect(svg.indexOf('data-display-no="001"')).toBeLessThan(
      svg.indexOf('data-display-no="002"'),
    );
    expect(svg.indexOf('data-display-no="002"')).toBeLessThan(
      svg.indexOf('data-display-no="003"'),
    );
    expect(svg.indexOf('data-node-id="n1"')).toBeLessThan(
      svg.indexOf('data-node-id="n2"'),
    );
    expect(svg.indexOf('data-stroke-id="s1"')).toBeGreaterThan(
      svg.indexOf('data-layer="strokes"'),
    );
  });
});

test("equal content hashes render identically after reordering and numeric normalization", () => {
  const original: Scene = {
    ...emptyScene(),
    nodes: [
      node("n2", { x: 0.004, y: 0, w: 100, h: 50 }, { title: "e\u0301" }),
      node("n1", { x: 20, y: 0, w: 100, h: 50 }),
    ],
    edges: [
      edge(
        "e2",
        { node_id: "n2", side: "right", offset: 0.5 },
        { node_id: "n1", side: "left", offset: 0.5 },
      ),
      edge(
        "e1",
        { node_id: "n1", side: "right", offset: 0.5 },
        { node_id: "n2", side: "left", offset: 0.5 },
      ),
    ],
  };
  const reordered: Scene = {
    ...original,
    nodes: [...original.nodes]
      .reverse()
      .map((n) =>
        n.id === "n2" ? { ...n, title: "é", rect: { ...n.rect, x: 0 } } : n,
      ),
    edges: [...original.edges].reverse(),
  };
  expect(sceneContentHash(original)).toBe(sceneContentHash(reordered));
  expect(renderSceneToSVG(original)).toBe(renderSceneToSVG(reordered));
});

describe("renderSceneToSVG edges", () => {
  test("computes anchor endpoints from node rects", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [
        node("a", { x: 100, y: 100, w: 100, h: 80 }),
        node("b", { x: 300, y: 200, w: 120, h: 60 }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "a", side: "right", offset: 0.5 },
          { node_id: "b", side: "left", offset: 0.5 },
        ),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg).toContain('<line x1="200" y1="140" x2="300" y2="230"');
  });

  test("renders dashed color and both arrowheads", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [
        node("a", { x: 0, y: 0, w: 100, h: 50 }),
        node("b", { x: 300, y: 0, w: 100, h: 50 }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "a", side: "right", offset: 0.5 },
          { node_id: "b", side: "left", offset: 0.5 },
          {
            label: "retry",
            style: { dashed: true, color: "#123456", arrow: "both" },
          },
        ),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-dasharray="8 6"');
    expect(svg.match(/data-arrow="end"/g)).toHaveLength(1);
    expect(svg.match(/data-arrow="start"/g)).toHaveLength(1);
    expect(svg).toContain(">retry</text>");
  });

  test("omits arrowheads when arrow is none", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [
        node("a", { x: 0, y: 0, w: 100, h: 50 }),
        node("b", { x: 300, y: 0, w: 100, h: 50 }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "a", side: "right", offset: 0.5 },
          { node_id: "b", side: "left", offset: 0.5 },
          { style: { arrow: "none" } },
        ),
      ],
    };

    expect(renderSceneToSVG(scene)).not.toContain("data-arrow=");
  });
});

describe("renderSceneToSVG content", () => {
  test("renders strokes as ordered polylines on top", () => {
    const scene: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("s2", [
          [2, 3],
          [4, 5],
        ]),
        stroke(
          "s1",
          [
            [10, 20],
            [30, 40],
          ],
          {
            tool: "highlighter",
            color: "#FFFF00",
            width: 8,
          },
        ),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg).toContain('<polyline data-stroke-id="s2" points="2,3 4,5"');
    expect(svg).toContain('stroke="#FFFF00"');
    expect(svg).toContain('stroke-width="8"');
    expect(svg).toContain('opacity="0.35"');
    expect(svg.indexOf('data-stroke-id="s2"')).toBeLessThan(
      svg.indexOf('data-stroke-id="s1"'),
    );
  });

  test("renders an unknown NodeKind as a neutral unknown card", () => {
    const scene = {
      ...emptyScene(),
      nodes: [
        {
          id: "future",
          kind: "future-kind",
          title: "Future",
          rect: { x: 10, y: 20, w: 100, h: 50 },
        },
      ],
    } as unknown as Scene;

    const svg = renderSceneToSVG(scene);
    expect(svg).toContain('data-kind="unknown"');
    expect(svg).toContain('fill="#F1F2F4"');
    expect(svg).toContain('stroke="#8B94A3"');
  });

  test("escapes XML-sensitive node text", () => {
    const scene: Scene = {
      ...emptyScene(),
      nodes: [
        node(
          "n1",
          { x: 0, y: 0, w: 200, h: 80 },
          { title: 'A & <B> "quoted"' },
        ),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg).toContain("A &amp; &lt;B&gt; &quot;quoted&quot;");
  });

  test("produces a stable fixed-scene regression string with key attributes", () => {
    const scene: Scene = {
      assets: [asset("01ARZ3NDEK0000000000000001", "001", 1)],
      nodes: [
        node("n1", { x: 100, y: 100, w: 180, h: 76 }, { title: "待支付" }),
      ],
      edges: [
        edge(
          "e1",
          { node_id: "n1", side: "right", offset: 0.5 },
          { node_id: "n1", side: "bottom", offset: 0.5 },
          { label: "retry" },
        ),
      ],
      strokes: [
        stroke("s1", [
          [582, 398],
          [600, 392],
        ]),
      ],
    };

    const svg = renderSceneToSVG(scene);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('viewBox="-48 -48 1120 736"');
    expect(svg).toContain('data-layer="assets"');
    expect(svg).toContain('data-layer="nodes"');
    expect(svg).toContain('data-layer="edges"');
    expect(svg).toContain('data-layer="strokes"');
    expect(svg).toContain('data-node-id="n1"');
    expect(svg).toContain('data-edge-id="e1"');
    expect(svg).toContain('data-stroke-id="s1"');
  });
});

test("embeds registered images in the shared SVG serializer", () => {
  const scene = emptyScene();
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  scene.assets.push(asset(id, "001", 0));
  const svg = renderSceneToSVG(scene, {
    assetImages: { [id]: "data:image/png;base64,aGVsbG8=" },
    assetTitles: { [id]: "reference <image>" },
  });
  expect(svg).toContain("<image");
  expect(svg).toContain("data:image/png;base64,aGVsbG8=");
  expect(svg).toContain("reference &lt;image&gt;");
});

test("dark workspace theme keeps geometry and content while leaving export defaults light", () => {
  const scene: Scene = {
    ...emptyScene(),
    nodes: [
      node(
        "n1",
        { x: 100, y: 80, w: 180, h: 76 },
        { title: "<script>客户</script>", sub: "https://example.test" },
      ),
    ],
  };
  const before = JSON.stringify(scene);
  const dark = renderSceneToSVG(scene, { theme: "dark" });
  expect(dark).toContain('fill="transparent"');
  expect(dark).toContain('x="100" y="80" width="180" height="76"');
  // Themes may only recolor nodes: with colors stripped, the markup must match.
  const layout = (svg: string) =>
    svg
      .slice(
        svg.indexOf('<g data-layer="nodes">'),
        svg.indexOf('<g data-layer="edges">'),
      )
      .replace(/(fill|stroke)="#[0-9A-Fa-f]{6}"/g, "");
  expect(layout(dark)).toBe(layout(renderSceneToSVG(scene)));
  expect(dark).toContain("&lt;script&gt;客户&lt;/script&gt;");
  expect(dark).not.toContain("<script>");
  expect(renderSceneToSVG(scene)).toContain('fill="#FFFFFF"');
  expect(JSON.stringify(scene)).toBe(before);
});

test("URL cards render domain, wrapped title and summary without leaking text outside the card", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const scene = { ...emptyScene(), assets: [asset(id, "001", 0)] };
  const svg = renderSceneToSVG(scene, {
    theme: "dark",
    assetTitles: { [id]: "支付状态与重试策略 <安全>" },
    assetCards: {
      [id]: {
        url: "https://docs.example.test/guide",
        description: "回调可能重复投递，接收方应通过幂等键避免重复处理。",
      },
    },
  });
  expect(svg).toContain('data-asset-type="url"');
  expect(svg).toContain("docs.example.test");
  expect(svg).toContain("支付状态与重试策略 &lt;安全&gt;");
  expect(svg).toContain("回调可能重复投递");
  expect(svg).toContain('clip-path="url(#hb-url-');
  expect(svg).not.toContain("<安全>");
});

test("long node text wraps and clips in both themes without changing geometry or escaping", () => {
  const scene = {
    ...emptyScene(),
    nodes: [
      node(
        'unsafe"<&',
        { x: 100, y: 100, w: 180, h: 120 },
        {
          title: "支付网关错误处理与重试策略 <安全>",
          sub: "接收重复事件时，使用幂等键去重并记录补偿事件。",
          style: { accent: "#ed8c57" },
        },
      ),
    ],
  };
  const original = JSON.stringify(scene);
  for (const theme of ["light", "dark"] as const) {
    const svg = renderSceneToSVG(scene, { theme });
    expect(svg).toContain('overflow="hidden"');
    expect(svg).toContain('width="180" height="120"');
    expect(svg).toContain('data-node-id="unsafe&quot;&lt;&amp;"');
    expect(svg).not.toContain("<安全>");
    expect(svg).toContain("支付网关错误处理与重试策略 &lt;安全&gt;</title>");
    expect(svg).toContain("#ed8c57");
  }
  expect(JSON.stringify(scene)).toBe(original);
});

test("a curved edge bends out of its anchor sides and aims its arrow along the curve", () => {
  const a = {
    id: "a",
    kind: "state" as const,
    title: "A",
    rect: { x: 0, y: 0, w: 100, h: 60 },
  };
  const b = {
    id: "b",
    kind: "state" as const,
    title: "B",
    rect: { x: 300, y: 200, w: 100, h: 60 },
  };
  const edge = {
    id: "e",
    from: { node_id: "a", side: "right" as const, offset: 0.5 },
    to: { node_id: "b", side: "top" as const, offset: 0.5 },
  };
  const straight = renderSceneToSVG({
    nodes: [a, b],
    edges: [edge],
    strokes: [],
    assets: [],
  });
  const curved = renderSceneToSVG({
    nodes: [a, b],
    edges: [{ ...edge, style: { curve: true } }],
    strokes: [],
    assets: [],
  });
  expect(straight).toContain("<line ");
  expect(curved).toMatch(/<path d="M100 30 C\S+ 30 350 \S+ 350 200"/);
  // The head arrives from above, along the curve's final tangent.
  expect(curved).toContain('points="350,200 345,190 355,190"');
});

test("group containers are drawn beneath cards even when their ids sort later", () => {
  const svg = renderSceneToSVG({
    nodes: [
      {
        id: "a-card",
        kind: "service",
        title: "CARD",
        rect: { x: 20, y: 40, w: 120, h: 60 },
      },
      {
        id: "z-group",
        kind: "group",
        title: "GROUP",
        rect: { x: 0, y: 0, w: 200, h: 140 },
      },
    ],
    edges: [],
    strokes: [],
    assets: [],
  });
  expect(svg.indexOf('data-node-id="z-group"')).toBeLessThan(
    svg.indexOf('data-node-id="a-card"'),
  );
});
