import { expect, test } from "bun:test";
import { createFixture, commitRoot, TEST_AUTHOR } from "./helpers";
import { compileDiagram, DiagramSchema } from "@humanboard/schema";
import { lintScene } from "../src/services/scene-lint";

test("a three-way logic branch routes around the middle card", () => {
  const diagram = DiagramSchema.parse({
    mode: "logic",
    nodes: [
      { id: "r", title: "应用服务" },
      { id: "a", title: "Agent" },
      { id: "b", title: "版本引擎" },
      { id: "c", title: "项目同步" },
    ],
    edges: [
      { id: "ra", from: "r", to: "a", curve: true },
      { id: "rb", from: "r", to: "b", curve: true },
      { id: "rc", from: "r", to: "c", curve: true },
    ],
  });
  const rects = [
    { x: 0, y: 0, w: 220, h: 128 },
    { x: 320, y: 0, w: 220, h: 128 },
    { x: 320, y: 176, w: 220, h: 144 },
    { x: 320, y: 368, w: 220, h: 112 },
  ];
  const source = compileDiagram(diagram);
  const nodes = source.nodes.map((n, i) => ({ ...n, rect: rects[i]! }));
  // This is the actual geometry from the failed dogfood draft, not an easy tree.
  const scene = compileDiagram(diagram, nodes);
  const free = { ...scene, diagram: undefined };
  expect(lintScene(free).some((w) => w.code === "W_EDGE_CROSSES_NODE")).toBe(
    true,
  );
  expect(
    lintScene({ ...scene, diagram }).filter(
      (w) => w.code === "W_EDGE_CROSSES_NODE",
    ),
  ).toEqual([]);
});
test("diagram patches commit, survive storage and convert to free without moving nodes", async () => {
  const f = await createFixture();
  const root = await commitRoot(f);
  const request = {
    sessionId: "diagram",
    projectId: f.project.id,
    spaceId: f.space.id,
    kind: "derive" as const,
    parentId: root.layerId,
    author: TEST_AUTHOR,
  };
  const draft = await f.service.createDraft({
    ...request,
    patch: {
      diagram: {
        mode: "logic",
        nodes: [
          { id: "a", title: "开始" },
          { id: "b", title: "结束" },
        ],
        edges: [{ id: "e", from: "a", to: "b", label: "完成" }],
      },
    },
  });
  const committed = await f.service.commitDraft({
    sessionId: "diagram",
    draftId: draft.draft.id,
    title: "结构图",
  });
  const scene = (await f.storage.getLayerScene(committed.layer.id))!;
  expect(scene.diagram!.mode).toBe("logic");
  expect(scene.nodes).toHaveLength(2);
  const free = await f.service.createDraft({
    ...request,
    parentId: committed.layer.id,
    patch: { diagram: null },
  });
  const done = await f.service.commitDraft({
    sessionId: "diagram",
    draftId: free.draft.id,
    title: "自由布局",
  });
  const result = (await f.storage.getLayerScene(done.layer.id))!;
  expect(result.diagram).toBeUndefined();
  expect(result.nodes).toEqual(scene.nodes);
});

test("server diagram patches preserve annotated coordinates; explicit re-layout survives saving", async () => {
  const f = await createFixture();
  const diagram = DiagramSchema.parse({
    mode: "logic",
    nodes: [
      { id: "r", title: "Root" },
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    edges: [
      { id: "ra", from: "r", to: "a" },
      { id: "rb", from: "r", to: "b" },
    ],
  });
  const scene = {
    ...compileDiagram(diagram),
    diagram,
    strokes: [
      {
        id: "mark",
        tool: "pen" as const,
        color: "#ff0000",
        width: 2,
        points: [
          [330, 150],
          [450, 150],
        ] as [number, number][],
      },
    ],
  };
  const root = await commitRoot(f, "annotated-root", scene);
  const base = (await f.storage.getLayerScene(root.layerId))!;
  const updated = {
    ...diagram,
    layout_revision: 0,
    nodes: diagram.nodes.map((n) =>
      n.id === "a" ? { ...n, sub: "详细说明".repeat(25) } : n,
    ),
  };
  const request = {
    sessionId: "stable",
    projectId: f.project.id,
    spaceId: f.space.id,
    kind: "derive" as const,
    parentId: root.layerId,
    author: TEST_AUTHOR,
  };
  const draft = await f.service.createDraft({
    ...request,
    patch: { diagram: updated },
  });
  const saved = await f.service.commitDraft({
    sessionId: "stable",
    draftId: draft.draft.id,
    title: "补充说明",
  });
  const stable = (await f.storage.getLayerScene(saved.layer.id))!;
  expect(stable.nodes.find((n) => n.id === "b")!.rect).toEqual(
    base.nodes.find((n) => n.id === "b")!.rect,
  );
  expect(stable.strokes).toEqual(base.strokes);
  const rearranged = await f.service.createDraft({
    ...request,
    parentId: saved.layer.id,
    patch: { diagram: { ...updated, layout_revision: 1 } },
  });
  const arranged = await f.service.commitDraft({
    sessionId: "stable",
    draftId: rearranged.draft.id,
    title: "明确重新排版",
  });
  const result = (await f.storage.getLayerScene(arranged.layer.id))!;
  expect(result.nodes.find((n) => n.id === "b")!.rect.y).toBeGreaterThan(
    stable.nodes.find((n) => n.id === "b")!.rect.y,
  );
  expect(result.strokes).toEqual(base.strokes);
});
