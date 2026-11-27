import { useEffect, useRef } from "react";

import type { DiffData } from "../client/types";
import type { DiffBoxCounts } from "../diff";
import type { DiffImageMode } from "../store/useBoardStore";

const MODES: readonly {
  readonly mode: DiffImageMode;
  readonly label: string;
}[] = [
  { mode: "before", label: "变更前" },
  { mode: "after", label: "变更后" },
  { mode: "highlight", label: "高亮变化" },
];

/**
 * A transient look at what a layer changed. The canvas shows the chosen image;
 * Esc or any press outside this card (and outside a Diff trigger) dismisses it.
 */
export function DiffPreview({
  diff,
  mode,
  boxes,
  onMode,
  onClose,
  onVisual,
  pending = false,
  objectNames = {},
}: {
  readonly diff: DiffData;
  readonly mode: DiffImageMode;
  readonly boxes: DiffBoxCounts;
  readonly onMode: (mode: DiffImageMode) => void;
  readonly onClose: () => void;
  readonly onVisual?: () => void;
  readonly pending?: boolean;
  readonly objectNames?: Readonly<Record<string, string>>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const press = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest("[data-diff-trigger]")) return;
      // A press on the board only dismisses the preview; it must not start a stroke.
      if (target.closest(".canvas-shell")) {
        e.preventDefault();
        e.stopPropagation();
      }
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("pointerdown", press, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="diff-preview"
      role="dialog"
      aria-label={`${diff.base.short_id} 到 ${diff.target.short_id} 的变化`}
    >
      <div className="diff-preview-head">
        <b>
          {diff.base.short_id} → {diff.target.short_id}
        </b>
        <span>{diff.summary || "两层内容一致"}</span>
      </div>
      {diff.ast && (
        <ul className="diff-structure-changes">
          {(["nodes", "edges", "assets"] as const).flatMap((kind) => {
            const names = { nodes: "节点", edges: "连线", assets: "素材" };
            const verbs: Record<string, string> = {
              added: "新增",
              removed: "删除",
              moved: "移动",
              resized: "尺寸变化",
              updated: "修改",
            };
            return Object.entries(diff.ast![kind]).flatMap(([action, items]) =>
              (
                items as {
                  id?: string;
                  asset_id?: string;
                  title?: string;
                  fields?: string[];
                }[]
              ).map((item, i) => (
                <li key={`${kind}:${action}:${i}`}>
                  {names[kind]} · {verbs[action] ?? action} ·{" "}
                  {item.title ||
                    objectNames[item.id ?? item.asset_id ?? ""] ||
                    item.id ||
                    item.asset_id}
                  {item.fields?.length
                    ? `（${item.fields.map((f) => ({ title: "标题", sub: "说明", style: "样式", from: "起点", to: "终点", label: "标签" })[f] ?? f).join("、")}）`
                    : ""}
                </li>
              )),
            );
          })}
        </ul>
      )}
      {diff.ast_summary?.notable.map((note, i) => (
        <p key={i}>{note}</p>
      ))}
      {diff.visual ? (
        <div className="diff-mode-switch" role="group" aria-label="Diff 图像">
          {MODES.map((item) => (
            <button
              type="button"
              key={item.mode}
              className={`diff-mode-button ${mode === item.mode ? "is-selected" : ""}`}
              aria-pressed={mode === item.mode}
              onClick={() => onMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          className="diff-mode-button"
          type="button"
          disabled={pending}
          onClick={onVisual}
        >
          {pending ? "正在生成视觉对比…" : "视觉对比（可选）"}
        </button>
      )}
      <div className="diff-preview-foot">
        {diff.visual ? (
          <>
            <span className="diff-count is-stroke">红框 {boxes.stroke}</span>
            <span className="diff-count is-node">紫框 {boxes.node}</span>
          </>
        ) : null}
        <span className="diff-alt-hint">Esc 或点击别处关闭</span>
      </div>
    </div>
  );
}
