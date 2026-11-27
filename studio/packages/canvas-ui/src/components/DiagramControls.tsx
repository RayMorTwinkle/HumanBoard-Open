import { useState } from "react";
import { compileDiagram, DiagramSchema } from "@humanboard/schema/scene";
import { useBoardStore } from "../store/useBoardStore";
export function DiagramControls() {
  const scene = useBoardStore((s) => s.workingScene),
    locked = useBoardStore((s) => s.editingLocked),
    edit = useBoardStore((s) => s.editScene);
  const [confirm, setConfirm] = useState(false);
  const [layoutRequest, setLayoutRequest] = useState<{
    layout: "right" | "down" | "bilateral" | null;
  } | null>(null);
  if (!scene) return null;
  const d = scene.diagram,
    empty = !scene.nodes.length;
  const applyLayout = (layout: "right" | "down" | "bilateral" | null) => {
    edit((s) => ({
      ...s,
      diagram: {
        ...s.diagram!,
        ...(layout ? { layout } : {}),
        layout_revision: (s.diagram!.layout_revision ?? 0) + 1,
      },
    }));
    setLayoutRequest(null);
  };
  const requestLayout = (layout: "right" | "down" | "bilateral" | null) => {
    if (scene.strokes.length) setLayoutRequest({ layout });
    else applyLayout(layout);
  };
  const start = (mode: "mindmap" | "logic") =>
    edit((s) => {
      const diagram = DiagramSchema.parse({
        mode,
        nodes: [
          {
            id: crypto.randomUUID(),
            title: mode === "mindmap" ? "中心主题" : "开始",
          },
        ],
      });
      return {
        ...s,
        ...compileDiagram(diagram),
        strokes: s.strokes,
        assets: s.assets,
        diagram,
      };
    });
  return (
    <div
      className="diagram-controls"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {empty && !d ? (
        <>
          <span>选择主图模式</span>
          <button disabled={locked} onClick={() => start("mindmap")}>
            思维导图
          </button>
          <button disabled={locked} onClick={() => start("logic")}>
            流程与关系图
          </button>
          <button
            disabled={locked}
            onClick={() => useBoardStore.getState().setTool("node")}
          >
            自由画板
          </button>
        </>
      ) : (
        <>
          <span>
            {d
              ? d.mode === "mindmap"
                ? "思维导图"
                : "流程与关系图"
              : "自由画板"}
          </span>
          {d && (
            <>
              <select
                aria-label="主图布局"
                disabled={locked}
                value={d.layout}
                onChange={(e) =>
                  requestLayout(e.target.value as typeof d.layout)
                }
              >
                <option value="right">向右展开</option>
                <option value="down">向下展开</option>
                {d.mode === "mindmap" && (
                  <option value="bilateral">左右展开</option>
                )}
              </select>
              <button
                disabled={locked}
                onClick={() => requestLayout(null)}
                title="按当前内容重新安排全部节点；普通编辑保留原位置"
              >
                重新排版
              </button>
              <button
                disabled={locked}
                onClick={() => {
                  const id = crypto.randomUUID();
                  edit((s) => ({
                    ...s,
                    diagram: {
                      ...s.diagram!,
                      nodes: [
                        ...s.diagram!.nodes,
                        {
                          id,
                          title: "新节点",
                          role: "step",
                          ...(d.mode === "mindmap" && d.nodes.length
                            ? {
                                parent:
                                  d.nodes.find(
                                    (n) =>
                                      n.id ===
                                      useBoardStore.getState().selectedNodeId,
                                  )?.id ?? d.nodes.find((n) => !n.parent)!.id,
                              }
                            : {}),
                        },
                      ],
                    },
                  }));
                  useBoardStore.getState().selectNode(id);
                }}
              >
                添加节点
              </button>
              {d.mode === "mindmap" && (
                <button
                  disabled={locked}
                  onClick={() =>
                    edit((s) => ({
                      ...s,
                      diagram: DiagramSchema.parse(
                        JSON.parse(
                          JSON.stringify({
                            ...s.diagram!,
                            mode: "logic",
                            layout:
                              d.layout === "bilateral" ? "right" : d.layout,
                            nodes: d.nodes.map(({ parent, ...n }) => n),
                            edges: s.edges.map((e) => ({
                              id: e.id,
                              from: e.from.node_id,
                              to: e.to.node_id,
                              label: e.label,
                              dashed: e.style?.dashed,
                            })),
                          }),
                        ),
                      ),
                    }))
                  }
                >
                  转为关系图
                </button>
              )}
              <button disabled={locked} onClick={() => setConfirm(true)}>
                转为自由布局
              </button>
            </>
          )}
        </>
      )}
      {confirm && (
        <div role="alert">
          <span>将保留当前位置，停止自动排版。可撤销或返回历史版本。</span>
          <button
            disabled={locked}
            onClick={() => {
              edit((s) => {
                const { diagram, ...rest } = s;
                return rest;
              });
              setConfirm(false);
            }}
          >
            确认转换
          </button>
          <button onClick={() => setConfirm(false)}>取消</button>
        </div>
      )}
      {layoutRequest && (
        <div role="alert">
          <span>
            重新排版会移动节点，现有手绘笔迹保留原坐标。可撤销或返回历史版本。
          </span>
          <button
            disabled={locked}
            onClick={() => applyLayout(layoutRequest.layout)}
          >
            仍然重新排版
          </button>
          <button onClick={() => setLayoutRequest(null)}>保持现状</button>
        </div>
      )}
    </div>
  );
}
