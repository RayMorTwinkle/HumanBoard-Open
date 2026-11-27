import { useEffect, useRef, useState } from "react";
import {
  layoutScene,
  NODE_KINDS,
  type LayoutPreset,
  type Scene,
  facingAnchors,
} from "@humanboard/schema/scene";
import { GraphCanvas, type Selection } from "./GraphCanvas";
import { ReviewDrawer } from "./ReviewDrawer";
import { useStudio, type Run } from "./useStudio";
import { structuredEdit } from "../structured-edit";
import { applyTheme, useTheme } from "../theme";
import {
  BrandMark,
  ToolIcon,
  DiffIcon,
  MoonIcon,
  SunIcon,
  UndoIcon,
} from "../components/icons";
import "./studio.css";
export function Studio({
  run,
  scope = "local",
  back,
}: {
  run: Run;
  scope?: string;
  back?: string;
}) {
  const s = useStudio(run, scope),
    scene = s.scene,
    state = s.state;
  const [selected, select] = useState<Selection>(null),
    [connect, setConnect] = useState(false),
    [first, setFirst] = useState<string | null>(null);
  const [tab, setTab] = useState<"activity" | "properties">("activity"),
    [fitKey, refit] = useState(0);
  const [forkName, setForkName] = useState(""),
    [forkOpen, setForkOpen] = useState(false);
  const [layout, setLayout] = useState<LayoutPreset>("hierarchy");
  const theme = useTheme(),
    forkInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (forkOpen) forkInput.current?.focus();
  }, [forkOpen]);
  useEffect(() => {
    select(null);
    setFirst(null);
    setConnect(false);
    refit((n) => n + 1);
  }, [s.branch]);
  const edit = (v: Scene) => {
    if (!scene) return;
    try {
      s.edit(
        scene.diagram ? structuredEdit(scene, v, selected?.id ?? null) : v,
      );
    } catch (e) {
      s.reportError((e as Error).message);
    }
  };
  const node =
    selected?.kind === "node"
      ? scene?.nodes.find((n) => n.id === selected.id)
      : null;
  const edge =
    selected?.kind === "edge"
      ? scene?.edges.find((n) => n.id === selected.id)
      : null;
  const pick = (v: Selection) => {
    if (connect && v?.kind === "node" && scene) {
      if (!first) {
        setFirst(v.id);
        select(v);
        return;
      }
      const a = scene.nodes.find((n) => n.id === first),
        b = scene.nodes.find((n) => n.id === v.id);
      if (!a || !b || a === b) return;
      const id = crypto.randomUUID(),
        sides = facingAnchors(a.rect, b.rect);
      edit({
        ...scene,
        edges: [
          ...scene.edges,
          {
            id,
            from: { node_id: a.id, side: sides.from, offset: 0.5 },
            to: { node_id: b.id, side: sides.to, offset: 0.5 },
            style: { curve: true },
          },
        ],
      });
      select({ kind: "edge", id });
      setFirst(null);
      setConnect(false);
    } else select(v);
    if (v) {
      setTab("properties");
      s.closeReview();
    }
  };
  function add() {
    if (!scene || s.busy) return;
    const id = crypto.randomUUID(),
      after = node ?? scene.nodes.at(-1);
    edit({
      ...scene,
      nodes: [
        ...scene.nodes,
        {
          id,
          title: "新节点",
          kind: "note",
          rect: {
            x: after ? after.rect.x + after.rect.w + 60 : 60,
            y: after?.rect.y ?? 60,
            w: 200,
            h: 100,
          },
        },
      ],
    });
    select({ kind: "node", id });
    setTab("properties");
    s.closeReview();
    refit((v) => v + 1);
  }
  function remove() {
    if (!scene || !selected || s.busy) return;
    edit({
      ...scene,
      nodes: scene.nodes.filter((n) => !node || n.id !== node.id),
      edges: scene.edges.filter(
        (e) =>
          (!edge || e.id !== edge.id) &&
          (!node || (e.from.node_id !== node.id && e.to.node_id !== node.id)),
      ),
    });
    select(null);
  }
  const toggleLink = () => {
    setConnect(!connect);
    setFirst(null);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        s.closeReview();
        setConnect(false);
        setFirst(null);
        setForkOpen(false);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "s") {
          e.preventDefault();
          s.save();
        }
        return;
      }
      if (
        (e.target as Element)?.closest(
          "input,textarea,select,button,[contenteditable=true]",
        ) ||
        s.busy ||
        !!s.review
      )
        return;
      if (e.key.toLowerCase() === "n") add();
      if (e.key.toLowerCase() === "c") toggleLink();
      if (e.key.toLowerCase() === "f") refit((v) => v + 1);
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const busy = s.busy || !scene;
  const editingLocked = busy || !!s.review;
  return (
    <main className="studio">
      <header className="studio-header">
        <div className="studio-brand">
          <BrandMark />
          HumanBoard
        </div>
        <span className="studio-slash">/</span>
        <h1>{state?.space ?? "图工作台"}</h1>
        <div className="studio-end">
          <span className="studio-status">
            <i data-offline={s.offline} />
            {s.offline ? "连接中断" : "本地工作区"}
          </span>
          {back && <a href={back}>经典画板 ↗</a>}
          <button
            aria-label="切换主题"
            onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>
      <div className="studio-layout">
        <section className="studio-board">
          <div className="studio-boardhead">
            <div>
              <h2>版本画板</h2>
            </div>
            <label className="studio-branch">
              ⑂{" "}
              <select
                aria-label="当前分支"
                disabled={busy || !!s.draft}
                value={s.branch}
                onChange={(e) => s.switchBranch(e.target.value)}
              >
                {state?.refs.map((r) => (
                  <option key={r.name}>{r.name}</option>
                ))}
              </select>
            </label>
            <button disabled={busy} onClick={() => setForkOpen(!forkOpen)}>
              新建分支
            </button>
          </div>
          {forkOpen && (
            <form
              className="studio-fork"
              onSubmit={(e) => {
                e.preventDefault();
                s.fork(forkName.trim());
                setForkOpen(false);
                setForkName("");
              }}
            >
              <label>
                从当前基线创建分支
                <input
                  ref={forkInput}
                  value={forkName}
                  onChange={(e) => setForkName(e.target.value)}
                  maxLength={48}
                  required
                  placeholder="例如 design-review"
                />
              </label>
              <button className="studio-primary">创建</button>
            </form>
          )}
          <div className="studio-stage">
            {scene && (
              <GraphCanvas
                scene={scene}
                selected={selected}
                review={s.review}
                onSelect={s.review ? () => {} : pick}
                fitKey={fitKey}
                connecting={connect}
                locked={editingLocked}
                onMove={(id, x, y) =>
                  s.edit({
                    ...scene,
                    nodes: scene.nodes.map((n) =>
                      n.id === id ? { ...n, rect: { ...n.rect, x, y } } : n,
                    ),
                  })
                }
              />
            )}
            <div className="studio-tools" role="toolbar" aria-label="画板工具">
              <button
                aria-label="选择"
                aria-pressed={!connect}
                onClick={() => {
                  setConnect(false);
                  setFirst(null);
                }}
              >
                <ToolIcon tool="select" />
              </button>
              <button
                title="添加节点 (N)"
                disabled={editingLocked}
                onClick={add}
              >
                <ToolIcon tool="node" />
                节点
              </button>
              <button
                title="连线 (C)"
                aria-pressed={connect}
                disabled={editingLocked}
                onClick={toggleLink}
              >
                <ToolIcon tool="edge" />
                连线
              </button>
              <i />
              <select
                aria-label="排版预设"
                value={layout}
                onChange={(e) => setLayout(e.target.value as LayoutPreset)}
              >
                <option value="hierarchy">层次图</option>
                <option value="lanes">泳道图</option>
                <option value="mindmap">思维导图</option>
              </select>
              <button
                disabled={editingLocked || !scene?.nodes.length}
                onClick={() => {
                  if (scene) {
                    try {
                      s.edit(layoutScene(scene, layout));
                      refit((v) => v + 1);
                    } catch (e) {
                      s.reportError((e as Error).message);
                    }
                  }
                }}
              >
                排版
              </button>
            </div>
            {connect && (
              <div className="studio-hint">
                {first ? "选择终点节点" : "选择起点节点"} · Esc 取消
              </div>
            )}
            {scene &&
              !scene.nodes.length &&
              !scene.strokes.length &&
              !scene.assets.length && (
                <div className="studio-empty">
                  <h3>从一个节点开始</h3>
                  <button disabled={editingLocked} onClick={add}>
                    添加节点
                  </button>
                  <button
                    disabled={editingLocked || !!s.draft}
                    onClick={s.replay}
                  >
                    体验 Agent 提案
                  </button>
                </div>
              )}
          </div>
          <footer>
            <span>
              {scene?.nodes.length ?? 0} 节点 · {scene?.edges.length ?? 0} 连线
            </span>
            <span role="status">
              {s.offline
                ? "连接中断"
                : !state
                  ? "正在载入…"
                  : s.stale
                    ? "基线已更新，可另存分支"
                    : s.draft
                      ? "草稿未提交"
                      : s.busy
                        ? "正在处理…"
                        : "已同步"}
            </span>
            {s.draft && (
              <button disabled={editingLocked} onClick={s.discard}>
                放弃草稿
              </button>
            )}
            <button
              className="studio-primary"
              disabled={editingLocked || !s.draft || s.stale}
              onClick={s.save}
            >
              提交版本
            </button>
          </footer>
        </section>
        <aside className="studio-side">
          {s.review && state ? (
            <ReviewDrawer
              review={s.review}
              state={state}
              disabled={
                busy ||
                !!s.draft ||
                s.review.head !== state.head ||
                (!!s.review.sourceBranch &&
                  !state.refs.some(
                    (r) =>
                      r.name === s.review?.sourceBranch &&
                      r.head === s.review.source,
                  ))
              }
              accept={() => s.publish("accept")}
              close={s.closeReview}
            />
          ) : (
            <>
              <nav aria-label="工作台面板">
                <button
                  aria-pressed={tab === "activity"}
                  onClick={() => setTab("activity")}
                >
                  协作动态
                </button>
                <button
                  aria-pressed={tab === "properties"}
                  onClick={() => setTab("properties")}
                >
                  对象属性
                </button>
              </nav>
              {tab === "properties" ? (
                <section className="studio-inspector">
                  <h2>{edge ? "连线属性" : node ? "节点属性" : "对象属性"}</h2>
                  {!node && !edge && <p>在画布上选择节点或连线。</p>}
                  {scene && node && (
                    <fieldset disabled={busy}>
                      <label>
                        节点标题
                        <input
                          value={node.title}
                          onChange={(e) =>
                            edit({
                              ...scene,
                              nodes: scene.nodes.map((n) =>
                                n === node
                                  ? { ...n, title: e.target.value }
                                  : n,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        说明
                        <textarea
                          value={node.sub ?? ""}
                          onChange={(e) =>
                            edit({
                              ...scene,
                              nodes: scene.nodes.map((n) =>
                                n === node ? { ...n, sub: e.target.value } : n,
                              ),
                            })
                          }
                        />
                      </label>
                      {!scene.diagram && (
                        <label>
                          节点类型
                          <select
                            value={node.kind}
                            onChange={(e) =>
                              edit({
                                ...scene,
                                nodes: scene.nodes.map((n) =>
                                  n === node
                                    ? {
                                        ...n,
                                        kind: e.target.value as typeof n.kind,
                                      }
                                    : n,
                                ),
                              })
                            }
                          >
                            {NODE_KINDS.map((k) => (
                              <option key={k}>{k}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        颜色
                        <select
                          value={String(node.style?.color ?? "blue")}
                          onChange={(e) =>
                            edit({
                              ...scene,
                              nodes: scene.nodes.map((n) =>
                                n === node
                                  ? {
                                      ...n,
                                      style: {
                                        ...n.style,
                                        color: e.target.value,
                                      },
                                    }
                                  : n,
                              ),
                            })
                          }
                        >
                          {[
                            "blue",
                            "teal",
                            "purple",
                            "amber",
                            "rose",
                            "slate",
                            "green",
                          ].map((k, i) => (
                            <option key={k} value={k}>
                              {
                                ["蓝", "青", "紫", "琥珀", "玫红", "灰", "绿"][
                                  i
                                ]
                              }
                            </option>
                          ))}
                        </select>
                      </label>
                    </fieldset>
                  )}
                  {scene && edge && (
                    <fieldset disabled={busy}>
                      <label>
                        连线标签
                        <input
                          value={edge.label ?? ""}
                          onChange={(e) =>
                            edit({
                              ...scene,
                              edges: scene.edges.map((v) =>
                                v === edge
                                  ? { ...v, label: e.target.value }
                                  : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        线型
                        <select
                          value={edge.style?.dashed ? "dashed" : "solid"}
                          onChange={(e) =>
                            edit({
                              ...scene,
                              edges: scene.edges.map((v) =>
                                v === edge
                                  ? {
                                      ...v,
                                      style: {
                                        ...v.style,
                                        dashed: e.target.value === "dashed",
                                      },
                                    }
                                  : v,
                              ),
                            })
                          }
                        >
                          <option value="solid">实线</option>
                          <option value="dashed">虚线</option>
                        </select>
                      </label>
                    </fieldset>
                  )}
                  {(node || edge) && (
                    <button disabled={busy} onClick={remove}>
                      移除所选对象
                    </button>
                  )}
                </section>
              ) : (
                <>
                  <section className="studio-feedhead">
                    <h2>协作记录</h2>
                    <button disabled={busy || !!s.draft} onClick={s.replay}>
                      ＋ 本地 Agent 提案
                    </button>
                  </section>
                  <ol className="studio-feed">
                    {state?.history.map((l) => (
                      <li key={l.id}>
                        <i data-agent={l.author.kind !== "human"} />
                        <div>
                          <small>
                            {l.author.kind === "human"
                              ? "编辑者"
                              : l.author.name || "CLI / MCP Agent"}{" "}
                            · L{l.seq}
                          </small>
                          <strong>
                            {l.title || (l.parent ? "未命名版本" : "初始画板")}
                          </strong>
                          <span>
                            {state.refs
                              .filter((b) => b.head === l.id)
                              .map((b) => b.name)
                              .join(" · ") ||
                              new Date(l.created).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                          </span>
                          {
                            <button
                              disabled={busy || !!s.draft}
                              onClick={() =>
                                s.inspect(
                                  l.id,
                                  state.refs.find((b) => b.head === l.id)?.name,
                                )
                              }
                            >
                              <DiffIcon />
                              审阅
                            </button>
                          }
                          {l.id === state.head && l.parent && (
                            <button
                              disabled={busy || !!s.draft}
                              onClick={() => s.publish("revert")}
                            >
                              <UndoIcon />
                              回滚此版本
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
        </aside>
      </div>
      {s.error && (
        <div className="studio-error" role="alert">
          {s.error}
          <button onClick={s.dismiss}>关闭</button>
        </div>
      )}
    </main>
  );
}
