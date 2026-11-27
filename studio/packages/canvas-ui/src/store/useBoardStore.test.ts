import { beforeEach, describe, expect, test } from "bun:test";

import type { Stroke } from "@humanboard/schema";

import { useBoardStore } from "./useBoardStore";

const initialState = useBoardStore.getState();

beforeEach(() => {
  useBoardStore.setState(initialState, true);
});

describe("useBoardStore", () => {
  test("updates active layer, tool, zoom, and pan state", () => {
    const store = useBoardStore.getState();
    store.setActiveLayer("layer-2");
    store.setTool("pen");
    store.setZoom(1.75);
    store.setPan({ x: 42, y: -18 });

    const state = useBoardStore.getState();
    expect(state.activeLayerId).toBe("layer-2");
    expect(state.selectedTool).toBe("pen");
    expect(state.zoom).toBe(1.75);
    expect(state.pan).toEqual({ x: 42, y: -18 });
  });

  test("clamps zoom and resets the viewport", () => {
    const store = useBoardStore.getState();
    store.setZoom(100);
    expect(useBoardStore.getState().zoom).toBe(64);
    store.zoomBy(-100);
    expect(useBoardStore.getState().zoom).toBe(0.05);
    store.setPan({ x: 12, y: 8 });
    store.resetViewport();
    expect(useBoardStore.getState().zoom).toBe(1);
    expect(useBoardStore.getState().pan).toEqual({ x: 0, y: 0 });
  });

  test("selecting a layer clears diff and inspect state", () => {
    const store = useBoardStore.getState();
    store.setDiff({
      mode: "ast",
      summary: "changed",
      base: { id: "a", short_id: "L1", seq: 1 },
      target: { id: "b", short_id: "L2", seq: 2 },
      warnings: [],
    });
    store.setDiffView(true);
    store.setActiveLayer("layer-3");
    expect(useBoardStore.getState().diff).toBeNull();
    expect(useBoardStore.getState().diffView).toBe(false);
    expect(useBoardStore.getState().inspect).toBeNull();
  });

  test("toggles panels, switches diff images, and closes overlays", () => {
    const store = useBoardStore.getState();
    expect(store.leftPanelOpen).toBe(true);
    expect(store.rightPanelOpen).toBe(true);

    store.toggleLeftPanel();
    store.toggleRightPanel();
    expect(useBoardStore.getState().leftPanelOpen).toBe(false);
    expect(useBoardStore.getState().rightPanelOpen).toBe(false);

    store.setDiffImageMode("before");
    store.setDiffView(true);
    store.setInspect({} as never);
    expect(useBoardStore.getState().diffImageMode).toBe("before");

    useBoardStore.getState().closeOverlays();
    expect(useBoardStore.getState().diffView).toBe(false);
    expect(useBoardStore.getState().inspect).toBeNull();
  });

  test("tracks uncommitted strokes, point pressure, erase, and undo", () => {
    const stroke: Stroke = {
      id: "s1",
      tool: "pen",
      color: "#ff5b47",
      width: 3.2,
      points: [[10, 20]],
      pressure: [0.5],
    };
    const store = useBoardStore.getState();
    store.startStroke(stroke);
    store.appendStrokePoint("s1", [30, 40], 0.7);
    let state = useBoardStore.getState();
    expect(state.uncommittedStrokes).toHaveLength(1);
    expect(state.uncommittedStrokes[0]!.points).toEqual([
      [10, 20],
      [30, 40],
    ]);
    expect(state.uncommittedStrokes[0]!.pressure).toEqual([0.5, 0.7]);

    state.eraseAt([30, 40], 4);
    expect(useBoardStore.getState().uncommittedStrokes).toHaveLength(0);
    useBoardStore.getState().undoStroke();
    expect(useBoardStore.getState().uncommittedStrokes).toHaveLength(1);
  });

  test("keeps at most 50 undo snapshots", () => {
    const store = useBoardStore.getState();
    for (let index = 0; index < 60; index += 1) {
      store.startStroke({
        id: `s${index}`,
        tool: "highlighter",
        color: "#ffd166",
        width: 18,
        points: [[index, index]],
      });
    }
    expect(useBoardStore.getState().uncommittedStrokes).toHaveLength(60);
    expect(useBoardStore.getState().undoStack).toHaveLength(50);
    useBoardStore.getState().undoStroke();
    expect(useBoardStore.getState().uncommittedStrokes).toHaveLength(59);
  });
});

