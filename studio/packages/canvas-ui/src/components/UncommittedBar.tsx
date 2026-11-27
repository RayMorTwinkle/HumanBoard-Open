import { useBoardStore } from "../store/useBoardStore";

interface UncommittedBarProps {
  readonly saving: boolean;
  readonly onSave: (title?: string) => void;
  readonly onDiscard: () => void;
  readonly onTransform?: () => void;
  readonly transformAvailable?: boolean;
}

export function UncommittedBar({
  saving,
  onSave,
  onDiscard,
  onTransform,
  transformAvailable,
}: UncommittedBarProps) {
  const title = useBoardStore((s) => s.commitTitle);
  const setTitle = useBoardStore((s) => s.setCommitTitle);
  const strokes = useBoardStore((state) => state.uncommittedStrokes);
  const dirty = useBoardStore((state) => state.dirty);
  if (!dirty) {
    return null;
  }
  return (
    <div className="uncommitted-bar" role="status">
      <span className="pulse-dot" />
      <span className="uncommitted-copy">
        <b>未提交修改</b>
        <small>
          {strokes.length ? `${strokes.length} 条新笔迹` : "画板内容已修改"} ·
          已在本机暂存
        </small>
      </span>
      <input
        className="commit-title"
        aria-label="新层标题"
        maxLength={40}
        placeholder="变化量标题（可选）"
        value={title}
        disabled={saving}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button type="button" onClick={onDiscard} disabled={saving}>
        放弃
      </button>
      <button
        type="button"
        className="is-primary"
        onClick={() => onSave(title)}
        disabled={saving}
      >
        {saving ? "保存中…" : "保存为新层"}
        {saving ? null : <kbd>⌘S</kbd>}
      </button>
      <button
        type="button"
        className="is-ai"
        disabled={saving || !transformAvailable}
        onClick={onTransform}
        title={
          transformAvailable
            ? "让 AI 按需读取当前未保存画板并转化"
            : "请先配置内置 Agent 模型"
        }
      >
        转为逻辑图
      </button>
    </div>
  );
}
