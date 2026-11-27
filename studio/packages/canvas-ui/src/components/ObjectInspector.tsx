import { EdgeProperties } from "./EdgeInspector";
import { useLayoutEffect, useRef, useState } from "react";
import { placeInspector } from "../inspector-placement";
import { useTheme } from "../theme";
import { nodeAccentColor } from "@humanboard/core-engine/scene-svg";
import type { Node, Scene } from "@humanboard/schema";
import { NODE_COLORS, NODE_KINDS } from "@humanboard/schema/scene";
import { objectRect, removeObject, updateObjectRect } from "../canvas-geometry";
const KIND_LABELS = [
  "状态",
  "任务",
  "队列",
  "服务",
  "网关",
  "数据库",
  "外部系统",
  "Saga",
  "分组",
  "便签",
  "未分类",
];
interface Props {
  scene: Scene;
  selectedId: string;
  locked: boolean;
  onEdit: (fn: (scene: Scene) => Scene) => void;
  onDeselect: () => void;
  selectionScreenRect?: () => {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null;
}
const colorValue = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
export function ObjectInspector({
  scene,
  selectedId,
  locked,
  onEdit,
  onDeselect,
  selectionScreenRect,
}: Props) {
  const inspectorRef = useRef<HTMLElement>(null);
  const dark = useTheme() === "dark";
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = inspectorRef.current,
      stage = element?.closest(".canvas-shell")?.querySelector(".canvas-stage");
    if (!element || !stage || !selectionScreenRect) return;
    const update = () => {
      const selected = selectionScreenRect();
      if (!selected) return;
      const area = stage.getBoundingClientRect(),
        panel = element.getBoundingClientRect();
      const next = placeInspector(
        selected,
        { x: area.x, y: area.y, w: area.width, h: area.height },
        { w: panel.width, h: panel.height },
      );
      setPosition((old) =>
        old?.x === next.x && old?.y === next.y ? old : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(stage);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [selectionScreenRect, collapsed]);
  const node = scene.nodes.find((n) => n.id === selectedId);
  const rect = objectRect(scene, selectedId);
  if (!rect) return null;
  const editNode = (update: Partial<Node>) =>
    onEdit((v) => ({
      ...v,
      nodes: v.nodes.map((n) =>
        n.id === selectedId ? { ...n, ...update } : n,
      ),
    }));
  const setColor = (color: string | undefined) => {
    const {
      accent,
      fill,
      borderColor,
      color: oldColor,
      ...style
    } = node?.style ?? {};
    editNode({ style: { ...style, ...(color ? { color } : {}) } });
  };
  return (
    <section
      className={`object-inspector ${collapsed ? "is-collapsed" : ""}`}
      ref={inspectorRef}
      style={
        position
          ? {
              position: "fixed",
              left: position.x,
              top: position.y,
              bottom: "auto",
            }
          : undefined
      }
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="编辑选中对象"
    >
      <div className="object-inspector-heading">
        <div className="panel-kicker">{node ? "逻辑节点" : "资产位置"}</div>
        <div className="object-inspector-actions">
          <button
            aria-label={collapsed ? "展开对象属性" : "折叠对象属性"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? "⌃" : "⌄"}
          </button>
          <button aria-label="取消选择" onClick={onDeselect}>
            ×
          </button>
        </div>
      </div>
      {!collapsed && (
        <fieldset disabled={locked}>
          {node && (
            <>
              <input
                aria-label="节点标题"
                value={node.title}
                placeholder="节点标题"
                onChange={(e) => editNode({ title: e.target.value })}
              />
              <div className="object-style-row">
                <label>
                  类型
                  <select
                    disabled={!!scene.diagram}
                    aria-label="节点类型"
                    value={node.kind}
                    onChange={(e) =>
                      editNode({ kind: e.target.value as Node["kind"] })
                    }
                  >
                    {NODE_KINDS.map((kind, i) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[i]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  颜色
                  <input
                    type="color"
                    aria-label="节点颜色"
                    value={colorValue(nodeAccentColor(node, dark), "#5278c5")}
                    onChange={(e) => setColor(e.target.value)}
                  />
                </label>
                <button
                  onClick={() => setColor(undefined)}
                  aria-label="恢复节点默认颜色"
                >
                  默认
                </button>
              </div>
              <div className="object-style-row">
                <label>
                  外形
                  <select
                    aria-label="节点外形"
                    value={
                      typeof node.style?.shape === "string"
                        ? node.style.shape
                        : "rounded"
                    }
                    onChange={(e) =>
                      editNode({
                        style: { ...node.style, shape: e.target.value },
                      })
                    }
                  >
                    <option value="rounded">圆角矩形</option>
                    <option value="rectangle">矩形</option>
                    <option value="ellipse">椭圆</option>
                    <option value="diamond">菱形</option>
                  </select>
                </label>
                <label>
                  边框
                  <select
                    aria-label="节点边框线型"
                    value={node.style?.dashed ? "dashed" : "solid"}
                    onChange={(e) =>
                      editNode({
                        style: {
                          ...node.style,
                          dashed: e.target.value === "dashed",
                        },
                      })
                    }
                  >
                    <option value="solid">实线</option>
                    <option value="dashed">虚线</option>
                  </select>
                </label>
              </div>
              <div className="node-palette" aria-label="节点色板">
                {Object.entries(NODE_COLORS).map(([name, color]) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={`节点颜色 ${name}`}
                    title={name}
                    style={{ background: color }}
                    onClick={() => setColor(name)}
                  />
                ))}
              </div>
              <textarea
                aria-label="节点说明"
                placeholder="补充说明（可选）"
                value={node.sub ?? ""}
                onChange={(e) => editNode({ sub: e.target.value })}
              />
            </>
          )}
          <details>
            <summary>位置与尺寸{scene.diagram ? "（自动排版）" : ""}</summary>
            <div className="rect-fields">
              {(["x", "y", "w", "h"] as const).map((key) => (
                <label key={key}>
                  {key}
                  <input
                    disabled={!!scene.diagram}
                    type="number"
                    step="1"
                    min={key === "w" || key === "h" ? 16 : undefined}
                    aria-label={`对象 ${key}`}
                    value={Math.round(rect[key] * 100) / 100}
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      onEdit((v) =>
                        updateObjectRect(v, selectedId, {
                          ...objectRect(v, selectedId)!,
                          [key]: Number(e.target.value),
                        }),
                      );
                    }}
                  />
                </label>
              ))}
            </div>
            <small className="inspector-hint">
              拖动四角缩放 · Shift 保持比例
            </small>
          </details>
          {node && (
            <div className="edge-editor">
              <small className="inspector-hint">
                展开连线可编辑线型、颜色和单向／双向／无向
              </small>
              {scene.edges
                .filter(
                  (e) => e.from.node_id === node.id || e.to.node_id === node.id,
                )
                .map((edge, index) => (
                  <details key={edge.id} className="edge-properties">
                    <summary>
                      连线 {index + 1} ·{" "}
                      {scene.nodes.find((n) => n.id === edge.from.node_id)
                        ?.title || "起点"}{" "}
                      →{" "}
                      {scene.nodes.find((n) => n.id === edge.to.node_id)
                        ?.title || "终点"}
                    </summary>
                    <EdgeProperties
                      scene={scene}
                      edge={edge}
                      locked={locked}
                      onEdit={onEdit}
                      onDeselect={onDeselect}
                    />
                  </details>
                ))}
            </div>
          )}
          <button
            className="danger-button"
            onClick={() => {
              onEdit((v) => removeObject(v, selectedId));
              onDeselect();
            }}
          >
            删除选中对象
          </button>
        </fieldset>
      )}
    </section>
  );
}