test("locks all editing mutations during a pending save and preserves the draft", () => {
  const s = useBoardStore.getState();
  s.startStroke({
    id: "pending",
    tool: "pen",
    color: "red",
    width: 3,
    points: [[1, 2]],
  });
  const snapshot = useBoardStore.getState().workingScene;
  s.setEditingLocked(true);
  s.startStroke({
    id: "late",
    tool: "pen",
    color: "red",
    width: 3,
    points: [[3, 4]],
  });
  s.eraseAt([1, 2]);
  s.undoStroke();
  s.discardStrokes();
  expect(useBoardStore.getState().workingScene).toEqual(snapshot);
  s.setEditingLocked(false);
  s.discardStrokes();
  expect(useBoardStore.getState().dirty).toBe(false);
});

test("eraser hits a visible segment between sparse pointer samples", () => {
  const scene = {
    nodes: [],
    edges: [],
    assets: [],
    strokes: [
      {
        id: "sparse",
        tool: "pen" as const,
        color: "red",
        width: 8,
        points: [
          [0, 0],
          [500, 0],
        ] as [number, number][],
      },
    ],
  };
  useBoardStore.setState({ workingScene: scene, undoStack: [] });
  const store = useBoardStore.getState();
  store.eraseAt([250, 20], 8);
  expect(useBoardStore.getState().workingScene!.strokes).toHaveLength(1);
  store.eraseAt([250, 10], 8);
  expect(useBoardStore.getState().workingScene!.strokes).toHaveLength(0);
  store.undoStroke();
  expect(useBoardStore.getState().workingScene!.strokes).toEqual(scene.strokes);
});

test("background board refresh does not erase an operation error before it can be read", () => {
  const store = useBoardStore.getState();
  store.setError("URL 被地址校验拒绝");
  store.setBoard({
    status: {
      project: { id: "p", name: "p", root: null },
      space: { id: "s", name: "s" },
      active_layer: null,
      layers: [],
      layers_truncated: false,
      total_layers: 0,
      spaces: [],
      warnings: [],
    },
    layers: {
      space: { id: "s", name: "s" },
      active_layer: null,
      layers: [],
      edges: [],
    },
    activeLayerId: null,
    currentLayer: null,
  });
  expect(useBoardStore.getState().error).toBe("URL 被地址校验拒绝");
});

test("clean store updates never delete another tab's durable recovery", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    },
  });
  try {
    useBoardStore.setState({
      currentLayer: { layer: { id: "clean-tab" } } as never,
      dirty: false,
    });
    const recovery = JSON.stringify({
      scene: { nodes: [], edges: [], assets: [], strokes: [] },
    });
    data.set("humanboard:draft:clean-tab", recovery);
    useBoardStore.getState().setPan({ x: 20, y: 30 });
    expect(data.get("humanboard:draft:clean-tab")).toBe(recovery);
  } finally {
    useBoardStore.setState(initialState, true);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("undoing the final edit clears only this tab's draft so refresh cannot resurrect it", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    },
  });
  try {
    const layer = {
      layer: { id: "undo-recovery" },
      ast: { nodes: [], edges: [] },
      strokes: { items: [] },
      assets: [],
    } as never;
    useBoardStore.getState().setCurrentLayer(layer);
    useBoardStore.getState().startStroke({
      id: "undo-stroke",
      tool: "pen",
      color: "#ff0000",
      width: 3,
      points: [[0, 0]],
    });
    expect(data.has("humanboard:draft:undo-recovery")).toBe(true);
    useBoardStore.getState().undoStroke();
    expect(data.has("humanboard:draft:undo-recovery")).toBe(false);
    useBoardStore.getState().setCurrentLayer(layer);
    expect(useBoardStore.getState().workingScene!.strokes).toHaveLength(0);
  } finally {
    useBoardStore.setState(initialState, true);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
