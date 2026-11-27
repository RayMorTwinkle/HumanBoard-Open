import { expect, test } from "bun:test";
import { compileDiagram } from "./diagram";
import { SceneSchema } from "./schema";
test("coordinate-free mindmaps compile in all three layouts", () => {
  for (const layout of ["right", "down", "bilateral"] as const) {
    const result = compileDiagram({
      mode: "mindmap",
      layout,
      nodes: [
        { id: "root", title: "主题" },
        { id: "a", parent: "root", title: "分支A" },
        { id: "b", parent: "root", title: "分支B" },
      ],
    });
    expect(SceneSchema.safeParse(result).success).toBe(true);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes).toHaveLength(3);
  }
});
test("invalid tree and missing relations fail explicitly", () => {
  expect(() =>
    compileDiagram({
      mode: "mindmap",
      nodes: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    }),
  ).toThrow();
  expect(() =>
    compileDiagram({
      mode: "logic",
      nodes: [{ id: "a", title: "A" }],
      edges: [{ id: "e", from: "a", to: "missing" }],
    }),
  ).toThrow();
});
test("logic layout retains cycles, conditions and dashed relations", () => {
  const result = compileDiagram({
    mode: "logic",
    nodes: [
      { id: "a", title: "开始" },
      { id: "b", title: "通过？", role: "decision" },
    ],
    edges: [
      { id: "ab", from: "a", to: "b" },
      { id: "ba", from: "b", to: "a", label: "重试", dashed: true },
    ],
  });
  expect(result.edges).toHaveLength(2);
  expect(result.edges[1]).toMatchObject({
    label: "重试",
    style: { dashed: true },
  });
  expect(SceneSchema.safeParse(result).success).toBe(true);
});
test("downward layouts do not overlap sibling cards", () => {
  for (const mode of ["mindmap", "logic"] as const) {
    const scene = compileDiagram({
      mode,
      layout: "down",
      nodes: [
        { id: "root", title: "Root" },
        {
          id: "a",
          title: "A",
          ...(mode === "mindmap" ? { parent: "root" } : {}),
        },
        {
          id: "b",
          title: "B",
          ...(mode === "mindmap" ? { parent: "root" } : {}),
        },
      ],
      edges:
        mode === "logic"
          ? [
              { id: "a", from: "root", to: "a" },
              { id: "b", from: "root", to: "b" },
            ]
          : [],
    });
    const a = scene.nodes.find((n) => n.id === "a")!.rect,
      b = scene.nodes.find((n) => n.id === "b")!.rect;
    expect(
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    ).toBeLessThanOrEqual(0);
  }
});

test("mindmap colors follow sorted branches, custom ancestors and pinned cards", () => {
  for (const layout of ["right", "down", "bilateral"] as const) {
    const diagram = {
      mode: "mindmap" as const,
      layout,
      nodes: [
        { id: "grandchild", title: "后继", parent: "childB" },
        { id: "childB", title: "乙", parent: "root", order: 8 },
        { id: "childA", title: "甲", parent: "root", order: -1 },
        { id: "custom", title: "自定义", parent: "grandchild", color: "rose" },
        { id: "leaf", title: "叶子", parent: "custom" },
        { id: "root", title: "根" },
      ],
    };
    const { nodes } = compileDiagram(diagram);
    expect(
      Object.fromEntries(nodes.map((n) => [n.id, n.style?.color])),
    ).toEqual({
      root: "slate",
      childA: "blue",
      childB: "teal",
      grandchild: "teal",
      custom: "rose",
      leaf: "rose",
    });
    const pinned = nodes.map((n) => ({
      ...n,
      rect: { ...n.rect, x: n.rect.x - 340, y: n.rect.y + 720 },
    }));
    expect(compileDiagram(diagram, pinned).nodes).toEqual(pinned);
  }
});

test("rejects cycles disconnected from the root and ranks logic joins by their longest forward path", () => {
  expect(() =>
    compileDiagram({
      mode: "mindmap",
      nodes: [
        { id: "r", title: "R" },
        { id: "b", title: "B", parent: "c" },
        { id: "c", title: "C", parent: "b" },
      ],
    }),
  ).toThrow("Mindmap parent cycle");
  const scene = compileDiagram({
    mode: "logic",
    nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id, title: id })),
    edges: [
      ["c", "d"],
      ["b", "c"],
      ["a", "b"],
      ["a", "d"],
      ["d", "a"],
      ["d", "d"],
      ["e", "b"],
    ].map(([from, to]) => ({ id: from + to, from, to })),
  });
  expect(scene.nodes.map((n) => n.rect.x)).toEqual([0, 320, 640, 960, 0]);
  expect(scene.edges.find((e) => e.id === "da")?.style?.curve).toBe(true);
  expect(scene.edges.find((e) => e.id === "dd")?.style?.curve).toBe(true);
});
