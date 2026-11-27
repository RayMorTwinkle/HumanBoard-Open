import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { StatusData } from "../client/types";
import { SpaceCard } from "./SpaceCard";

export function SpacesOverview({
  open,
  status,
  dirty,
  locked,
  error,
  onClose,
  onSelect,
  onCreate,
  onVisibility,
  freshSpaces = {},
}: {
  open: boolean;
  status: StatusData | null;
  dirty: boolean;
  locked: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (id: string) => Promise<boolean>;
  onCreate: (name: string) => Promise<boolean>;
  onVisibility: (id: string, deleted: boolean) => Promise<boolean>;
  freshSpaces?: Readonly<Record<string, "new" | "layers">>;
}) {
  const [trash, setTrash] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [present, setPresent] = useState(open);
  const [visible, setVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let first = 0,
      second = 0;
    if (open) {
      setTrash(false);
      previousFocus.current =
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
          ? document.activeElement
          : document.querySelector(".spaces-button");
      setPresent(true);
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          setVisible(true);
          dialog.current
            ?.querySelector<HTMLButtonElement>('[aria-label="关闭 Spaces"]')
            ?.focus();
        });
      });
    } else {
      setVisible(false);
      setCreating(false);
      setDeleting(null);
      previousFocus.current?.focus();
    }
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timer = !open
      ? setTimeout(() => setPresent(false), reduced ? 0 : 360)
      : undefined;
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(timer);
    };
  }, [open]);
  const enter = async (id: string) => {
    if (busy.current) return;
    if (id === status?.space.id) {
      onClose();
      return;
    }
    busy.current = true;
    setPending(id);
    try {
      await onSelect(id);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const changeVisibility = async (id: string, deleted: boolean) => {
    if (busy.current || locked || (deleted && dirty)) return;
    busy.current = true;
    setPending(id);
    try {
      if (await onVisibility(id, deleted)) setDeleting(null);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  if (!present) return null;
  return createPortal(
    <div
      className={`spaces-overview ${visible && open ? "is-open" : ""}`}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="spaces-scrim" onClick={onClose} aria-hidden="true" />
      <section
        className="spaces-overview-inner"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spaces-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled)",
              ),
            ];
            const first = items[0],
              last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="spaces-overview-heading">
          <div className="spaces-project-label">
            {status?.project.name ?? "HumanBoard"} ·{" "}
            {status?.spaces.length ?? 0} spaces
          </div>
          <h2 id="spaces-title">Spaces</h2>
          <p>
            点击卡片进入 · <kbd>Esc</kbd> 返回画布
          </p>
          <button type="button" onClick={onClose} aria-label="关闭 Spaces">
            ×
          </button>
        </header>
        {dirty && (
          <p className="space-unsaved-note" role="status">
            未保存编辑已保留。请返回画布保存或放弃后，再切换或新建空间。
          </p>
        )}
        {error && (
          <p className="spaces-error" role="alert">
            {error}
          </p>
        )}
        <div className="space-view-switch">
          <button
            aria-pressed={!trash}
            onClick={() => {
              setTrash(false);
              setDeleting(null);
            }}
          >
            空间
          </button>
          <button
            aria-pressed={trash}
            onClick={() => {
              setTrash(true);
              setDeleting(null);
            }}
          >
            回收站 ({status?.deleted_spaces?.length ?? 0})
          </button>
        </div>
        {deleting && (
          <div className="space-delete-confirm" role="alert">
            <p>
              将「{status?.spaces.find((s) => s.id === deleting)?.name}
              」移到回收站？版本、图片和对话会保留，可以恢复。
            </p>
            <button
              disabled={!!pending || locked || dirty}
              onClick={() => void changeVisibility(deleting, true)}
            >
              移到回收站
            </button>
            <button disabled={!!pending} onClick={() => setDeleting(null)}>
              取消
            </button>
          </div>
        )}
        {trash && !status?.deleted_spaces?.length && (
          <p className="space-unsaved-note">回收站是空的。</p>
        )}
        <div className="space-cards">
          {(trash
            ? (status?.deleted_spaces ?? [])
            : (status?.spaces ?? [])
          ).map((space, index) => (
            <div className="space-card-container" key={space.id}>
              <SpaceCard
                key={space.id}
                index={index}
                projectId={status!.project.id}
                space={space}
                current={space.id === status!.space.id}
                fresh={freshSpaces[space.id]}
                pending={pending === space.id}
                locked={
                  trash ||
                  !!pending ||
                  ((locked || dirty) && space.id !== status!.space.id)
                }
                onSelect={() => void enter(space.id)}
              />
              {trash ? (
                <button
                  className="space-manage"
                  disabled={locked || !!pending}
                  aria-label={`恢复空间 ${space.name}`}
                  onClick={() => void changeVisibility(space.id, false)}
                >
                  恢复
                </button>
              ) : (
                <button
                  className="space-manage"
                  disabled={
                    locked ||
                    dirty ||
                    !!pending ||
                    (status?.spaces.length ?? 0) <= 1
                  }
                  title={
                    (status?.spaces.length ?? 0) <= 1
                      ? "请至少保留一个空间"
                      : "移到回收站"
                  }
                  aria-label={`删除空间 ${space.name}`}
                  onClick={() => setDeleting(space.id)}
                >
                  删除
                </button>
              )}
            </div>
          ))}
          {!trash &&
            (creating ? (
              <form
                className="space-card new-space-card space-create"
                style={
                  {
                    "--space-index": Math.min(status?.spaces.length ?? 0, 6),
                  } as CSSProperties
                }
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (busy.current || dirty || locked || !name.trim()) return;
                  busy.current = true;
                  setPending("new");
                  try {
                    if (await onCreate(name.trim())) setName("");
                  } finally {
                    busy.current = false;
                    setPending(null);
                  }
                }}
              >
                <label htmlFor="space-create-name">新建 Space</label>
                <input
                  id="space-create-name"
                  aria-label="新空间名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="给下一个想法取个名字"
                  required
                  maxLength={100}
                  autoFocus
                  disabled={!!pending || dirty || locked}
                />
                <button type="submit" disabled={!!pending || dirty || locked}>
                  {pending === "new" ? "正在创建…" : "新建 Space"}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="space-card new-space-card"
                style={
                  {
                    "--space-index": Math.min(status?.spaces.length ?? 0, 6),
                  } as CSSProperties
                }
                disabled={!!pending || locked || dirty || !status}
                onClick={() => setCreating(true)}
              >
                <span className="new-space-plus">＋</span>
                <strong>新建 Space</strong>
                <span>为下一个想法留一块画板</span>
              </button>
            ))}
        </div>
        <footer>同一 Project 下的画布总览 · 返回时保留你的视图与编辑</footer>
      </section>
    </div>,
    document.body,
  );
}
