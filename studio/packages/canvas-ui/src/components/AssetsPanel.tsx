import { useState } from "react";
import type {
  ProjectSyncData,
  AssetManifestItem,
  InspectData,
  InspectUrlData,
} from "../client/types";
import { renderUrlForBrowser } from "../client/HumanBoardClient";

interface AssetsPanelProps {
  readonly autoTitleEnabled?: boolean;
  readonly onToggleAutoTitle?: (enabled: boolean) => void;
  readonly projectSync?: ProjectSyncData | null;
  readonly onToggleSync?: (enabled: boolean) => void;
  readonly assets: readonly AssetManifestItem[];
  readonly activeLayerShortId: string | null;
  readonly inspect: InspectData | null;
  readonly onInspect: (assetId: string) => void;
  readonly onClearInspect: () => void;
  readonly onCollapse?: () => void;
  readonly onRename?: (id: string, title: string) => Promise<void>;
}

function isMarkdownContent(
  content: InspectData["content"],
): content is InspectUrlData["content"] {
  return "kind" in content && content.kind === "markdown";
}

export function AssetsPanel({
  autoTitleEnabled,
  onToggleAutoTitle,
  projectSync,
  onToggleSync,
  assets,
  activeLayerShortId,
  inspect,
  onInspect,
  onClearInspect,
  onCollapse,
  onRename,
}: AssetsPanelProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [copied, setCopied] = useState(false);
  return (
    <aside className="panel assets-panel">
      <div className="panel-heading">
        <div>
          <div className="panel-kicker">Manifest</div>
          <h2>Assets</h2>
        </div>
        <div className="panel-heading-actions">
          <span className="panel-count">{assets.length}</span>
          {onCollapse ? (
            <button
              type="button"
              className="panel-collapse"
              onClick={onCollapse}
              aria-label="收起 Assets 面板"
              title="收起 Assets"
            >
              ›
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel-subline">
        <span>#{activeLayerShortId ?? "—"} asset refs</span>
        <span className="ml-auto font-mono">L1 索引</span>
      </div>

      {projectSync && (
        <details className="project-sync-settings">
          <summary>项目同步</summary>
          <label>
            <input
              type="checkbox"
              aria-label="开启此项目的远端同步"
              checked={projectSync.cloud_sync}
              disabled={!projectSync.remote_configured}
              onChange={(e) => onToggleSync?.(e.target.checked)}
            />
            自动拉取与推送
          </label>
          <small>
            {!projectSync.remote_configured
              ? "使用 human connect 配置远端后可开启"
              : projectSync.running
                ? "正在同步…"
                : projectSync.cloud_sync
                  ? projectSync.last_synced_at
                    ? `上次同步 ${new Date(projectSync.last_synced_at).toLocaleTimeString()}`
                    : "等待首次同步"
                  : "此项目同步已关闭"}
          </small>
          {projectSync.error && <p role="status">{projectSync.error}</p>}
        </details>
      )}
      {onToggleAutoTitle && (
        <div className="project-sync-settings">
          <label>
            <input
              type="checkbox"
              aria-label="自动命名图片和图层"
              checked={autoTitleEnabled ?? false}
              onChange={(e) => onToggleAutoTitle(e.target.checked)}
            />
            自动命名图片和图层
          </label>
          <small>已有标题始终保留，当前运行的命名任务可能继续完成。</small>
        </div>
      )}
      <div className="asset-list">
        {assets.length === 0 ? (
          <div className="panel-empty">
            <span className="empty-mark">#001</span>
            <strong>当前层没有资产</strong>
            <span>截图或链接进入画布后，会在这里生成 L1 Manifest。</span>
          </div>
        ) : (
          assets.map((asset) => (
            <article className="asset-row" key={asset.asset_id}>
              <span className="asset-id">#{asset.display_no}</span>
              <div className="min-w-0 flex-1">
                {renaming === asset.asset_id ? (
                  <form
                    className="asset-rename"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await onRename?.(asset.asset_id, title);
                      setRenaming(null);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label="资产标题"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={120}
                      required
                    />
                    <button type="submit">保存</button>
                    <button type="button" onClick={() => setRenaming(null)}>
                      取消
                    </button>
                  </form>
                ) : (
                  <div className="asset-title">{asset.title || "等待命名"}</div>
                )}
                {asset.description && (
                  <p className="asset-description">{asset.description}</p>
                )}
                {onRename && renaming !== asset.asset_id && (
                  <div className="asset-actions">
                    <button
                      onClick={() => {
                        setRenaming(asset.asset_id);
                        setTitle(asset.title);
                      }}
                    >
                      改名
                    </button>
                  </div>
                )}
                <div className="asset-meta">
                  <span>{asset.type.toUpperCase()}</span>
                  <span className="font-mono">
                    {asset.rect.x},{asset.rect.y} · {asset.rect.w}×
                    {asset.rect.h}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="mini-action"
                onClick={() => onInspect(asset.display_no)}
              >
                Inspect
              </button>
            </article>
          ))
        )}
      </div>

      {inspect ? (
        <section className="inspect-card">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="panel-kicker">Inspect</div>
              <strong className="text-[12px]">
                #{inspect.asset.display_no} · {inspect.asset.type}
              </strong>
            </div>
            <button
              type="button"
              className="mini-action is-muted"
              onClick={onClearInspect}
            >
              关闭
            </button>
          </div>
          {isMarkdownContent(inspect.content) ? (
            <>
              <div className="inspect-source">
                {inspect.content.title || inspect.content.final_url}
              </div>
              <pre>{inspect.content.markdown.slice(0, 900)}</pre>
              {inspect.content.truncated ? (
                <div className="inspect-foot">正文已截断</div>
              ) : null}
            </>
          ) : (
            <>
              <img
                className="inspect-image"
                src={renderUrlForBrowser(inspect.content.url)}
                alt={`#${inspect.asset.display_no} 高清合成图`}
              />
              <div className="inspect-image-meta">
                <span>
                  {inspect.content.width}×{inspect.content.height}px
                </span>
                <span>
                  合成笔迹 {inspect.content.overlaid_strokes.length} 条
                </span>
                <code>{inspect.content.url.split("/").at(-1)}</code>
              </div>
            </>
          )}
          {inspect.warnings.length > 0 ? (
            <div className="inspect-warning">
              {inspect.warnings.map((warning) => warning.message).join(" · ")}
            </div>
          ) : null}
        </section>
      ) : (
        <div className="panel-footnote">
          Inspect 按需读取高清原图或网页 Markdown
        </div>
      )}

      {assets.length > 0 ? (
        <section className="asset-manifest">
          <div className="asset-manifest-heading">
            <span className="panel-kicker">L1 Asset Manifest</span>
            <button
              className="mini-action"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    assets
                      .map(
                        (a) =>
                          `#${a.display_no} ${a.type.toUpperCase()} ${a.title}`,
                      )
                      .join("\n"),
                  );
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "已复制" : "复制 Manifest"}
            </button>
          </div>
          <pre>
            {assets
              .map(
                (asset) =>
                  `#${asset.display_no} ${asset.type.toUpperCase()} ` +
                  `(${asset.rect.x},${asset.rect.y},${asset.rect.w},${asset.rect.h})`,
              )
              .join("\n")}
          </pre>
        </section>
      ) : null}
    </aside>
  );
}
