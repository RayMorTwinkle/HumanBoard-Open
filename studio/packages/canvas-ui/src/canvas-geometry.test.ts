import { expect, test } from "bun:test";
import { computeAnchorPoint } from "@humanboard/core-engine/scene-svg";
import {
  facingAnchors,
  removeObject,
  hitResizeCorner,
  objectRect,
  resizeRect,
  scenePoint,
  updateObjectRect,
} from "./canvas-geometry";
import { emptyScene } from "./editor";
import { useBoardStore } from "./store/useBoardStore";
const frame = {
  bounds: { x: -48, y: -48, w: 1120, h: 736 },
  image: { left: 200, top: 80, width: 560, height: 368 },
};
test("drag mapping keeps world coordinates with zoom, negative origin and frozen viewport", () => {
  expect(scenePoint([200, 80], frame)).toEqual([-48, -48]);
  expect(scenePoint([760, 448], frame)).toEqual([1072, 688]);
  // Even a pointer outside the old image must produce continuous coordinates.
  expect(scenePoint([900, 500], frame)).toEqual([1352, 792]);
  expect(
    scenePoint([0, 0], { ...frame, image: { ...frame.image, width: 0 } }),
  ).toBeNull();
  expect(
    hitResizeCorner({ x: 0, y: 0, w: 200, h: 100 }, [228, 108], frame),
  ).toBe("nw");
  expect(
    hitResizeCorner({ x: 0, y: 0, w: 200, h: 100 }, [280, 108], frame),
  ).toBeNull();
});
test("corner resize anchors the opposite corner, clamps size and can keep aspect ratio", () => {
  const rect = { x: 100, y: 80, w: 200, h: 100 };
  expect(resizeRect(rect, "se", [50, 25])).toEqual({ ...rect, w: 250, h: 125 });
  expect(resizeRect(rect, "nw", [50, 25])).toEqual({
    x: 150,
    y: 105,
    w: 150,
    h: 75,
  });
  expect(resizeRect(rect, "ne", [50, -25])).toEqual({
    x: 100,
    y: 55,
    w: 250,
    h: 125,
  });
  expect(resizeRect(rect, "sw", [-50, 25])).toEqual({
    x: 50,
    y: 80,
    w: 250,
    h: 125,
  });
  const minimum = resizeRect(rect, "nw", [500, 500]);
  expect(minimum).toEqual({ x: 284, y: 164, w: 16, h: 16 });
  const aspect = resizeRect(rect, "nw", [-100, -10], true);
  expect(aspect.w / aspect.h).toBe(2);
  expect(aspect.x + aspect.w).toBe(rect.x + rect.w);
  expect(aspect.y + aspect.h).toBe(rect.y + rect.h);
  expect(resizeRect(rect, "se", [-50, 0], true)).toEqual({
    ...rect,
    w: 150,
    h: 75,
  });
});
test("resize keeps attached anchors and unrelated objects, groups undo and honors edit locks", () => {
  const initial = useBoardStore.getState();
  try {
    const scene = emptyScene();
    scene.nodes = [
      {
        id: "a",
        kind: "service",
        title: "A",
        rect: { x: 100, y: 100, w: 200, h: 100 },
      },
      {
        id: "b",
        kind: "database",
        title: "B",
        rect: { x: 500, y: 200, w: 160, h: 100 },
      },
    ];
    scene.edges = [
      {
        id: "edge",
        from: { node_id: "a", side: "right", offset: 0.5 },
        to: { node_id: "b", side: "left", offset: 0.5 },
      },
    ];
    scene.assets = [
      {
        asset_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        display_no: "001",
        rect: { x: 50, y: 400, w: 300, h: 200 },
        z: 0,
      },
    ];
    useBoardStore.setState(
      { ...initial, workingScene: scene, undoStack: [] },
      true,
    );
    const rect = objectRect(scene, "a")!;
    initial.editScene((v) =>
      updateObjectRect(v, "a", resizeRect(rect, "se", [40, 20])),
    );
    initial.editScene(
      (v) => updateObjectRect(v, "a", resizeRect(rect, "se", [80, 40])),
      false,
    );
    const resized = useBoardStore.getState().workingScene!;
    expect(resized.edges).toBe(scene.edges);
    expect(resized.nodes[1]).toBe(scene.nodes[1]);
    expect(
      computeAnchorPoint(resized.nodes[0]!.rect, resized.edges[0]!.from),
    ).toEqual({ x: 380, y: 170 });
    expect(resized.assets).toBe(scene.assets);
    expect(useBoardStore.getState().undoStack.length).toBe(1);
    initial.undoStroke();
    expect(useBoardStore.getState().workingScene).toEqual(scene);
    initial.setEditingLocked(true);
    initial.editScene((v) =>
      updateObjectRect(v, "a", resizeRect(rect, "se", [40, 20])),
    );
    expect(useBoardStore.getState().workingScene).toEqual(scene);
  } finally {
    useBoardStore.setState(initial, true);
  }
});
test("one erase gesture restores every erased stroke with a single undo", () => {
  const initial = useBoardStore.getState();
  try {
    const scene = emptyScene();
    scene.strokes = [
      { id: "a", tool: "pen", color: "red", width: 2, points: [[50, 50]] },
      { id: "b", tool: "pen", color: "red", width: 2, points: [[150, 150]] },
    ];
    useBoardStore.setState(
      { ...initial, workingScene: scene, undoStack: [] },
      true,
    );
    initial.eraseAt([0, 0], 16, true); // no hit cannot consume the first checkpoint
    expect(useBoardStore.getState().undoStack).toHaveLength(0);
    initial.eraseAt([50, 50], 16, true);
    initial.eraseAt([150, 150], 16, false);
    expect(useBoardStore.getState().workingScene!.strokes).toHaveLength(0);
    expect(useBoardStore.getState().undoStack).toHaveLength(1);
    initial.undoStroke();
    expect(useBoardStore.getState().workingScene!.strokes).toEqual(
      scene.strokes,
    );
  } finally {
    useBoardStore.setState(initial, true);
  }
});

