import { expect, test } from "bun:test";
import { mergeBases, mergeScenes } from "../src/revisions/merge";
import { compileDiagram, DiagramSchema, type Scene } from "@humanboard/schema";

test("reports all nearest bases in a criss-cross DAG", () => {
  const parents = new Map([
    ["a", []],
    ["b", ["a"]],
    ["c", ["a"]],
    ["d", ["b", "c"]],
    ["e", ["c", "b"]],
  ]);
  expect(mergeBases(parents, "d", "e").sort()).toEqual(["b", "c"]);
  expect(mergeBases(parents, "d", "b")).toEqual(["b"]);
  expect(mergeBases(parents, "d", "unrelated")).toEqual([]);
});
test("deleting a node conflicts with concurrent edits or a new link to the node", () => {
  const base: Scene = {
    nodes: [
      {
        id: "n",
        title: "old",
        kind: "note",
        rect: { x: 0, y: 0, w: 50, h: 50 },
      },
    ],
    edges: [],
    assets: [],
    strokes: [],
  };
  const local = { ...base, nodes: [] },
    incoming = structuredClone(base);
  incoming.nodes[0]!.title = "changed";
  incoming.edges.push({
    id: "e",
    from: { node_id: "n", side: "left", offset: 0 },
    to: { node_id: "n", side: "right", offset: 0 },
  });
  expect(
    mergeScenes(base, local, incoming).conflicts.map((c) => c.path),
  ).toEqual([
    ["nodes", "n"],
    ["edges", "e", "from"],
    ["edges", "e", "to"],
  ]);
});

test("combines independent structure edits and reports a cycle created by two valid moves", () => {
  const d = DiagramSchema.parse({
    mode: "mindmap",
    nodes: [
      { id: "r", title: "root" },
      { id: "a", parent: "r", title: "a" },
      { id: "b", parent: "r", title: "b" },
    ],
  });
  const materialize = (diagram: typeof d) => ({
    ...compileDiagram(diagram),
    diagram,
  });
  const base = materialize(d),
    left = structuredClone(d),
    right = structuredClone(d);
  left.nodes[1]!.title = "A";
  right.nodes[2]!.title = "B";
  const merged = mergeScenes(base, materialize(left), materialize(right));
  expect(merged.conflicts).toEqual([]);
  expect(merged.scene.diagram!.nodes.map((n) => n.title)).toEqual([
    "root",
    "A",
    "B",
  ]);
  left.nodes[1]!.parent = "b";
  right.nodes[2]!.parent = "a";
  expect(
    mergeScenes(base, materialize(left), materialize(right)).conflicts.length,
  ).toBeGreaterThan(0);
});
