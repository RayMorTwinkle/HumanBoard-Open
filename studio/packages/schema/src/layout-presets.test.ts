import { expect, test } from "bun:test";
import { layoutScene, presets } from "./layout-presets";
import type { Scene } from "./schema";
const ids = ["a", "b", "c", "d", "e", "f"];
const scene: Scene = {
  nodes: ids.map((id, i) => ({
    id,
    title: id,
    kind: i % 2 ? "job" : "state",
    rect: { x: 1, y: 2, w: 100 + i * 55, h: 90 + i * 20 },
  })),
  edges: [
    ["a", "b"],
    ["a", "c"],
    ["c", "d"],
    ["d", "a"],
    ["e", "f"],
  ].map(([a, b]) => ({
    id: a + b,
    from: { node_id: a!, side: "right", offset: 0.5 },
    to: { node_id: b!, side: "left", offset: 0.5 },
  })),
  strokes: [
    {
      id: "ink",
      width: 2,
      color: "red",
      tool: "pen",
      points: [
        [0, 0],
        [5, 10],
      ],
    },
  ],
  assets: [],
};
for (const preset of presets)
  test(
    preset + " separates differently sized cards in disconnected cyclic graphs",
    () => {
      const original = structuredClone(scene),
        output = layoutScene(scene, preset);
      expect(scene).toEqual(original);
      expect(output).toEqual(layoutScene(output, preset));
      expect(output.edges).toEqual(scene.edges);
      expect(output.strokes).toEqual(scene.strokes);
      for (const [i, n] of output.nodes.entries()) {
        expect(n).toMatchObject({
          id: scene.nodes[i]!.id,
          rect: { w: scene.nodes[i]!.rect.w, h: scene.nodes[i]!.rect.h },
        });
        const a = n.rect;
        for (const m of output.nodes.slice(i + 1)) {
          const b = m.rect;
          expect(
            a.x + a.w <= b.x ||
              b.x + b.w <= a.x ||
              a.y + a.h <= b.y ||
              b.y + b.h <= a.y,
          ).toBe(true);
        }
      }
      if (preset === "lanes")
        expect(output.nodes[0]!.rect.y).toBe(output.nodes[2]!.rect.y);
    },
  );
test("mind map expands on both sides of the root", () => {
  const graph = {
    ...scene,
    nodes: scene.nodes.slice(0, 3),
    edges: scene.edges.slice(0, 2),
  };
  const [root, b, c] = layoutScene(graph, "mindmap").nodes;
  expect((b!.rect.x - root!.rect.x) * (c!.rect.x - root!.rect.x)).toBeLessThan(
    0,
  );
});
