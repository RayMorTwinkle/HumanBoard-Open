import { structuredEdit } from "../structured-edit";
import { readDraft, writeDraft, removeDraft } from "../draft-storage";
import {
  readEdgePreset,
  readPenColor,
  saveEdgePreset,
  savePenColor,
  type EdgePresetId,
} from "../ink";
import { create } from "zustand";
import type { Scene, Stroke } from "@humanboard/schema";
import { SceneSchema } from "@humanboard/schema/scene";
import type {
  AssetManifestItem,
  DiffData,
  GetData,
  InspectData,
  LayersData,
  StatusData,
  Tool,
} from "../client/types";
import { sceneFromGetData } from "../capture";
import { emptyScene, scenesEqual, strokeTouchesEraser } from "../editor";
export type ConnectionState = "checking" | "connected" | "offline";
export type DiffImageMode = "before" | "after" | "highlight";
export interface BoardState {
  connection: ConnectionState;
  status: StatusData | null;
  layers: LayersData | null;
  activeLayerId: string | null;
  currentLayer: GetData | null;
  diff: DiffData | null;
  diffView: boolean;
  diffImageMode: DiffImageMode;
  inspect: InspectData | null;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  workingScene: Scene | null;
  uncommittedStrokes: readonly Stroke[];
  undoStack: readonly Scene[];
  registeredAssets: readonly AssetManifestItem[];
  editingLocked: boolean;
  dirty: boolean;
  commitTitle: string;
  setCommitTitle(title: string): void;
  selectedNodeId: string | null;
  selectedTool: Tool;
  penColor: string;
  setPenColor(color: string): void;
  edgePreset: EdgePresetId;
  setEdgePreset(id: EdgePresetId): void;
  zoom: number;
  pan: { x: number; y: number };
  error: string | null;
  setConnection(v: ConnectionState): void;
  setBoard(v: {
    status: StatusData;
    layers: LayersData;
    activeLayerId: string | null;
    currentLayer: GetData | null;
  }): void;
  setActiveLayer(id: string | null): void;
  setCurrentLayer(v: GetData | null): void;
  setDiff(v: DiffData | null): void;
  setDiffView(v: boolean): void;
  setDiffImageMode(v: DiffImageMode): void;
  setInspect(v: InspectData | null): void;
  setLeftPanelOpen(v: boolean): void;
  setRightPanelOpen(v: boolean): void;
  toggleLeftPanel(): void;
  toggleRightPanel(): void;
  closeOverlays(): void;
  setEditingLocked(v: boolean): void;
  selectNode(id: string | null): void;
  editScene(fn: (scene: Scene) => Scene, checkpoint?: boolean): void;
  registerAsset(v: AssetManifestItem): void;
  startStroke(v: Stroke): void;
  appendStrokePoint(
    id: string,
    point: readonly [number, number],
    pressure?: number,
  ): void;
  eraseAt(
    point: readonly [number, number],
    radius?: number,
    checkpoint?: boolean,
  ): void;
  undoStroke(): void;
  discardStrokes(): void;
  setTool(v: Tool): void;
  setZoom(v: number): void;
  zoomBy(v: number): void;
  setPan(v: { x: number; y: number }): void;
  resetViewport(): void;
  setError(v: string | null): void;
}
const clamp = (v: number) => Math.min(64, Math.max(0.05, v));
function baseScene(layer: GetData | null): Scene {
  return layer ? sceneFromGetData(layer) : emptyScene();
}
function edits(state: Pick<BoardState, "currentLayer">, scene: Scene) {
  const base = baseScene(state.currentLayer);
  const ids = new Set(base.strokes.map((x) => x.id));
  return {
    workingScene: scene,
    dirty: !scenesEqual(base, scene),
    uncommittedStrokes: scene.strokes.filter((x) => !ids.has(x.id)),
  };
}
function recover(layer: GetData): Scene | null {
  try {
    const value = readDraft(layer.layer.id);
    if (!value) return null;
    const parsed = JSON.parse(value);
    const checked = SceneSchema.safeParse(parsed.scene ?? parsed);
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}
export const useBoardStore = create<BoardState>((set, get) => ({
  connection: "checking",
  status: null,
  layers: null,
  activeLayerId: null,
  currentLayer: null,
  diff: null,
  diffView: false,
  diffImageMode: "highlight",
  inspect: null,
  leftPanelOpen: true,
  rightPanelOpen: true,
  workingScene: null,
  uncommittedStrokes: [],
  undoStack: [],
  registeredAssets: [],
  editingLocked: false,
  dirty: false,
  commitTitle: "",
  setCommitTitle: (commitTitle) => set({ commitTitle }),
  selectedNodeId: null,
  selectedTool: "select",
  penColor: readPenColor(),
  setPenColor: (penColor) => {
    savePenColor(penColor);
    set({ penColor });
  },
  edgePreset: readEdgePreset(),
  setEdgePreset: (edgePreset) => {
    saveEdgePreset(edgePreset);
    set({ edgePreset });
  },
  zoom: 1,
  pan: { x: 0, y: 0 },
  error: null,
  setConnection: (connection) => {
    if (get().connection !== connection) set({ connection });
  },
  setBoard: (v) => {
    const state = get();
    const scene =
      v.currentLayer && state.currentLayer?.layer.id !== v.currentLayer.layer.id
        ? recover(v.currentLayer)
        : state.workingScene;
    let restoredAssets: AssetManifestItem[] = [];
    try {
      restoredAssets =
        JSON.parse(
          (v.currentLayer ? readDraft(v.currentLayer.layer.id) : null) ??
            "null",
        )?.assets ?? [];
    } catch {}
    set({
      ...v,
      status:
        JSON.stringify(state.status) === JSON.stringify(v.status)
          ? state.status
          : v.status,
      layers:
        JSON.stringify(state.layers) === JSON.stringify(v.layers)
          ? state.layers
          : v.layers,
      currentLayer:
        JSON.stringify(state.currentLayer) === JSON.stringify(v.currentLayer)
          ? state.currentLayer
          : v.currentLayer,
      registeredAssets:
        state.currentLayer?.layer.id === v.currentLayer?.layer.id
          ? state.registeredAssets
          : restoredAssets,
      connection: "connected",
      ...(v.currentLayer &&
      (state.currentLayer?.layer.id !== v.currentLayer.layer.id ||
        !state.workingScene)
        ? edits(
            { currentLayer: v.currentLayer },
            scene ?? baseScene(v.currentLayer),
          )
        : {}),
    });
  },
  setActiveLayer: (activeLayerId) =>
    set({
      activeLayerId,
      diffView: false,
      diffImageMode: "highlight",
      diff: null,
      inspect: null,
      workingScene: null,
      uncommittedStrokes: [],
      undoStack: [],
      dirty: false,
      commitTitle: "",
      selectedNodeId: null,
      registeredAssets: [],
    }),
  setCurrentLayer: (currentLayer) => {
    let registeredAssets: AssetManifestItem[] = [];
    try {
      registeredAssets =
        JSON.parse(
          (currentLayer ? readDraft(currentLayer.layer.id) : null) ?? "null",
        )?.assets ?? [];
    } catch {}
    set({
      currentLayer,
      registeredAssets,
      ...(currentLayer
        ? edits(
            { currentLayer },
            recover(currentLayer) ?? baseScene(currentLayer),
          )
        : {}),
    });
  },
  setDiff: (diff) => set({ diff }),
  setDiffView: (diffView) => set({ diffView }),
  setDiffImageMode: (diffImageMode) => set({ diffImageMode }),
  setInspect: (inspect) => set({ inspect }),
  setLeftPanelOpen: (leftPanelOpen) => set({ leftPanelOpen }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  closeOverlays: () => set({ diffView: false, inspect: null }),
  setEditingLocked: (editingLocked) => set({ editingLocked }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  editScene: (fn, checkpoint = true) => {
    const state = get();
    if (state.editingLocked) return;
    const previous = state.workingScene ?? baseScene(state.currentLayer);
    let next: Scene;
    try {
      next = structuredEdit(previous, fn(previous), state.selectedNodeId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (scenesEqual(previous, next)) return;
    const nextEdits = edits(state, next);
    if (!nextEdits.dirty && state.currentLayer) {
      try {
        removeDraft(state.currentLayer.layer.id);
      } catch {}
    }
    set({
      ...nextEdits,
      undoStack: checkpoint
        ? [...state.undoStack, previous].slice(-50)
        : state.undoStack,
    });
  },
  registerAsset: (asset) =>
    set((s) => ({ registeredAssets: [...s.registeredAssets, asset] })),
  startStroke: (stroke) =>
    get().editScene((scene) => ({
      ...scene,
      strokes: [...scene.strokes, stroke],
    })),
  appendStrokePoint: (id, point, pressure) =>
    get().editScene(
      (scene) => ({
        ...scene,
        strokes: scene.strokes.map((s) =>
          s.id !== id
            ? s
            : {
                ...s,
                points: [...s.points, [point[0], point[1]]],
                ...(s.pressure
                  ? {
                      pressure: [
                        ...s.pressure,
                        pressure ?? s.pressure.at(-1) ?? 0.5,
                      ],
                    }
                  : {}),
              },
        ),
      }),
      false,
    ),
  eraseAt: (point, radius = 16, checkpoint = true) =>
    get().editScene(
      (scene) => ({
        ...scene,
        strokes: scene.strokes.filter(
          (s) => !strokeTouchesEraser(s, point, radius),
        ),
      }),
      checkpoint,
    ),
  undoStroke: () => {
    const s = get();
    if (s.editingLocked || !s.undoStack.length) return;
    const nextEdits = edits(s, s.undoStack.at(-1)!);
    if (!nextEdits.dirty && s.currentLayer) {
      try {
        removeDraft(s.currentLayer.layer.id);
      } catch {}
    }
    set({
      ...nextEdits,
      undoStack: s.undoStack.slice(0, -1),
    });
  },
  discardStrokes: () => {
    const s = get();
    if (s.editingLocked) return;
    try {
      if (s.currentLayer) removeDraft(s.currentLayer.layer.id);
    } catch {}
    set({
      ...edits(s, baseScene(s.currentLayer)),
      undoStack: [],
      registeredAssets: [],
    });
  },
  setTool: (selectedTool) => set({ selectedTool }),
  setZoom: (zoom) => set({ zoom: clamp(zoom) }),
  zoomBy: (delta) => set((s) => ({ zoom: clamp(s.zoom + delta) })),
  setPan: (pan) => set({ pan }),
  resetViewport: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
  setError: (error) => {
    if (get().error !== error) set({ error });
  },
}));
// Recover the actual editable Scene after a reload; never persist model tokens.
// Serializing the scene is costly, so a burst of edits (dragging a node) writes at most
// every 250ms: the first edit at once, the latest state when the burst settles or the page hides.
const DRAFT_INTERVAL = 250;
let lastDraftWrite = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
function persistDraft(state: BoardState) {
  clearTimeout(draftTimer);
  draftTimer = undefined;
  if (!state.currentLayer || !state.dirty || !state.workingScene) return;
  lastDraftWrite = Date.now();
  try {
    writeDraft(
      state.currentLayer.layer.id,
      JSON.stringify({
        scene: state.workingScene,
        assets: state.registeredAssets,
      }),
    );
  } catch {
    /* private mode / storage quota: the live draft remains editable */
  }
}
const flushDraft = () => {
  if (draftTimer) persistDraft(useBoardStore.getState());
};
useBoardStore.subscribe((state, previous) => {
  if (
    draftTimer &&
    previous.currentLayer?.layer.id !== state.currentLayer?.layer.id
  )
    persistDraft(previous);
  if (!state.currentLayer || !state.dirty || !state.workingScene) return;
  if (
    state.workingScene === previous.workingScene &&
    state.registeredAssets === previous.registeredAssets &&
    state.currentLayer === previous.currentLayer
  )
    return;
  const wait = lastDraftWrite + DRAFT_INTERVAL - Date.now();
  if (wait <= 0) persistDraft(state);
  else draftTimer ??= setTimeout(flushDraft, wait);
});
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDraft();
  });
}
