import { removeObject } from "../canvas-geometry";
import { boardShortcutsBlocked } from "../board-shortcuts";
import { useEffect, useRef, useState } from "react";
import type { Tool } from "../client/types";
import { insertBoardAsset } from "../asset-insertion";
import { useBoardStore } from "../store/useBoardStore";
import { ToolIcon, UndoIcon, ImageIcon, LinkIcon } from "./icons";
import { EDGE_PRESETS, PEN_COLORS } from "../ink";
import { EdgePresetIcon } from "./icons";
const TOOLS: readonly { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "选择", key: "V" },
  { tool: "node", label: "节点", key: "N" },
  { tool: "edge", label: "连线", key: "C" },
  { tool: "pen", label: "画笔", key: "P" },
  { tool: "highlighter", label: "荧光笔", key: "H" },
  { tool: "eraser", label: "橡皮", key: "E" },
];
const inputTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
export function ToolDock() {
  const selectedTool = useBoardStore((s) => s.selectedTool),
    undo = useBoardStore((s) => s.undoStack),
    locked = useBoardStore((s) => s.editingLocked),
    penColor = useBoardStore((s) => s.penColor),
    edgePreset = useBoardStore((s) => s.edgePreset);
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false),
    [url, setUrl] = useState(""),
    [uploading, setUploading] = useState(false);
  const insert = async (file?: File, link?: string) => {
    const state = useBoardStore.getState();
    if (!state.status || state.editingLocked || uploading) return;
    setUploading(true);
    try {
      await insertBoardAsset({ file, url: link });
      setLinkOpen(false);
      setUrl("");
    } catch (e) {
      state.setError(e instanceof Error ? e.message : String(e));
    } finally {
      state.setEditingLocked(false);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (boardShortcutsBlocked(e) || inputTarget(e.target)) return;
      const s = useBoardStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        s.undoStroke();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        s.selectNode(null);
        s.setTool("select");
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        s.selectedNodeId &&
        !s.editingLocked &&
        !s.diffView
      ) {
        e.preventDefault();
        s.editScene((v) => removeObject(v, s.selectedNodeId!));
        s.selectNode(null);
        return;
      }

      const match = TOOLS.find(
        (t) => t.key.toLowerCase() === e.key.toLowerCase(),
      );
      if (match) s.setTool(match.tool);
    };
    const paste = (e: ClipboardEvent) => {
      if (inputTarget(e.target)) return;
      const image = [...(e.clipboardData?.items ?? [])]
        .find((item) => item.type.startsWith("image/"))
        ?.getAsFile();
      const text = e.clipboardData?.getData("text/plain").trim();
      if (image) {
        e.preventDefault();
        void insert(image);
      } else if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        void insert(undefined, text);
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, [uploading]);
  return (
    <>
      {selectedTool === "pen" && !locked && (
        <div className="ink-palette" role="radiogroup" aria-label="画笔颜色">
          {PEN_COLORS.map((p) => (
            <button
              type="button"
              key={p.color}
              role="radio"
              aria-checked={penColor === p.color}
              aria-label={`${p.label}色`}
              title={`${p.label}色`}
              style={{ "--ink": p.color } as React.CSSProperties}
              onClick={() => useBoardStore.getState().setPenColor(p.color)}
            />
          ))}
        </div>
      )}
      {selectedTool === "edge" && !locked && (
        <div
          className="ink-palette is-lines"
          role="radiogroup"
          aria-label="连线样式"
        >
          {EDGE_PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={edgePreset === p.id}
              aria-label={p.label}
              title={p.label}
              onClick={() => useBoardStore.getState().setEdgePreset(p.id)}
            >
              <EdgePresetIcon preset={p.id} />
            </button>
          ))}
        </div>
      )}
      <div className="tool-dock" aria-label="画布工具">
        {TOOLS.map((item) => (
          <button
            type="button"
            key={item.tool}
            className={`tool-button ${selectedTool === item.tool ? "is-selected" : ""}`}
            data-tool={item.tool}
            style={
              item.tool === "pen"
                ? ({ "--ink": penColor } as React.CSSProperties)
                : undefined
            }
            disabled={locked}
            onClick={() => useBoardStore.getState().setTool(item.tool)}
            title={`${item.label} (${item.key})`}
            aria-label={`${item.label} (${item.key})`}
            aria-pressed={selectedTool === item.tool}
          >
            <ToolIcon tool={item.tool} />
            <span>{item.label}</span>
            <kbd>{item.key}</kbd>
          </button>
        ))}
        <span className="dock-separator" />
        <button
          className="tool-button"
          aria-label="贴图"
          title="上传图片，或直接粘贴"
          onClick={() => fileRef.current?.click()}
          disabled={locked}
        >
          <ImageIcon />
          <span>贴图</span>
        </button>
        <button
          className="tool-button"
          aria-label="链接"
          title="放入网页链接"
          onClick={() => setLinkOpen(true)}
          disabled={locked}
        >
          <LinkIcon />
          <span>链接</span>
        </button>
        <button
          className="tool-button undo-button"
          onClick={() => useBoardStore.getState().undoStroke()}
          disabled={!undo.length || locked}
          aria-label="撤销未提交编辑"
        >
          <UndoIcon />
          <span>撤销</span>
          <kbd>⌘Z</kbd>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void insert(f);
          }}
        />
      </div>
      {linkOpen && (
        <div className="modal-backdrop">
          <form
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="link-dialog-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !uploading) {
                e.preventDefault();
                setLinkOpen(false);
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void insert(undefined, url);
            }}
          >
            <h2 id="link-dialog-title">把网页放到画板上</h2>
            <p>AI 可读取网页正文，你可以在卡片上继续批注。</p>
            <input
              autoFocus
              type="url"
              aria-label="网页地址"
              placeholder="https://…"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => setLinkOpen(false)}
                disabled={uploading}
              >
                取消
              </button>
              <button type="submit" disabled={uploading}>
                {uploading ? "登记中…" : "放入画板"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
