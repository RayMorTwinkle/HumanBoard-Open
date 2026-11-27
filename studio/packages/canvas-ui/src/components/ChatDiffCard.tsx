import { useState } from "react";
import {
  HumanBoardClient,
  renderUrlForBrowser,
} from "../client/HumanBoardClient";
import type { DiffData } from "../client/types";
export function ChatDiffCard({
  layerId,
  projectId,
  spaceId,
}: {
  layerId: string;
  projectId?: string;
  spaceId?: string;
}) {
  const [diff, setDiff] = useState<DiffData | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (diff || pending) return;
    setPending(true);
    setError(null);
    try {
      setDiff(
        await new HumanBoardClient({ project: projectId, space: spaceId }).diff(
          layerId,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <details
      className="chat-diff-card"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>本轮变化</summary>
      {pending && <small>加载中…</small>}
      {error && <small role="status">{error}</small>}
      {diff && (
        <>
          <p>{diff.summary || "画面内容相同"}</p>
          {diff.visual && (
            <div className="chat-diff-images">
              {(["before", "after", "highlight"] as const).map((key) => (
                <figure key={key}>
                  <img
                    src={renderUrlForBrowser(diff.visual![key].url)}
                    loading="lazy"
                    alt={`本轮 ${key} 预览`}
                  />
                  <figcaption>
                    {
                      {
                        before: "修改前",
                        after: "修改后",
                        highlight: "增量高亮",
                      }[key]
                    }
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      )}
    </details>
  );
}
