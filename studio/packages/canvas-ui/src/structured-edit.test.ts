import { expect, test } from "bun:test";
import {
  compileDiagram,
  DiagramSchema,
  canonicalSceneJson,
  resolveSceneDefaults,
} from "@humanboard/schema";
import { structuredEdit } from "./structured-edit";
import { scenePatch } from "./editor";
const diagram = DiagramSchema.parse({
  mode: "mindmap",
  nodes: [
    { id: "root", title: "主题" },
    { id: "child", title: "子项", parent: "root" },
  ],
});
const initial = { ...compileDiagram(diagram), diagram };
test("structured edits update semantic content and save only diagram patches", () => {
  const next = structuredEdit(
    initial,
    {
      ...initial,
      nodes: initial.nodes.map((n) =>
        n.id === "child" ? { ...n, title: "修改后的标题" } : n,
      ),
    },
    "child",
  );
  expect(next.diagram!.nodes.find((n) => n.id === "child")!.title).toBe(
    "修改后的标题",
  );
  const patch = scenePatch(initial, next);
  expect(patch.diagram).toBeDefined();
  expect(patch.upsert_nodes).toEqual([]);
  expect(resolveSceneDefaults(structuredClone(next))).toEqual(next);
  expect(canonicalSceneJson(next)).toContain('"diagram"');
});
test("free conversion preserves position and can be undone by restoring the previous scene", () => {
  const { diagram, ...free } = initial;
  const converted = structuredEdit(initial, free, null);
  expect(converted.nodes).toEqual(initial.nodes);
  expect(scenePatch(initial, converted).diagram).toBeNull();
  expect(initial.diagram).toBeDefined();
});
test("tree links survive conversion to logic and subsequent edits", () => {
  const converted = {
    ...initial,
    diagram: DiagramSchema.parse({
      mode: "logic",
      nodes: diagram.nodes.map(({ parent, ...n }) => n),
      edges: initial.edges.map((e) => ({
        id: e.id,
        from: e.from.node_id,
        to: e.to.node_id,
      })),
    }),
  };
  const edited = structuredEdit(
    converted,
    {
      ...converted,
      nodes: converted.nodes.map((n) => ({ ...n, title: n.title + "!" })),
    },
    null,
  );
  expect(edited.edges).toHaveLength(1);
  expect(edited.diagram!.edges[0]!.id).toBe("tree:child");
});

test("mindmap dragging reparents a branch without allowing ancestry cycles", () => {
  const d = DiagramSchema.parse({
    mode: "mindmap",
    nodes: [
      { id: "r", title: "R" },
      { id: "a", title: "A", parent: "r" },
      { id: "b", title: "B", parent: "r" },
    ],
  });
  const base = { ...compileDiagram(d), diagram: d };
  const target = base.nodes.find((n) => n.id === "b")!.rect;
  const next = structuredEdit(
    base,
    {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "a" ? { ...n, rect: { ...target } } : n,
      ),
    },
    "a",
  );
  expect(next.diagram!.nodes.find((n) => n.id === "a")!.parent).toBe("b");
  const child = next.nodes.find((n) => n.id === "a")!.rect;
  const guarded = structuredEdit(
    next,
    {
      ...next,
      nodes: next.nodes.map((n) =>
        n.id === "b" ? { ...n, rect: { ...child } } : n,
      ),
    },
    "b",
  );
  expect(guarded.diagram!.nodes.find((n) => n.id === "b")!.parent).toBe("r");
});

test("editing text or adding a node leaves other cards and annotations in place", () => {
  const d = DiagramSchema.parse({
    mode: "logic",
    nodes: [
      { id: "r", title: "R" },
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    edges: [
      { id: "ra", from: "r", to: "a" },
      { id: "rb", from: "r", to: "b" },
    ],
  });
  const base = {
    ...compileDiagram(d),
    diagram: d,
    strokes: [
      {
        id: "ink",
        tool: "pen" as const,
        color: "#ff0000",
        width: 2,
        points: [
          [330, 160],
          [450, 160],
        ] as [number, number][],
      },
    ],
  };
  const next = structuredEdit(
    base,
    {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "a" ? { ...n, sub: "这段说明变长了".repeat(20) } : n,
      ),
    },
    "a",
  );
  expect(next.nodes.find((n) => n.id === "b")!.rect).toEqual(
    base.nodes.find((n) => n.id === "b")!.rect,
  );
  expect(next.strokes).toEqual(base.strokes);
  expect(resolveSceneDefaults(structuredClone(next))).toEqual(next);
  const added = structuredEdit(
    next,
    {
      ...next,
      diagram: {
        ...next.diagram!,
        nodes: [
          ...next.diagram!.nodes,
          { id: "c", title: "新增节点", role: "step" },
        ],
      },
    },
    null,
  );
  for (const n of next.nodes)
    expect(added.nodes.find((p) => p.id === n.id)!.rect).toEqual(n.rect);
  expect(added.strokes).toEqual(base.strokes);
  const repacked = structuredEdit(
    next,
    { ...next, diagram: { ...next.diagram!, layout_revision: 1 } },
    null,
  );
  expect(repacked.nodes.find((n) => n.id === "b")!.rect.y).toBeGreaterThan(
    base.nodes.find((n) => n.id === "b")!.rect.y,
  );
});
