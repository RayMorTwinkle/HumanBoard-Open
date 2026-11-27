import { useEffect, useRef, useState, type CSSProperties } from "react";
import { renderSceneToSVG } from "@humanboard/core-engine/scene-svg";
import { sceneFromGetData } from "../capture";
import {
  HumanBoardClient,
  renderUrlForBrowser,
} from "../client/HumanBoardClient";
import type { SpaceSummary } from "../client/types";
import { spaceCoverQueue } from "../space-covers";
import { useTheme } from "../theme";
export function SpaceCard({
  projectId,
  space,
  current,
  locked,
  onSelect,
  index = 0,
  pending = false,
  fresh,
}: {
  projectId: string;
  space: SpaceSummary;
  current: boolean;
  locked: boolean;
  onSelect: () => void;
  index?: number;
  pending?: boolean;
  /** Added elsewhere ("new"), or gained layers elsewhere, since the human last looked. */
  fresh?: "new" | "layers";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const theme = useTheme();
  const [cover, setCover] = useState<{ url: string; title: string } | null>(
      null,
    ),
    [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    let started = false;
    setCover(null);
    setError(false);
    if (!space.layer_count) return () => abort.abort();
    const load = () => {
      if (started || abort.signal.aborted) return;
      started = true;
      void spaceCoverQueue
        .run(async () => {
          const client = new HumanBoardClient({
            project: projectId,
            space: space.id,
          });
          const data = await client.get(
            space.cover_layer_id ?? undefined,
            "ast",
            { withStrokes: true, signal: abort.signal },
          );
          // Logic/URL previews share the canvas theme and need no server PNG.
          // Image-heavy boards reuse their cached PNG instead of downloading full originals.
          const url = data.assets.some((a) => a.type === "image")
            ? renderUrlForBrowser(
                (
                  await client.get(data.layer.id, "render", {
                    signal: abort.signal,
                  })
                ).render!.url,
              )
            : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSceneToSVG(sceneFromGetData(data), { theme, background: "transparent", assetTitles: Object.fromEntries(data.assets.map((a) => [a.asset_id, a.title])), assetCards: Object.fromEntries(data.assets.filter((a) => a.source_url).map((a) => [a.asset_id, { url: a.source_url!, description: a.description }])) }))}`;
          return { url, title: data.layer.title || data.layer.short_id };
        }, abort.signal)
        .then((data) => {
          if (!abort.signal.aborted) setCover(data);
        })
        .catch(() => {
          if (!abort.signal.aborted) setError(true);
        });
    };
    const element = ref.current;
    const observer =
      typeof IntersectionObserver !== "undefined" && element
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                load();
                observer?.disconnect();
              }
            },
            { rootMargin: "100px" },
          )
        : null;
    if (observer && element) observer.observe(element);
    else load();
    return () => {
      abort.abort();
      observer?.disconnect();
    };
  }, [projectId, space.id, space.cover_layer_id, space.layer_count, theme]);
  return (
    <button
      ref={ref}
      className={`space-card ${current ? "is-current" : ""} ${pending ? "is-entering" : ""} ${fresh ? "is-fresh" : ""}`}
      style={{ "--space-index": Math.min(index, 6) } as CSSProperties}
      data-space-id={space.id}
      data-stack={Math.min(space.layer_count, 3) || undefined}
      aria-current={current ? "true" : undefined}
      aria-busy={pending}
      onClick={onSelect}
      disabled={locked}
      aria-label={`打开空间 ${space.name}`}
    >
      <div className="space-cover">
        {current && <span className="space-current-flag">正在看</span>}
        {fresh && (
          <span className="space-fresh-flag">
            {fresh === "new" ? "新空间" : "有新层"}
          </span>
        )}
        {cover && !error ? (
          <img
            src={cover.url}
            alt={`${space.name} 的已保存画板`}
            loading="lazy"
            onError={() => setError(true)}
          />
        ) : (
          <span className="space-cover-placeholder">
            {!space.layer_count
              ? "尚无已保存画板"
              : error
                ? "预览暂不可用"
                : "正在加载画板…"}
          </span>
        )}
        {cover && !error && (
          <span className="space-cover-caption">{cover.title}</span>
        )}
      </div>
      <div className="space-card-meta">
        <div>
          <strong>{space.name}</strong>
          <span>
            {pending
              ? "正在进入…"
              : `${space.layer_count} 个版本${current ? " · 当前空间" : ""}`}
          </span>
        </div>
        <span className="space-enter-arrow" aria-hidden="true">
          {pending ? "◌" : "↗"}
        </span>
      </div>
    </button>
  );
}
