import { expect, test } from "bun:test";
import { coordinateDriftWarnings, lintScene } from "../src/services/scene-lint";
import { node, sceneWithNode } from "./helpers";
test("warns for coordinate-only drift without blocking explicit edits", () => {
  const base = sceneWithNode("n"),
    target = {
      ...base,
      nodes: base.nodes.map((n) => ({ ...n, rect: { ...n.rect, x: 200 } })),
    };
  expect(coordinateDriftWarnings(base, target)).toMatchObject([
    { code: "W_COORD_DRIFT_SUSPECT", node_id: "n" },
  ]);
  expect(
    coordinateDriftWarnings(base, {
      ...target,
      nodes: target.nodes.map((n) => ({ ...n, title: "new" })),
    }),
  ).toEqual([]);
  const connected = {
    ...target,
    nodes: [...target.nodes, node("other")],
    edges: [
      {
        id: "new-edge",
        from: { node_id: "n", side: "right" as const, offset: 0.5 },
        to: { node_id: "other", side: "left" as const, offset: 0.5 },
      },
    ],
  };
  expect(coordinateDriftWarnings(base, connected)).toEqual([]);
});
test("reports overlaps and an edge crossing an unrelated node without moving anything", () => {
  const scene = {
    nodes: [
      { ...node("a"), rect: { x: 0, y: 0, w: 100, h: 100 } },
      { ...node("b"), rect: { x: 400, y: 0, w: 100, h: 100 } },
      { ...node("middle"), rect: { x: 200, y: 0, w: 100, h: 100 } },
      { ...node("overlap"), rect: { x: 220, y: 20, w: 100, h: 100 } },
    ],
    edges: [
      {
        id: "e",
        from: { node_id: "a", side: "right" as const, offset: 0.5 },
        to: { node_id: "b", side: "left" as const, offset: 0.5 },
      },
    ],
    strokes: [],
    assets: [],
  };
  const before = JSON.stringify(scene),
    warnings = lintScene(scene);
  expect(warnings.some((w) => w.code === "W_NODE_OVERLAP")).toBe(true);
  expect(warnings.some((w) => w.code === "W_EDGE_CROSSES_NODE")).toBe(true);
  expect(JSON.stringify(scene)).toBe(before);
});
test("reports crossing lines between unrelated cards and labels on cards", () => {
  const at = (id: string, x: number, y: number) => ({
    ...node(id),
    rect: { x, y, w: 100, h: 60 },
  });
  const link = (id: string, a: string, b: string, label?: string) => ({
    id,
    from: { node_id: a, side: "right" as const, offset: 0.5 },
    to: { node_id: b, side: "left" as const, offset: 0.5 },
    ...(label ? { label } : {}),
  });
  const scene = {
    nodes: [
      at("a", 0, 0),
      at("b", 400, 300),
      at("c", 0, 300),
      at("d", 400, 0),
      at("hub", 400, 600),
    ],
    edges: [
      link("ab", "a", "b"),
      link("cd", "c", "d"),
      // Both leave from c: they meet there by design, never reported.
      link("chub", "c", "hub"),
    ],
    strokes: [],
    assets: [],
  };
  const crossings = lintScene(scene).filter(
    (w) => w.code === "W_EDGE_CROSSES_EDGE",
  );
  expect(crossings).toHaveLength(1);
  expect(crossings[0]!.message).toContain("ab");
  expect(crossings[0]!.message).toContain("cd");

  const labelled = {
    ...scene,
    nodes: [...scene.nodes, at("middle", 200, 120)],
    edges: [link("ab", "a", "b", "一个相当长的标签文字")],
  };
  expect(
    lintScene(labelled).some(
      (w) => w.code === "W_LABEL_OVERLAP" && w.node_id === "middle",
    ),
  ).toBe(true);
});
