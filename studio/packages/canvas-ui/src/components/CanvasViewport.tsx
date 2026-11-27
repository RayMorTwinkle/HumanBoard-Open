import { DiagramControls } from "./DiagramControls";
import { withPaperGrid } from "../paper-grid";
import { EdgeInspector } from "./EdgeInspector";
import { ObjectInspector } from "./ObjectInspector";
import { boardShortcutsBlocked } from "../board-shortcuts";
import {
  facingAnchors,
  hitEdge,
  hitResizeCorner,
  objectRect,
  resizeRect,
  scenePoint,
  updateObjectRect,
  type CanvasFrame,
  type ResizeCorner,
} from "../canvas-geometry";
import { insertBoardAsset } from "../asset-insertion";
import {
  appendCanvasOverlays,
  liveAnnotationOverlay,
} from "../live-annotations";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as Pointer,
} from "react";
import {
  backToFront,
  computeSceneBounds,
  renderSceneToSVG,
} from "@humanboard/core-engine/scene-svg";
import type { Scene, Stroke } from "@humanboard/schema";
import { canonicalizeScene } from "@humanboard/schema/scene";
import { renderDiffToSVGs } from "@humanboard/core-engine/scene-diff-svg";
import type { GetData } from "../client/types";
import {
  HumanBoardClient,
  renderUrlForBrowser,
} from "../client/HumanBoardClient";
import { useShallow } from "zustand/react/shallow";
import { useBoardStore } from "../store/useBoardStore";
import { sceneFromGetData } from "../capture";
import { CANVAS_INK, useTheme } from "../theme";
import { EDGE_PRESETS } from "../ink";

const inkPoints = (stroke: Stroke) =>
  stroke.points.map(([x, y]) => `${x},${y}`).join(" ");

