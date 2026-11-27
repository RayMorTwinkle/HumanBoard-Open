import { expect, test } from "bun:test";
import { hitEdge, removeObject } from "./canvas-geometry";
import {
  edgeGeometry,
  edgeLabelPoint,
} from "@humanboard/core-engine/scene-svg";
import type { Scene } from "@humanboard/schema";
const scene: Scene = {
  nodes: [
    { id: "a", kind: "note", title: "A", rect: { x: 0, y: 0, w: 100, h: 80 } },
    {
      id: "b",
      kind: "note",
      title: "B",
      rect: { x: 300, y: 0, w: 100, h: 80 },
    },
  ],
  edges: [
    {
      id: "line",
      from: { node_id: "a", side: "right", offset: 0.5 },
      to: { node_id: "b", side: "left", offset: 0.5 },
      label: "关系说明",
    },
  ],
  strokes: [],
  assets: [],
};
test("line and label can be selected at different zooms with screen-space tolerance", () => {
  for (const zoom of [0.5, 1, 2]) {
    const frame = {
      bounds: { x: 0, y: 0, w: 400, h: 200 },
      image: { left: 100, top: 50, width: 400 * zoom, height: 200 * zoom },
    };
    expect(hitEdge(scene, [100 + 200 * zoom, 50 + 40 * zoom + 6], frame)).toBe(
      "line",
    );
    expect(hitEdge(scene, [100 + 200 * zoom, 50 + 26 * zoom], frame)).toBe(
      "line",
    );
    expect(
      hitEdge(scene, [100 + 200 * zoom, 50 + 100 * zoom], frame),
    ).toBeNull();
  }
  const frame = {
    bounds: { x: 0, y: 0, w: 400, h: 200 },
    image: { left: 0, top: 0, width: 400, height: 200 },
  };
  const grouped: Scene = {
    ...scene,
    nodes: [
      {
        id: "group",
        kind: "group",
        title: "容器",
        rect: { x: -20, y: -20, w: 440, h: 200 },
      },
      ...scene.nodes,
    ],
  };
  expect(hitEdge(grouped, [200, 40], frame)).toBe("line");
  expect(hitEdge(grouped, [99, 40], frame)).toBeNull();
  expect(removeObject(scene, "edge:line").edges).toHaveLength(0);
  expect(removeObject(scene, "edge:line").nodes).toEqual(scene.nodes);
});
test("curved connection hit testing follows the rendered Bezier", () => {
  const curved = {
    ...scene,
    edges: [
      {
        ...scene.edges[0]!,
        style: { curve: true },
        from: { ...scene.edges[0]!.from, side: "bottom" as const },
        to: { ...scene.edges[0]!.to, side: "bottom" as const },
      },
    ],
  };
  const g = edgeGeometry(
    curved.edges[0]!,
    scene.nodes[0]!.rect,
    scene.nodes[1]!.rect,
  );
  const x = (g.start.x + 3 * g.c1!.x + 3 * g.c2!.x + g.end.x) / 8,
    y = (g.start.y + 3 * g.c1!.y + 3 * g.c2!.y + g.end.y) / 8;
  expect(
    hitEdge(curved, [x, y], {
      bounds: { x: 0, y: 0, w: 400, h: 200 },
      image: { left: 0, top: 0, width: 400, height: 200 },
    }),
  ).toBe("line");
});

test("routed structured edges and their labels can be selected on the drawn detour", () => {
  const nodes = [
    {
      id: "r",
      kind: "note" as const,
      title: "R",
      rect: { x: 0, y: 0, w: 220, h: 128 },
    },
    {
      id: "block",
      kind: "note" as const,
      title: "B",
      rect: { x: 320, y: 176, w: 220, h: 144 },
    },
    {
      id: "end",
      kind: "note" as const,
      title: "C",
      rect: { x: 320, y: 368, w: 220, h: 112 },
    },
  ];
  const edge = {
    id: "routed",
    from: { node_id: "r", side: "bottom" as const, offset: 0.5 },
    to: { node_id: "end", side: "top" as const, offset: 0.5 },
    label: "同步",
    style: { curve: true },
  };
  const g = edgeGeometry(edge, nodes[0]!.rect, nodes[2]!.rect, [
    nodes[1]!.rect,
  ]);
  expect(g.points).toBeDefined();
  const routed: Scene = {
    nodes,
    edges: [edge],
    assets: [],
    strokes: [],
    diagram: {
      mode: "logic",
      layout: "right",
      nodes: nodes.map((n) => ({ id: n.id, title: n.title, role: "step" })),
      edges: [{ id: edge.id, from: "r", to: "end" }],
    },
  };
  const frame = {
    bounds: { x: 0, y: 0, w: 600, h: 600 },
    image: { left: 0, top: 0, width: 600, height: 600 },
  };
  const label = edgeLabelPoint(g);
  expect(hitEdge(routed, [label.x, label.y - 8], frame)).toBe("routed");
  const a = g.points![1]!,
    b = g.points![2]!;
  expect(hitEdge(routed, [(a.x + b.x) / 2, (a.y + b.y) / 2], frame)).toBe(
    "routed",
  );
});
