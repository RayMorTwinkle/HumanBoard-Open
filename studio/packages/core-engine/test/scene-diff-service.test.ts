import { describe, expect, test } from "bun:test";

import type { Edge, Node, Scene, Stroke } from "@humanboard/schema";

import {
  SceneDiffService,
  diffScenes,
} from "../src/services/scene-diff-service";
import {
  TEST_AUTHOR,
  commitRoot,
  createFixture,
  sceneWithNode,
} from "./helpers";

function node(
  id: string,
  overrides: Partial<Node> = {},
): Node {
  return {
    id,
    kind: "state",
    title: id,
    rect: { x: 10, y: 20, w: 100, h: 50 },
    ...overrides,
  };
}

function edge(
  id: string,
  overrides: Partial<Edge> = {},
): Edge {
  return {
    id,
    from: { node_id: "n1", side: "right", offset: 0.5 },
    to: { node_id: "n2", side: "left", offset: 0.5 },
    ...overrides,
  };
}

function stroke(
  id: string,
  points: [number, number][] = [
    [1, 2],
    [3, 4],
  ],
): Stroke {
  return {
    id,
    tool: "pen",
    color: "#FF0000",
    width: 2,
    points,
  };
}

function emptyScene(): Scene {
  return { nodes: [], edges: [], strokes: [], assets: [] };
}

describe("diffScenes node semantics", () => {
  test("reports add, remove, move, resize, and update separately", () => {
    const base: Scene = {
      ...emptyScene(),
      nodes: [
        node("moved"),
        node("resized"),
        node("updated", { title: "old" }),
        node("removed"),
      ],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [
        node("moved", { rect: { x: 30, y: 20, w: 100, h: 50 } }),
        node("resized", { rect: { x: 10, y: 20, w: 140, h: 80 } }),
        node("updated", { title: "new" }),
        node("added"),
      ],
    };

    const result = diffScenes(base, target);
    expect(result.mode).toBe("ast");
    expect(result.ast?.nodes.added.map((item) => item.id)).toEqual(["added"]);
    expect(result.ast?.nodes.removed.map((item) => item.id)).toEqual([
      "removed",
    ]);
    expect(result.ast?.nodes.moved.map((item) => item.id)).toEqual(["moved"]);
    expect(result.ast?.nodes.resized.map((item) => item.id)).toEqual([
      "resized",
    ]);
    expect(result.ast?.nodes.updated).toEqual([
      { id: "updated", fields: ["title"] },
    ]);
  });

  test("treats simultaneous position and size changes as moved, not resized", () => {
    const base: Scene = {
      ...emptyScene(),
      nodes: [node("n1")],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [node("n1", { rect: { x: 30, y: 40, w: 120, h: 70 } })],
    };

    const result = diffScenes(base, target);
    expect(result.ast?.nodes.moved.map((item) => item.id)).toEqual(["n1"]);
    expect(result.ast?.nodes.resized).toEqual([]);
  });
});

describe("diffScenes edge semantics", () => {
  test("matches edges by id and reports updated fields", () => {
    const base: Scene = {
      ...emptyScene(),
      edges: [edge("kept", { label: "old" }), edge("removed")],
    };
    const target: Scene = {
      ...emptyScene(),
      edges: [
        edge("kept", { label: "new", style: { dashed: true } }),
        edge("added"),
      ],
    };

    const result = diffScenes(base, target);
    expect(result.mode).toBe("ast");
    expect(result.ast?.edges.added.map((item) => item.id)).toEqual(["added"]);
    expect(result.ast?.edges.removed.map((item) => item.id)).toEqual([
      "removed",
    ]);
    expect(result.ast?.edges.updated).toEqual([
      { id: "kept", fields: ["label", "style"] },
    ]);
  });
});

describe("diffScenes visual semantics", () => {
  test("reports changed strokes with the same id and added/removed strokes", () => {
    const base: Scene = {
      ...emptyScene(),
      strokes: [stroke("changed"), stroke("removed")],
    };
    const target: Scene = {
      ...emptyScene(),
      strokes: [
        stroke("changed", [
          [9, 9],
          [10, 10],
        ]),
        stroke("added"),
      ],
    };

    const result = diffScenes(base, target);
    expect(result.mode).toBe("visual");
    expect(result.visual?.strokes.added.map((item) => item.id)).toEqual([
      "added",
    ]);
    expect(result.visual?.strokes.removed.map((item) => item.id)).toEqual([
      "removed",
    ]);
    expect(result.visual?.strokes.updated).toEqual([
      { id: "changed", fields: ["points"] },
    ]);
  });
});

describe("diffScenes mode", () => {
  test("returns empty for identical Scenes", () => {
    const scene = sceneWithNode("n1");
    expect(diffScenes(scene, scene)).toMatchObject({
      mode: "empty",
      summary: "",
    });
  });

  test("returns transform for first structure regardless of layer kind", async () => {
    const fixture = await createFixture();
    const sketch: Scene = {
      ...emptyScene(),
      strokes: [stroke("s1")],
    };
    const root = await commitRoot(fixture, "root", sketch);

    const transformDraft = await fixture.service.createDraft({
      sessionId: "transform",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "transform",
      parentId: root.layerId,
      scene: sceneWithNode("n1"),
      author: TEST_AUTHOR,
    });
    const transformed = await fixture.service.commitDraft({
      sessionId: "transform",
      draftId: transformDraft.draft.id,
    });

    const redoDraft = await fixture.service.createDraft({
      sessionId: "redo",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "redo",
      parentId: transformed.layer.id,
      scene: sceneWithNode("n2"),
      author: TEST_AUTHOR,
    });
    const redone = await fixture.service.commitDraft({
      sessionId: "redo",
      draftId: redoDraft.draft.id,
    });

    expect(redone.layer.kind).toBe("redo");
    const result = await new SceneDiffService(fixture.storage).diffLayers(
      root.layerId,
      redone.layer.id,
    );
    expect(result.mode).toBe("transform");
    expect(result.ast_summary).toEqual({
      nodes: 1,
      edges: 0,
      notable: ["n2"],
    });
    expect(result.ast).toBeUndefined();
    expect(result.summary.startsWith("@转化：")).toBe(true);
  });

  test("returns mixed when structure and strokes both change", () => {
    const base: Scene = {
      ...emptyScene(),
      nodes: [node("n1")],
      strokes: [stroke("s1")],
    };
    const target: Scene = {
      ...emptyScene(),
      nodes: [node("n1"), node("n2")],
      strokes: [stroke("s1"), stroke("s2")],
    };

    const result = diffScenes(base, target);
    expect(result.mode).toBe("mixed");
    expect(result.ast).toBeDefined();
    expect(result.visual).toBeDefined();
  });
});
