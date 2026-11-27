import type { Edge, Scene } from "@humanboard/schema";
import { useTheme } from "../theme";
const colorValue = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
export function EdgeInspector({
  scene,
  edge,
  locked,
  onEdit,
  onDeselect,
}: {
  scene: Scene;
  edge: Edge;
  locked: boolean;
  onEdit: (fn: (s: Scene) => Scene) => void;
  onDeselect: () => void;
}) {
  return (
    <section
      className="object-inspector edge-inspector"
      aria-label="编辑选中连线"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="object-inspector-heading">
        <span>连线</span>
        <button aria-label="取消选择" onClick={onDeselect}>
          ×
        </button>
      </div>
      <EdgeProperties
        scene={scene}
        edge={edge}
        locked={locked}
        onEdit={onEdit}
        onDeselect={onDeselect}
      />
    </section>
  );
}

export function EdgeProperties({
  scene,
  edge,
  locked,
  onEdit,
  onDeselect,
}: {
  scene: Scene;
  edge: Edge;
  locked: boolean;
  onEdit: (fn: (s: Scene) => Scene) => void;
  onDeselect: () => void;
}) {
  const dark = useTheme() === "dark";
  const editEdge = (edge: Edge, update: Partial<Edge>) =>
    onEdit((s) => ({
      ...s,
      edges: s.edges.map((e) => (e.id === edge.id ? { ...e, ...update } : e)),
    }));
  if (scene.diagram?.mode === "mindmap" && edge.id.startsWith("tree:"))
    return (
      <fieldset disabled={locked}>
        <input
          aria-label="分支标签"
          placeholder="分支说明"
          value={edge.label ?? ""}
          onChange={(e) => editEdge(edge, { label: e.target.value })}
        />
        <small>
          父子关系由树结构管理。拖动子节点可调整顺序或父节点；额外关系请另加连线。
        </small>
      </fieldset>
    );
  return (
    <fieldset disabled={locked}>
      <input
        aria-label={`连线 ${1} 标签`}
        placeholder="连线标签"
        value={edge.label ?? ""}
        onChange={(e) => editEdge(edge, { label: e.target.value })}
      />
      <div className="object-style-row">
        <label>
          箭头
          <select
            aria-label={`连线 ${1} 箭头`}
            value={edge.style?.arrow ?? "end"}
            onChange={(e) =>
              editEdge(edge, {
                style: {
                  ...edge.style,
                  arrow: e.target.value as "end" | "none" | "both",
                },
              })
            }
          >
            <option value="end">单向</option>
            <option value="both">双向</option>
            <option value="none">无箭头</option>
          </select>
        </label>
        <label>
          颜色
          <input
            type="color"
            aria-label={`连线 ${1} 颜色`}
            value={colorValue(edge.style?.color, dark ? "#7c8696" : "#5b6475")}
            onChange={(e) =>
              editEdge(edge, {
                style: { ...edge.style, color: e.target.value },
              })
            }
          />
        </label>
        <label className="inspector-checkbox">
          <input
            type="checkbox"
            aria-label={`连线 ${1} 虚线`}
            checked={edge.style?.dashed ?? false}
            onChange={(e) =>
              editEdge(edge, {
                style: {
                  ...edge.style,
                  dashed: e.target.checked,
                },
              })
            }
          />
          虚线
        </label>
        <label className="inspector-checkbox">
          <input
            type="checkbox"
            aria-label={`连线 ${1} 曲线`}
            checked={edge.style?.curve ?? false}
            onChange={(e) =>
              editEdge(edge, {
                style: {
                  ...edge.style,
                  curve: e.target.checked,
                },
              })
            }
          />
          曲线
        </label>
      </div>
      <details>
        <summary>连接位置</summary>
        {(["from", "to"] as const).map((end) => (
          <div key={end} className="edge-anchor-row">
            <span>{end === "from" ? "起点" : "终点"}</span>
            <select
              aria-label={`连线 ${1} ${end === "from" ? "起点" : "终点"}侧边`}
              value={edge[end].side}
              onChange={(e) =>
                editEdge(edge, {
                  [end]: { ...edge[end], side: e.target.value },
                })
              }
            >
              {(["top", "right", "bottom", "left"] as const).map((side, i) => (
                <option key={side} value={side}>
                  {["上", "右", "下", "左"][i]}
                </option>
              ))}
            </select>
            <input
              aria-label={`连线 ${1} ${end === "from" ? "起点" : "终点"}位置`}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={edge[end].offset}
              onChange={(e) =>
                editEdge(edge, {
                  [end]: {
                    ...edge[end],
                    offset: Number(e.target.value),
                  },
                })
              }
            />
          </div>
        ))}
      </details>
      <button
        className="danger-button"
        onClick={() => {
          onEdit((v) => ({
            ...v,
            edges: v.edges.filter((e) => e.id !== edge.id),
          }));
          onDeselect();
        }}
      >
        删除这条连线
      </button>
    </fieldset>
  );
}