test("connections use facing sides and deleting a node removes only attached edges", () => {
  const rect = { x: 100, y: 100, w: 100, h: 100 };
  expect(facingAnchors(rect, { ...rect, y: 400 })).toEqual({
    from: "bottom",
    to: "top",
  });
  expect(facingAnchors(rect, { ...rect, y: -200 })).toEqual({
    from: "top",
    to: "bottom",
  });
  expect(facingAnchors(rect, { ...rect, x: 400 })).toEqual({
    from: "right",
    to: "left",
  });
  expect(facingAnchors(rect, { ...rect, x: -200 })).toEqual({
    from: "left",
    to: "right",
  });
  const scene = emptyScene();
  scene.nodes = [
    { id: "a", kind: "note", title: "a", rect },
    { id: "b", kind: "note", title: "b", rect },
  ];
  scene.edges = [
    {
      id: "ab",
      from: { node_id: "a", side: "right", offset: 0.5 },
      to: { node_id: "b", side: "left", offset: 0.5 },
    },
    {
      id: "bb",
      from: { node_id: "b", side: "right", offset: 0.5 },
      to: { node_id: "b", side: "left", offset: 0.5 },
    },
  ];
  const removed = removeObject(scene, "a");
  expect(removed.nodes.map((n) => n.id)).toEqual(["b"]);
  expect(removed.edges.map((e) => e.id)).toEqual(["bb"]);
  expect(scene.nodes).toHaveLength(2);
});

test("legacy small objects can still move while newly entered invalid sizes are rejected", () => {
  const scene = emptyScene();
  scene.nodes = [
    {
      id: "tiny",
      kind: "note",
      title: "tiny",
      rect: { x: 0, y: 0, w: 10, h: 10 },
    },
  ];
  const moved = updateObjectRect(scene, "tiny", { x: 50, y: 60, w: 10, h: 10 });
  expect(moved.nodes[0]!.rect).toEqual({ x: 50, y: 60, w: 10, h: 10 });
  expect(updateObjectRect(scene, "tiny", { x: 0, y: 0, w: 5, h: 10 })).toBe(
    scene,
  );
  expect(
    updateObjectRect(scene, "tiny", { x: Infinity, y: 0, w: 10, h: 10 }),
  ).toBe(scene);
});
