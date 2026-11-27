import type {
  Review,
  StudioState,
} from "../../../core-engine/src/revisions/service";
const verbs: Record<string, string> = {
  added: "新增",
  modified: "修改",
  removed: "删除",
};
function readable(v: unknown) {
  return v === null ? "∅" : typeof v === "string" ? v : JSON.stringify(v);
}
export function ReviewDrawer({
  review,
  state,
  disabled,
  accept,
  close,
}: {
  review: Review;
  state: StudioState;
  disabled: boolean;
  accept: () => void;
  close: () => void;
}) {
  const label = (id: string) =>
    "L" + (state.history.find((l) => l.id === id)?.seq ?? "–");
  return (
    <section className="studio-review" aria-label="Diff 审阅抽屉">
      <header>
        <div>
          <h2>{review.alreadyMerged ? "版本差异" : "审阅变更"}</h2>
        </div>
        <button aria-label="关闭审阅" onClick={close}>
          ×
        </button>
      </header>
      <p className="studio-path">
        {review.alreadyMerged ? (
          (review.comparedTo ? label(review.comparedTo) : "空画板") +
          " → " +
          label(review.source)
        ) : (
          <>
            {label(review.source)} → {state.branch}
            <span>共同祖先 {label(review.base)}</span>
          </>
        )}
      </p>
      <div className="studio-counts">
        {Object.entries(verbs).map(([key, v]) => (
          <span key={key} data-kind={key}>
            {v} {review.changes.filter((c) => c.kind === key).length}
          </span>
        ))}
      </div>
      <div className="studio-diff-list">
        {review.changes.map((c) => (
          <details key={c.entity + c.id} data-kind={c.kind}>
            <summary>
              <b>{verbs[c.kind]}</b> {c.label || c.id}
              <small>{c.entity}</small>
            </summary>
            {c.before && c.after ? (
              Object.keys({ ...c.before, ...c.after })
                .filter(
                  (k) =>
                    JSON.stringify(Reflect.get(c.before!, k)) !==
                    JSON.stringify(Reflect.get(c.after!, k)),
                )
                .map((k) => (
                  <div key={k}>
                    <strong>{k}</strong>
                    <del>{readable(Reflect.get(c.before!, k))}</del>
                    <ins>{readable(Reflect.get(c.after!, k))}</ins>
                  </div>
                ))
            ) : (
              <pre>{JSON.stringify(c.after ?? c.before, null, 2)}</pre>
            )}
          </details>
        ))}
        {review.conflicts.map((c) => (
          <article key={JSON.stringify(c.path)}>
            <b>冲突 · {c.path.join(" / ")}</b>
            <p>祖先　{readable(c.base)}</p>
            <p>当前　{readable(c.current)}</p>
            <p>来源　{readable(c.incoming)}</p>
          </article>
        ))}
      </div>
      {review.alreadyMerged && <p>此版本已包含在分支历史中。</p>}
      {!!review.conflicts.length && <p>在来源分支处理冲突后，重新审阅。</p>}
      {!review.alreadyMerged && (
        <button
          className="studio-primary"
          disabled={disabled || !!review.conflicts.length}
          onClick={accept}
        >
          接受变更
        </button>
      )}
    </section>
  );
}
