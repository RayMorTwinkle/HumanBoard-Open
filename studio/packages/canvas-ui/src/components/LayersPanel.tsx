import { buildLayerTimeline } from "../layer-timeline";
import { LayerTimelineGraph } from "./LayerTimelineGraph";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GetData, LayerSummary } from "../client/types";
import { DiffIcon, TrashIcon } from "./icons";

interface LayersPanelProps {
  readonly editingLocked?: boolean;
  readonly spaceName?: string;
  readonly layers: readonly LayerSummary[];
  readonly activeLayerId: string | null;
  readonly currentLayer?: GetData | null;
  readonly diffPending?: boolean;
  readonly truncated?: boolean;
  readonly onSelect: (layerId: string) => void;
  readonly onDiff: (layerId: string, visual?: boolean) => void;
  /** Humans may prune history; a layer goes together with everything built on it. */
  readonly onDelete?: (layerId: string) => void;
  readonly onCollapse?: () => void;
  readonly onPreview?: (id: string) => void;
  readonly previews?: Readonly<Record<string, string>>;
  /** Layers saved elsewhere since the human last looked; they pulse until viewed. */
  readonly freshLayerIds?: ReadonlySet<string>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sourceLabel(kind: string): string {
  if (kind === "human") {
    return "人类编辑";
  }
  if (kind === "cli") {
    return "CLI Agent";
  }
  if (kind === "builtin") {
    return "内置 AI";
  }
  return kind;
}

export function LayersPanel({
  editingLocked = false,
  spaceName = "main",
  layers,
  activeLayerId,
  currentLayer = null,
  diffPending = false,
  truncated = false,
  onSelect,
  onDiff,
  onDelete,
  onCollapse,
  onPreview,
  previews = {},
  freshLayerIds,
}: LayersPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPreview = () => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
  };
  useEffect(() => cancelPreview, []);
  const contentRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => buildLayerTimeline(layers), [layers]);
  const ordered = useMemo(() => {
    const byId = new Map(layers.map((l) => [l.id, l]));
    return layout.nodes.map((n) => byId.get(n.id)!);
  }, [layers, layout]);
  const [geometry, setGeometry] = useState<{
    centers: number[];
    height: number;
  }>({ centers: [], height: 0 });
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = () => {
      const area = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>(".layer-row")];
      const centers = rows.map((row) => {
        const r = row.getBoundingClientRect();
        return r.top - area.top + r.height / 2;
      });
      const height = element.offsetHeight;
      setGeometry((old) =>
        old.height === height &&
        old.centers.length === centers.length &&
        old.centers.every((v, i) => v === centers[i])
          ? old
          : { centers, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);
  const [hovered, setHovered] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(".is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeLayerId]);
  const activeLayer =
    layers.find((layer) => layer.id === activeLayerId) ?? null;
  const [deleting, setDeleting] = useState<LayerSummary | null>(null);
  const deletingBranch = useMemo(() => {
    if (!deleting) return [];
    const branch = new Set([deleting.id]);
    for (const layer of [...layers].sort((a, b) => a.seq - b.seq))
      if (layer.parent_id && branch.has(layer.parent_id)) branch.add(layer.id);
    return layers.filter((layer) => branch.has(layer.id));
  }, [deleting, layers]);
  return (
    <aside className="panel layers-panel">
      <div className="panel-heading">
        <div>
          <div className="panel-kicker">Timeline</div>
          <h2>Layers</h2>
        </div>
        <div className="panel-heading-actions">
          <span className="panel-count">{layers.length}</span>
          {onCollapse ? (
            <button
              type="button"
              className="panel-collapse"
              onClick={onCollapse}
              aria-label="收起 Layers 面板"
              title="收起 Layers"
            >
              ‹
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel-subline" title="实线：父子关系 · 虚线：重做">
        <span className="branch-dot" />
        <span>{spaceName}</span>
      </div>

      <div className="layer-list" ref={listRef}>
        {layers.length === 0 ? (
          <div className="panel-empty">
            <span className="empty-mark">L0</span>
            <strong>暂无 Layers</strong>
            <span>
              先在终端执行 human init，或让 Agent 提交第一条视觉方案。
            </span>
          </div>
        ) : (
          <div
            ref={contentRef}
            className="layer-timeline-content"
            style={{ minWidth: layout.width + 190 }}
          >
            <LayerTimelineGraph
              layout={layout}
              centers={geometry.centers}
              height={geometry.height || ordered.length * 78}
              activeLayerId={activeLayerId}
            />
            {ordered.map((layer) => {
              const active = layer.id === activeLayerId;
              const node = layout.byId.get(layer.id)!;
              const parent = layer.parent_id
                ? layout.byId.get(layer.parent_id)
                : undefined;
              const branch = parent !== undefined && parent.lane !== node.lane;
              const redo = layer.kind === "redo";
              return (
                <div
                  className={[
                    "layer-row",
                    active ? "is-active" : "",
                    branch ? "is-branch" : "",
                    redo ? "is-redo" : "",
                    freshLayerIds?.has(layer.id) ? "is-fresh" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={(e) => {
                    cancelPreview();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHovered({
                      id: layer.id,
                      top: Math.max(
                        8,
                        Math.min(rect.top, window.innerHeight - 170),
                      ),
                      left: Math.max(8, rect.left - 222),
                    });
                    previewTimer.current = setTimeout(
                      () => onPreview?.(layer.id),
                      220,
                    );
                  }}
                  onMouseLeave={() => {
                    cancelPreview();
                    setHovered(null);
                  }}
                  onFocus={() => onPreview?.(layer.id)}
                  key={layer.id}
                >
                  <button
                    type="button"
                    className="layer-main"
                    disabled={editingLocked}
                    onClick={() => onSelect(layer.id)}
                  >
                    <span
                      className="layer-rail"
                      style={{ width: layout.width }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="layer-title-line">
                        <span className="layer-id">{layer.short_id}</span>
                        <span className="layer-title">
                          {layer.title || "未命名层"}
                        </span>
                        {active ? (
                          <span className="live-tag">正在看</span>
                        ) : freshLayerIds?.has(layer.id) ? (
                          <span className="fresh-tag">新</span>
                        ) : null}
                      </span>
                      <span className="layer-meta">
                        <span className={`source-${layer.author.kind}`}>
                          {sourceLabel(layer.author.kind)}
                        </span>
                        <span>{redo ? "redo" : layer.kind}</span>
                        <span>{formatTime(layer.created_at)}</span>
                        {layer.parent_id ? (
                          <span className="font-mono">
                            ←{" "}
                            {layers.find((item) => item.id === layer.parent_id)
                              ?.short_id ?? "父层未加载"}
                          </span>
                        ) : null}
                        {layer.redo_of ? (
                          <span className="redo-relation font-mono">
                            重做{" "}
                            {layers.find((item) => item.id === layer.redo_of)
                              ?.short_id ?? "layer"}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="layer-diff-button"
                    data-diff-trigger
                    disabled={!layer.parent_id}
                    onClick={() => onDiff(layer.id)}
                    aria-label={`查看 ${layer.short_id} 的 Diff`}
                    title="Diff"
                  >
                    <DiffIcon />
                  </button>
                  {onDelete && layer.parent_id ? (
                    <button
                      type="button"
                      className="layer-delete-button"
                      disabled={editingLocked}
                      onClick={() => setDeleting(layer)}
                      aria-label={`删除 ${layer.short_id}`}
                      title="删除这一层"
                    >
                      <TrashIcon />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {truncated ? (
        <div className="panel-note">
          当前列表来自截断后的 status；打开 Layers 全量数据由后端继续提供。
        </div>
      ) : null}

      {activeLayer ? (
        <section className="layer-inspector">
          <span className="layer-inspector-meta">
            <span>
              <b>{activeLayer.short_id}</b>
              {" ← "}
              {activeLayer.parent_id
                ? (layers.find((item) => item.id === activeLayer.parent_id)
                    ?.short_id ?? "—")
                : "根层"}
            </span>
            {currentLayer?.render?.bounds ? (
              <span title="画板尺寸">
                {currentLayer.render.bounds.w} × {currentLayer.render.bounds.h}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="layer-diff-launch"
            data-diff-trigger
            disabled={!activeLayer.parent_id || diffPending}
            onClick={() => onDiff(activeLayer.id)}
          >
            <DiffIcon />
            {diffPending ? "正在比较…" : "比较父层变化"}
          </button>
        </section>
      ) : null}
      {deleting &&
        onDelete &&
        createPortal(
          <div
            className="modal-backdrop"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setDeleting(null);
            }}
          >
            <div
              className="dialog-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-layer-title"
              onKeyDown={(e) => {
                if (e.key === "Escape") setDeleting(null);
              }}
            >
              <h2 id="delete-layer-title">
                删除 {deleting.short_id}
                {deletingBranch.length > 1
                  ? ` 及之后的 ${deletingBranch.length - 1} 层`
                  : ""}
                ？
              </h2>
              <p>
                {deletingBranch.length > 1
                  ? `基于它的层也会一起移除：${deletingBranch
                      .slice(1)
                      .map((l) => l.short_id)
                      .join("、")}。`
                  : "这一层会从历史中移除。"}
                其他层不受影响，删除会同步到你的其他设备。
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setDeleting(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => {
                    onDelete(deleting.id);
                    setDeleting(null);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {hovered &&
        previews[hovered.id] &&
        createPortal(
          <div
            className="layer-preview-popover"
            style={{ top: hovered.top, left: hovered.left }}
          >
            <img src={previews[hovered.id]} alt="历史层预览" />
            <span>
              {layers.find((l) => l.id === hovered.id)?.short_id} ·
              点击切换，Alt 对比
            </span>
          </div>,
          document.body,
        )}
    </aside>
  );
}
