import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Scene } from "@humanboard/schema/scene";
import {
  edgeGeometry,
  edgePathPoints,
  edgeLabelPoint,
} from "../../../core-engine/src/render/edge-routing";
import type { Review } from "../../../core-engine/src/revisions/service";
import { extent, fit, zoomAt, type Camera } from "./camera";
export type Selection = { kind: "node" | "edge"; id: string } | null;
interface Props {
  scene: Scene;
  review?: Review | null;
  selected: Selection;
  onSelect: (v: Selection) => void;
  onMove: (id: string, x: number, y: number) => void;
  fitKey: number;
  connecting: boolean;
  locked: boolean;
}
const kindName: Record<string, string> = {
  state: "状态",
  job: "任务",
  service: "服务",
  database: "数据",
  gateway: "判断",
  note: "便签",
  group: "分组",
};
export function GraphCanvas({
  scene: editableScene,
  review,
  selected,
  onSelect,
  onMove,
  fitKey,
  connecting,
  locked,
}: Props) {
  const overlay = useMemo(() => {
    if (!review) return null;
    const kinds = new Map<string, string>(),
      nodes = [...review.preview.nodes],
      edges = [...review.preview.edges];
    for (const c of review.changes) {
      if (c.entity === "节点") {
        kinds.set("node:" + c.id, c.kind);
        if (c.kind === "removed" && c.before) nodes.push(c.before);
      } else if (c.entity === "连线") {
        kinds.set("edge:" + c.id, c.kind);
        if (c.kind === "removed" && c.before) edges.push(c.before);
      }
    }
    return { scene: { ...review.preview, nodes, edges }, kinds };
  }, [review]);
  const scene = overlay?.scene ?? editableScene;
  const shell = useRef<HTMLDivElement>(null),
    minimap = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 }),
    [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [moved, setMoved] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const drag = useRef<{
    pointer: number;
    id?: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
    scale: number;
  } | null>(null);
  const bounds = useMemo(() => extent(scene), [scene]),
    latestBounds = useRef(bounds);
  latestBounds.current = bounds;
  useLayoutEffect(() => {
    const el = shell.current!;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    setCam(fit(latestBounds.current, size.w, size.h));
  }, [size, fitKey, review]);
  useEffect(() => {
    const el = shell.current!;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest("button,select,.studio-mini")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(),
        units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1;
      setCam((c) =>
        e.ctrlKey || e.metaKey
          ? zoomAt(
              c,
              { x: e.clientX - r.left, y: e.clientY - r.top },
              Math.exp(-e.deltaY * units * 0.008),
            )
          : { ...c, x: c.x - e.deltaX * units, y: c.y - e.deltaY * units },
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [size.h]);
  const nodes = useMemo(
    () =>
      scene.nodes.map((n) =>
        n.id === moved?.id
          ? { ...n, rect: { ...n.rect, x: moved.x, y: moved.y } }
          : n,
      ),
    [scene.nodes, moved],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const visible = {
    x: -cam.x / cam.k,
    y: -cam.y / cam.k,
    w: size.w / cam.k,
    h: size.h / cam.k,
  };
  const center = (factor: number) =>
    setCam((c) => zoomAt(c, { x: size.w / 2, y: size.h / 2 }, factor));
  function jump(clientX: number, clientY: number) {
    const matrix = minimap.current?.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(clientX, clientY).matrixTransform(
      matrix.inverse(),
    );
    setCam((c) => ({
      ...c,
      x: size.w / 2 - point.x * c.k,
      y: size.h / 2 - point.y * c.k,
    }));
  }
  return (
    <div
      className="studio-canvas"
      ref={shell}
      style={{
        backgroundPosition: cam.x + "px " + cam.y + "px",
        backgroundSize:
          Math.max(10, 24 * cam.k) + "px " + Math.max(10, 24 * cam.k) + "px",
      }}
    >
      <svg
        className="studio-world"
        aria-label="图画布"
        onPointerDown={(e) => {
          if (drag.current || e.button > 1) return;
          const node = (e.target as Element)
            .closest("[data-node]")
            ?.getAttribute("data-node");
          const edge = (e.target as Element)
            .closest("[data-edge]")
            ?.getAttribute("data-edge");
          if (e.button === 0 && (node || edge)) {
            onSelect(
              node ? { kind: "node", id: node } : { kind: "edge", id: edge! },
            );
            if (!node || connecting || locked) return;
          } else if (e.button === 0) onSelect(null);
          const n = e.button === 0 && node ? byId.get(node) : undefined;
          drag.current = {
            id: n?.id,
            pointer: e.pointerId,
            x: n?.rect.x ?? cam.x,
            y: n?.rect.y ?? cam.y,
            startX: e.clientX,
            startY: e.clientY,
            scale: cam.k,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.pointer !== e.pointerId) return;
          const dx = e.clientX - d.startX,
            dy = e.clientY - d.startY;
          if (d.id)
            setMoved({
              id: d.id,
              x: Math.round(d.x + dx / d.scale),
              y: Math.round(d.y + dy / d.scale),
            });
          else setCam((c) => ({ ...c, x: d.x + dx, y: d.y + dy }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d || d.pointer !== e.pointerId) return;
          if (d.id && (e.clientX !== d.startX || e.clientY !== d.startY))
            onMove(
              d.id,
              Math.round(d.x + (e.clientX - d.startX) / d.scale),
              Math.round(d.y + (e.clientY - d.startY) / d.scale),
            );
          drag.current = null;
          setMoved(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setMoved(null);
        }}
      >
        <defs>
          <marker
            id="studio-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto-start-reverse"
          >
            <path d="M1 1 L7 4 L1 7" fill="none" stroke="context-stroke" />
          </marker>
        </defs>
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
          {scene.assets.map((a) => (
            <g key={a.asset_id}>
              <rect
                {...{
                  x: a.rect.x,
                  y: a.rect.y,
                  width: a.rect.w,
                  height: a.rect.h,
                }}
                className="studio-asset"
                rx="8"
              />
              <text x={a.rect.x + 10} y={a.rect.y + 22}>
                素材 #{a.display_no}
              </text>
            </g>
          ))}
          {scene.edges.map((e) => {
            const a = byId.get(e.from.node_id),
              b = byId.get(e.to.node_id);
            if (!a || !b) return null;
            const geometry = edgeGeometry(e, a.rect, b.rect),
              points = edgePathPoints(geometry)
                .map((p) => p.x + "," + p.y)
                .join(" "),
              p = edgeLabelPoint(geometry);
            return (
              <g
                key={e.id}
                data-edge={e.id}
                data-kind={overlay?.kinds.get("edge:" + e.id)}
                className={selected?.id === e.id ? "is-selected" : ""}
                role="button"
                tabIndex={0}
                aria-label={"连线 " + (e.label || a.title + " → " + b.title)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") onSelect({ kind: "edge", id: e.id });
                }}
              >
                <polyline
                  points={points}
                  stroke="transparent"
                  strokeWidth="18"
                  fill="none"
                />
                <polyline
                  className="studio-line"
                  points={points}
                  fill="none"
                  strokeDasharray={e.style?.dashed ? "7 5" : undefined}
                  markerEnd={
                    e.style?.arrow !== "none" ? "url(#studio-arrow)" : undefined
                  }
                  markerStart={
                    e.style?.arrow === "both" ? "url(#studio-arrow)" : undefined
                  }
                />
                {e.label && (
                  <text
                    className="edge-label"
                    x={p.x}
                    y={p.y - 7}
                    textAnchor="middle"
                  >
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => (
            <g
              key={n.id}
              data-node={n.id}
              data-kind={overlay?.kinds.get("node:" + n.id)}
              role="button"
              aria-label={"节点 " + n.title}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect({ kind: "node", id: n.id });
              }}
              className={selected?.id === n.id ? "is-selected" : ""}
              transform={`translate(${n.rect.x} ${n.rect.y})`}
            >
              <rect
                width={n.rect.w}
                height={n.rect.h}
                rx="12"
                className="studio-card-bg"
              />
              <foreignObject width={n.rect.w} height={n.rect.h}>
                <div
                  className="studio-card"
                  data-tone={String(n.style?.color ?? "blue")}
                >
                  <small>
                    <i />
                    {kindName[n.kind] ?? n.kind}
                  </small>
                  <strong>{n.title}</strong>
                  {n.sub && <span>{n.sub}</span>}
                </div>
              </foreignObject>
            </g>
          ))}
          {scene.strokes.map((s) => (
            <polyline
              key={s.id}
              points={s.points.map((p) => p.join(",")).join(" ")}
              stroke={s.color}
              strokeWidth={s.width}
              opacity={s.tool === "highlighter" ? 0.4 : 1}
              fill="none"
              pointerEvents="none"
            />
          ))}
        </g>
      </svg>
      <div className="studio-navigation">
        <div className="studio-mini">
          <svg
            ref={minimap}
            viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
            aria-label="小地图，点击定位"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              jump(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) jump(e.clientX, e.clientY);
            }}
          >
            {nodes.map((n) => (
              <rect
                key={n.id}
                x={n.rect.x}
                y={n.rect.y}
                width={n.rect.w}
                height={n.rect.h}
                rx="8"
              />
            ))}
            <rect
              className="mini-view"
              x={visible.x}
              y={visible.y}
              width={visible.w}
              height={visible.h}
            />
          </svg>
        </div>
        <div className="studio-zoom">
          <button aria-label="缩小" onClick={() => center(1 / 1.25)}>
            −
          </button>
          <output>{Math.round(cam.k * 100)}%</output>
          <button aria-label="放大" onClick={() => center(1.25)}>
            ＋
          </button>
          <button onClick={() => setCam(fit(bounds, size.w, size.h))}>
            适应
          </button>
        </div>
      </div>
    </div>
  );
}