export function CanvasViewport() {
  // Only what the canvas draws from; pointer-rate updates elsewhere must not re-render it.
  const state = useBoardStore(
    useShallow((s) => ({
      currentLayer: s.currentLayer,
      workingScene: s.workingScene,
      diff: s.diff,
      diffView: s.diffView,
      diffImageMode: s.diffImageMode,
      selectedTool: s.selectedTool,
      editingLocked: s.editingLocked,
      selectedNodeId: s.selectedNodeId,
      zoom: s.zoom,
      pan: s.pan,
      activeLayerId: s.activeLayerId,
      dirty: s.dirty,
      registeredAssets: s.registeredAssets,
      status: s.status,
      editScene: s.editScene,
      resetViewport: s.resetViewport,
      selectNode: s.selectNode,
      setTool: s.setTool,
      zoomBy: s.zoomBy,
    })),
  );
  const theme = useTheme();
  const {
    currentLayer,
    workingScene,
    diff,
    diffView,
    diffImageMode,
    selectedTool,
    editingLocked,
    selectedNodeId,
    zoom,
    pan,
  } = state;
  const scene = useMemo(
    () =>
      workingScene ?? (currentLayer ? sceneFromGetData(currentLayer) : null),
    [workingScene, currentLayer],
  );
  const imageRef = useRef<HTMLImageElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const gesture = useRef<null | {
    pointer: number;
    mode: "draw" | "erase" | "pan" | "move" | "resize";
    frame: CanvasFrame;
    corner?: ResizeCorner;
    checkpointed?: boolean;
    id?: string;
    x: number;
    y: number;
    px: number;
    py: number;
    scene?: Scene;
    stroke?: Stroke;
    latest?: { clientX: number; clientY: number; shiftKey: boolean };
  }>(null);
  // Ink in progress is drawn straight into this overlay and enters the scene on release,
  // so a stroke never re-renders the whole board per pointer sample.
  const inkRef = useRef<SVGPolylineElement>(null);
  const [liveInk, setLiveInk] = useState<{
    stroke: Stroke;
    frame: CanvasFrame;
    origin: { left: number; top: number };
    releasing?: boolean;
  } | null>(null);
  const moveFrame = useRef(0);
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const glide = (change: () => void) => {
    const shell = shellRef.current;
    shell?.classList.add("is-gliding");
    clearTimeout(glideTimer.current);
    glideTimer.current = setTimeout(
      () => shell?.classList.remove("is-gliding"),
      260,
    );
    change();
  };
  useEffect(() => {
    if (!liveInk?.releasing) return;
    const timer = setTimeout(() => setLiveInk(null), 400);
    return () => clearTimeout(timer);
  }, [liveInk?.releasing]);
  const [gestureBounds, setGestureBounds] = useState<
    CanvasFrame["bounds"] | null
  >(null);
  const [hoverCorner, setHoverCorner] = useState<ResizeCorner | null>(null);
  const [dragging, setDragging] = useState(false);
  const [alt, setAlt] = useState(false);
  const [edgeStart, setEdgeStart] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const diffKey = diff ? `${diff.base.id}:${diff.target.id}` : "";
  const [comparison, setComparison] = useState<{
    key: string;
    before: GetData;
    after: GetData;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!diff?.visual) {
      setComparison(null);
      return;
    }
    const client = new HumanBoardClient({
      project: state.status?.project.id,
      space: state.status?.space.id,
    });
    void Promise.all([
      client.get(diff.base.id, "ast", { withStrokes: true }),
      client.get(diff.target.id, "ast", { withStrokes: true }),
    ])
      .then(([before, after]) => {
        if (!cancelled) setComparison({ key: diffKey, before, after });
      })
      .catch((e) => {
        if (!cancelled)
          useBoardStore.getState().setError(`对比预览加载失败：${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [diffKey, !!diff?.visual]);
  const assets = [
    ...new Map(
      [
        ...(currentLayer?.assets ?? []),
        ...state.registeredAssets,
        ...(comparison?.key === diffKey
          ? [...comparison.before.assets, ...comparison.after.assets]
          : []),
      ].map((asset) => [asset.asset_id, asset]),
    ).values(),
  ];
  const assetKey = assets
    .map(
      (a) =>
        `${a.asset_id}:${a.blob_hash}:${a.title}:${a.source_url}:${a.description}`,
    )
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    void Promise.all(
      assets
        .filter((a) => a.type === "image")
        .map(async (a) => {
          const response = await fetch(
            `/api/assets/${encodeURIComponent(a.asset_id)}/image`,
            { signal: abort.signal },
          );
          if (!response.ok) throw new Error(`图片 #${a.display_no} 加载失败`);
          const blob = await response.blob();
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return [a.asset_id, url] as const;
        }),
    )
      .then((entries) => {
        if (!cancelled) setImages(Object.fromEntries(entries));
      })
      .catch((e) => {
        if (!cancelled) useBoardStore.getState().setError(String(e));
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [assetKey]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (boardShortcutsBlocked(e)) return;
      if (e.key === "Alt") {
        const target = e.target as HTMLElement | null;
        if (
          target?.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
        )
          return;
        setAlt(true);
        const s = useBoardStore.getState();
        if (
          s.currentLayer?.layer.parent_id &&
          (!s.diff?.visual || s.diff.target.id !== s.currentLayer.layer.id)
        ) {
          const id = s.currentLayer.layer.id;
          void new HumanBoardClient({
            project: s.status?.project.id,
            space: s.status?.space.id,
          })
            .diff(id, undefined, true)
            .then((d) => {
              if (useBoardStore.getState().currentLayer?.layer.id === id)
                useBoardStore.getState().setDiff(d);
            })
            .catch((err) => useBoardStore.getState().setError(String(err)));
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAlt(false);
    };
    const blur = () => setAlt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const wheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".object-inspector")) return;
      e.preventDefault();
      if (gesture.current) return;
      if (e.ctrlKey || e.metaKey)
        useBoardStore.getState().zoomBy(e.deltaY > 0 ? -0.08 : 0.08);
      else {
        const s = useBoardStore.getState();
        s.setPan({ x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY });
      }
    };
    shell.addEventListener("wheel", wheel, { passive: false });
    return () => shell.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    if (editingLocked) {
      gesture.current = null;
      setGestureBounds(null);
    }
  }, [editingLocked]);
  useEffect(() => {
    gesture.current = null;
    setGestureBounds(null);
    setEdgeStart(null);
  }, [state.activeLayerId]);
  useEffect(() => {
    if (
      selectedTool !== "edge" ||
      (edgeStart && !scene?.nodes.some((n) => n.id === edgeStart))
    )
      setEdgeStart(null);
  }, [selectedTool, scene, edgeStart]);
  // The browser renders its own before/after/highlight, so server PNGs are only a fallback.
  const showDiff = (diffView || alt) && !!diff?.visual;
  const mode = alt ? "highlight" : diffImageMode;
  const bounds = useMemo(
    () =>
      gestureBounds ??
      (scene ? computeSceneBounds(scene) : { x: -48, y: -48, w: 1120, h: 736 }),
    [scene, gestureBounds],
  );
  const cards = Object.fromEntries(
    assets
      .filter((a) => a.type === "url" && a.source_url)
      .map((a) => [
        a.asset_id,
        { url: a.source_url!, description: a.description },
      ]),
  );
  const source = useMemo(() => {
    if (!scene) return "";
    const displayScene =
      selectedTool === "select" && selectedNodeId?.startsWith("edge:")
        ? {
            ...scene,
            edges: scene.edges.map((e) =>
              e.id === selectedNodeId.slice(5)
                ? {
                    ...e,
                    style: { ...e.style, color: CANVAS_INK[theme].selection },
                  }
                : e,
            ),
          }
        : scene;
    const svg = renderSceneToSVG(displayScene, {
      theme,
      background: "transparent",
      bounds,
      assetImages: images,
      assetCards: cards,
      assetTitles: Object.fromEntries(
        assets.map((a) => [a.asset_id, a.title || a.source_url || "图片"]),
      ),
    });
    const overlay = currentLayer
      ? liveAnnotationOverlay(sceneFromGetData(currentLayer), scene)
      : "";
    const selection =
      selectedTool === "select" ? objectRect(scene, selectedNodeId) : undefined;
    const outline = selection
      ? `<g data-ui-selection="true" fill="${CANVAS_INK[theme].handle}" stroke="${CANVAS_INK[theme].selection}" stroke-width="1.5"><rect x="${selection.x}" y="${selection.y}" width="${selection.w}" height="${selection.h}" rx="2" fill="none" stroke-dasharray="5 4"/>${["nw", "ne", "sw", "se"].map((c) => `<rect x="${selection.x + (c.includes("e") ? selection.w : 0) - 5}" y="${selection.y + (c.includes("s") ? selection.h : 0) - 5}" width="10" height="10" rx="2"/>`).join("")}</g>`
      : "";
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(appendCanvasOverlays(withPaperGrid(svg, bounds, theme === "dark"), overlay, outline))}`;
  }, [
    scene,
    bounds,
    images,
    assetKey,
    currentLayer,
    selectedNodeId,
    selectedTool,
    theme,
  ]);
  const comparisonSources = useMemo(() => {
    if (!comparison || comparison.key !== diffKey) return null;
    return renderDiffToSVGs(
      sceneFromGetData(comparison.before),
      sceneFromGetData(comparison.after),
      {
        theme,
        background: "transparent",
        assetImages: images,
        assetCards: Object.fromEntries(
          assets
            .filter((a) => a.type === "url" && a.source_url)
            .map((a) => [
              a.asset_id,
              { url: a.source_url!, description: a.description },
            ]),
        ),
        assetTitles: Object.fromEntries(
          assets.map((a) => [a.asset_id, a.title || "图片"]),
        ),
      },
    );
  }, [comparison, diffKey, images, assetKey, theme]);
  const browserSource = showDiff
    ? comparisonSources
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(comparisonSources[mode])}`
      : renderUrlForBrowser(diff!.visual![mode].url)
    : source;
  // The sheet label sits on the rendered board's top-left corner, so it tracks pan and zoom.
  const [sheetCorner, setSheetCorner] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const displayBounds = showDiff ? diff!.visual!.bounds : bounds;
  useLayoutEffect(() => {
    const image = imageRef.current,
      shell = shellRef.current;
    if (!image || !shell) {
      setSheetCorner(null);
      return;
    }
    const measure = () => {
      const r = image.getBoundingClientRect(),
        s = shell.getBoundingClientRect();
      const left = Math.round(r.left - s.left),
        top = Math.round(r.top - s.top);
      const fit = parseFloat(getComputedStyle(image).width) / displayBounds.w;
      if (Number.isFinite(fit) && fit > 0)
        setFitScale((old) => (Math.abs(old - fit) < 0.00001 ? old : fit));
      setSheetCorner((prev) =>
        prev?.left === left && prev.top === top ? prev : { left, top },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    observer.observe(shell);
    image.addEventListener("load", measure);
    image.parentElement?.addEventListener("transitionend", measure);
    return () => {
      observer.disconnect();
      image.removeEventListener("load", measure);
      image.parentElement?.removeEventListener("transitionend", measure);
    };
  }, [browserSource, zoom, pan.x, pan.y, displayBounds.w]);
  const currentFrame = (): CanvasFrame | null => {
    const r = imageRef.current?.getBoundingClientRect();
    return r
      ? {
          bounds,
          image: { left: r.left, top: r.top, width: r.width, height: r.height },
        }
      : null;
  };
  const point = (e: Pointer<HTMLElement>): [number, number] | null => {
    const frame = gesture.current?.frame ?? currentFrame();
    return frame && scene ? scenePoint([e.clientX, e.clientY], frame) : null;
  };
  const onDown = (e: Pointer<HTMLElement>) => {
    if (gesture.current || e.button !== 0 || editingLocked || showDiff) return;
    const p = point(e);
    const frame = currentFrame();
    if (!p || !scene || !frame) return;
    const s = useBoardStore.getState();
    const selectedRect = objectRect(scene, selectedNodeId);
    const corner =
      selectedTool === "select" && !scene.diagram && selectedRect
        ? hitResizeCorner(selectedRect, [e.clientX, e.clientY], frame)
        : null;
    if (corner) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setGestureBounds(bounds);
      gesture.current = {
        pointer: e.pointerId,
        mode: "resize",
        id: selectedNodeId!,
        corner,
        x: p[0],
        y: p[1],
        px: 0,
        py: 0,
        scene,
        frame,
      };
      return;
    }
    const ordered = canonicalizeScene(scene);
    const node = backToFront(ordered.nodes)
      .reverse()
      .find(
        (n) =>
          p[0] >= n.rect.x &&
          p[0] <= n.rect.x + n.rect.w &&
          p[1] >= n.rect.y &&
          p[1] <= n.rect.y + n.rect.h,
      );
    const asset = [...ordered.assets]
      .sort(
        (a, b) =>
          b.z - a.z ||
          (a.asset_id < b.asset_id ? 1 : a.asset_id > b.asset_id ? -1 : 0),
      )
      .find(
        (a) =>
          p[0] >= a.rect.x &&
          p[0] <= a.rect.x + a.rect.w &&
          p[1] >= a.rect.y &&
          p[1] <= a.rect.y + a.rect.h,
      );
    if (selectedTool === "node") {
      const id = crypto.randomUUID();
      s.editScene((v) => ({
        ...v,
        nodes: [
          ...v.nodes,
          {
            id,
            kind: "note",
            title: "新节点",
            rect: { x: p[0], y: p[1], w: 180, h: 80 },
          },
        ],
      }));
      s.selectNode(id);
      s.setTool("select");
      return;
    }
    if (selectedTool === "edge") {
      if (!node) {
        s.setError("依次点击起点和终点节点来连接。");
        return;
      }
      if (!edgeStart) {
        setEdgeStart(node.id);
        s.selectNode(node.id);
        return;
      }
      const startNode = scene.nodes.find((n) => n.id === edgeStart);
      if (edgeStart !== node.id && startNode) {
        const sides = facingAnchors(startNode.rect, node.rect);
        const preset = EDGE_PRESETS.find((p) => p.id === s.edgePreset)?.style;
        const edgeId = crypto.randomUUID();
        s.editScene((v) => ({
          ...v,
          edges: [
            ...v.edges,
            {
              id: edgeId,
              from: { node_id: edgeStart, side: sides.from, offset: 0.5 },
              to: { node_id: node.id, side: sides.to, offset: 0.5 },
              ...(preset ? { style: { ...preset } } : {}),
            },
          ],
        }));
        s.selectNode(`edge:${edgeId}`);
      }
      setEdgeStart(null);
      s.setTool("select");
      return;
    }
    const edge =
      selectedTool === "select" && !asset
        ? hitEdge(scene, [e.clientX, e.clientY], frame)
        : null;
    if (edge) {
      s.selectNode(`edge:${edge}`);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setGestureBounds(bounds);
    if (selectedTool === "pen" || selectedTool === "highlighter") {
      const id = crypto.randomUUID();
      const stroke: Stroke = {
        id,
        tool: selectedTool,
        color:
          selectedTool === "pen"
            ? useBoardStore.getState().penColor
            : "#ffd166",
        width: selectedTool === "pen" ? 3.2 : 18,
        points: [p],
        pressure: [e.pressure || 0.5],
      };
      const shellBox = shellRef.current!.getBoundingClientRect();
      setLiveInk({
        stroke,
        frame,
        origin: { left: shellBox.left, top: shellBox.top },
      });
      gesture.current = {
        pointer: e.pointerId,
        frame,
        mode: "draw",
        stroke,
        id,
        x: p[0],
        y: p[1],
        px: 0,
        py: 0,
      };
    } else if (selectedTool === "eraser") {
      const previous = s.workingScene;
      s.eraseAt(p);
      gesture.current = {
        checkpointed: useBoardStore.getState().workingScene !== previous,
        pointer: e.pointerId,
        frame,
        mode: "erase",
        x: 0,
        y: 0,
        px: 0,
        py: 0,
      };
    } else if (node || asset) {
      const id = node?.id ?? `asset:${asset!.asset_id}`;
      s.selectNode(id);
      gesture.current = {
        pointer: e.pointerId,
        frame,
        mode: "move",
        id,
        x: p[0],
        y: p[1],
        px: 0,
        py: 0,
        scene,
      };
    } else {
      s.selectNode(null);
      gesture.current = {
        pointer: e.pointerId,
        frame,
        mode: "pan",
        x: e.clientX,
        y: e.clientY,
        px: pan.x,
        py: pan.y,
      };
    }
  };
  const onMove = (e: Pointer<HTMLElement>) => {
    const g = gesture.current;
    if (!g) {
      const frame = currentFrame(),
        rect = scene && objectRect(scene, selectedNodeId);
      setHoverCorner(
        !editingLocked &&
          !showDiff &&
          selectedTool === "select" &&
          frame &&
          rect
          ? hitResizeCorner(rect, [e.clientX, e.clientY], frame)
          : null,
      );
      return;
    }
    if (g.pointer !== e.pointerId || editingLocked) return;
    if (g.mode === "draw") {
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [e.nativeEvent]) {
        const p = scenePoint([sample.clientX, sample.clientY], g.frame);
        if (!p) continue;
        (g.stroke!.points as [number, number][]).push(p);
        g.stroke!.pressure!.push(sample.pressure || 0.5);
      }
      inkRef.current?.setAttribute("points", inkPoints(g.stroke!));
      return;
    }
    if (g.mode !== "erase") {
      // Pan, move and resize settle once per frame, however fast the pointer reports.
      g.latest = {
        clientX: e.clientX,
        clientY: e.clientY,
        shiftKey: e.shiftKey,
      };
      if (!moveFrame.current)
        moveFrame.current = requestAnimationFrame(flushMove);
      return;
    }
    const s = useBoardStore.getState();
    const p = point(e);
    if (!p) return;
    const previous = s.workingScene;
    s.eraseAt(p, 16, !g.checkpointed);
    if (useBoardStore.getState().workingScene !== previous)
      g.checkpointed = true;
  };
  function flushMove() {
    moveFrame.current = 0;
    const g = gesture.current,
      e = g?.latest;
    if (!g || !e) return;
    g.latest = undefined;
    const s = useBoardStore.getState();
    if (g.mode === "pan") {
      s.setPan({ x: g.px + e.clientX - g.x, y: g.py + e.clientY - g.y });
      return;
    }
    const p = scenePoint([e.clientX, e.clientY], g.frame);
    if (!p) return;
    const dx = p[0] - g.x,
      dy = p[1] - g.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.2) return;
    const original = objectRect(g.scene!, g.id!);
    if (!original) return;
    const previous = s.workingScene;
    const rect =
      g.mode === "resize"
        ? resizeRect(original, g.corner!, [dx, dy], e.shiftKey)
        : { ...original, x: original.x + dx, y: original.y + dy };
    s.editScene((v) => updateObjectRect(v, g.id!, rect), !g.checkpointed);
    if (useBoardStore.getState().workingScene !== previous)
      g.checkpointed = true;
  }
  const end = (e: Pointer<HTMLElement>) => {
    const g = gesture.current;
    if (g?.pointer !== e.pointerId) return;
    cancelAnimationFrame(moveFrame.current);
    flushMove();
    gesture.current = null;
    if (g.mode === "draw") {
      // The overlay stays until the board image carrying this stroke has loaded.
      useBoardStore.getState().startStroke(g.stroke!);
      setLiveInk((ink) => ink && { ...ink, releasing: true });
    }
    setGestureBounds(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <main
      className={`canvas-shell tool-${selectedTool}`}
      ref={shellRef}
      style={
        hoverCorner
          ? {
              cursor: `${hoverCorner === "nw" || hoverCorner === "se" ? "nwse" : "nesw"}-resize`,
            }
          : undefined
      }
      onDoubleClick={() => {
        if (selectedNodeId?.startsWith("edge:"))
          shellRef.current
            ?.querySelector<HTMLInputElement>(".edge-inspector input")
            ?.focus();
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDragOver={(e) => {
        e.preventDefault();
        if (!editingLocked && !showDiff) {
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)
        )
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (editingLocked || showDiff) return;
        const r = imageRef.current?.getBoundingClientRect();
        if (!r) return;
        const at: [number, number] = [
          bounds.x + ((e.clientX - r.left) / r.width) * bounds.w,
          bounds.y + ((e.clientY - r.top) / r.height) * bounds.h,
        ];
        const files = [...e.dataTransfer.files];
        const link = (
          e.dataTransfer.getData("text/uri-list") ||
          e.dataTransfer.getData("text/plain")
        )
          .split(/\r?\n/)
          .find((v) => /^https?:\/\//i.test(v.trim()))
          ?.trim();
        void (async () => {
          try {
            if (files.length) {
              for (let i = 0; i < files.length; i++)
                await insertBoardAsset({
                  file: files[i],
                  at: [at[0] + i * 36, at[1] + i * 36],
                });
            } else if (link) await insertBoardAsset({ url: link, at });
          } catch (err) {
            useBoardStore
              .getState()
              .setError(err instanceof Error ? err.message : String(err));
          }
        })();
      }}
      aria-label="画布"
    >
      {dragging && (
        <div className="canvas-drop-hint" role="status">
          松开放入图片或网页链接
        </div>
      )}
      {liveInk && (
        <svg
          className="live-ink"
          aria-hidden="true"
          viewBox={`${liveInk.frame.bounds.x} ${liveInk.frame.bounds.y} ${liveInk.frame.bounds.w} ${liveInk.frame.bounds.h}`}
          preserveAspectRatio="none"
          style={{
            left: liveInk.frame.image.left - liveInk.origin.left,
            top: liveInk.frame.image.top - liveInk.origin.top,
            width: liveInk.frame.image.width,
            height: liveInk.frame.image.height,
          }}
        >
          <polyline
            ref={inkRef}
            points={inkPoints(liveInk.stroke)}
            fill="none"
            stroke={liveInk.stroke.color}
            strokeWidth={liveInk.stroke.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={liveInk.stroke.tool === "highlighter" ? 0.35 : undefined}
          />
        </svg>
      )}
      {!showDiff && <DiagramControls />}
      <div className="canvas-atmosphere" />
      <div className="canvas-grid" />
      {browserSource ? (
        <div className="canvas-stage">
          <img
            ref={imageRef}
            src={browserSource}
            onLoad={() => setLiveInk((ink) => (ink?.releasing ? null : ink))}
            className="canvas-image"
            alt={
              showDiff
                ? `Diff ${mode} render`
                : currentLayer?.layer.title || "画布"
            }
            draggable={false}
            style={{
              transform: `translate3d(${pan.x}px,${pan.y}px,0) scale(${zoom})`,
            }}
          />
        </div>
      ) : (
        <div className="canvas-empty">
          <strong>从一个想法开始</strong>
          <span>选择画笔画草图，或放入逻辑节点。</span>
        </div>
      )}
      {scene &&
        !scene.nodes.length &&
        !scene.strokes.length &&
        !scene.assets.length &&
        selectedTool === "select" &&
        !showDiff && (
          <section
            className="canvas-welcome"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <h1>
              把想法
              <span className="ink-underline">
                画出来
                <svg viewBox="0 0 100 12" preserveAspectRatio="none">
                  <path d="M2 8c14-5 30-6 46-3s30 4 50-2" />
                </svg>
              </span>
              。
            </h1>
            <p>
              画一笔，放一张截图，连起两个念头。
              <br />
              每次保存都是新的一层，你和 AI 可以接着推演。
            </p>
            <div>
              <button onClick={() => state.setTool("pen")}>画第一笔</button>
              <button onClick={() => state.setTool("node")}>放一个节点</button>
            </div>
          </section>
        )}
      {editingLocked && (
        <div className="canvas-lock" role="status">
          正在保存或生成，暂时锁定编辑以保护草稿…
        </div>
      )}
      {edgeStart && <div className="diff-chip">已选起点，请点击终点节点</div>}
      {scene &&
        selectedNodeId?.startsWith("edge:") &&
        !showDiff &&
        scene.edges
          .filter((e) => e.id === selectedNodeId.slice(5))
          .map((edge) => (
            <EdgeInspector
              key={edge.id}
              scene={scene}
              edge={edge}
              locked={editingLocked}
              onEdit={state.editScene}
              onDeselect={() => state.selectNode(null)}
            />
          ))}
      {scene &&
        selectedNodeId &&
        !selectedNodeId.startsWith("edge:") &&
        selectedTool === "select" &&
        !showDiff && (
          <ObjectInspector
            scene={scene}
            selectedId={selectedNodeId}
            locked={editingLocked}
            onEdit={state.editScene}
            onDeselect={() => state.selectNode(null)}
            selectionScreenRect={() => {
              const frame = currentFrame(),
                rect = objectRect(scene, selectedNodeId);
              if (!frame || !rect) return null;
              return {
                x:
                  frame.image.left +
                  ((rect.x - frame.bounds.x) / frame.bounds.w) *
                    frame.image.width,
                y:
                  frame.image.top +
                  ((rect.y - frame.bounds.y) / frame.bounds.h) *
                    frame.image.height,
                w: (rect.w / frame.bounds.w) * frame.image.width,
                h: (rect.h / frame.bounds.h) * frame.image.height,
              };
            }}
          />
        )}
      {sheetCorner && !showDiff && (
        <div
          className={`sheet-label ${state.dirty ? "is-dirty" : ""}`}
          style={{
            // Pinned to the sheet, but never slides under the floating chrome.
            left: `max(${sheetCorner.left}px, calc(var(--left-w) + var(--gap) + 8px))`,
            top: `max(${sheetCorner.top}px, calc(var(--chrome-top) + 72px))`,
          }}
          title="画板随内容自动扩展"
        >
          <span>画板</span>
          <b>
            {bounds.w} × {bounds.h}
          </b>
          <i aria-hidden="true" />
          <span>{state.dirty ? "未提交 · 已暂存本机" : "已保存"}</span>
        </div>
      )}
      <div className="zoom-control" onPointerDown={(e) => e.stopPropagation()}>
        <button
          onClick={() =>
            glide(() => useBoardStore.getState().setZoom(zoom - 0.1 / fitScale))
          }
          aria-label="缩小画布"
        >
          −
        </button>
        <span aria-label="画布实际缩放">
          {Math.round(fitScale * zoom * 100)}%
        </span>
        <button
          onClick={() =>
            glide(() => useBoardStore.getState().setZoom(zoom + 0.1 / fitScale))
          }
          aria-label="放大画布"
        >
          +
        </button>
        <button
          onClick={() =>
            glide(() => useBoardStore.getState().setZoom(1 / fitScale))
          }
          aria-label="画布实际大小（100%）"
        >
          1:1
        </button>
        <button
          onClick={() => glide(state.resetViewport)}
          aria-label="重置画布视图"
        >
          适应
        </button>
      </div>
    </main>
  );
}
