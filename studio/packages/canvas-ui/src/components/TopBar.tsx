import {
  BrandMark,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SunIcon,
} from "./icons";
import { applyTheme, useTheme } from "../theme";

import type { ConnectionState } from "../store/useBoardStore";
import type { GetData, StatusData } from "../client/types";

interface TopBarProps {
  readonly status: StatusData | null;
  readonly currentLayer: GetData | null;
  readonly connection: ConnectionState;
  readonly leftPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly agentPanelOpen: boolean;
  readonly onToggleLeftPanel: () => void;
  readonly onToggleRightPanel: () => void;
  readonly onToggleAgentPanel: () => void;
  readonly onOpenLayers: () => void;
  readonly onRefresh: () => void;
  readonly onOpenSpaces: () => void;
  readonly newLayers: number;
  /** A Space was added, or gained layers, somewhere else. */
  readonly spacesNotice?: boolean;
}

export function TopBar({
  status,
  currentLayer,
  connection,
  leftPanelOpen,
  rightPanelOpen,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenLayers,
  onRefresh,
  onOpenSpaces,
  newLayers,
  spacesNotice = false,
}: TopBarProps) {
  const connected = connection === "connected";
  const theme = useTheme();
  return (
    <header className="topbar">
      <div className="header-island project-island">
        <BrandMark className="brand-mark" />
        <div className="project-crumb">
          <span>{status?.project.name ?? "HumanBoard"}</span>
          <i>/</i>
          <button className="space-name" onClick={onOpenSpaces}>
            {status?.space.name ?? "连接中"}
            <small>⌄</small>
          </button>
        </div>
        <button
          className={`active-chip ${newLayers ? "has-news" : ""}`}
          onClick={onOpenLayers}
          title={
            newLayers
              ? `有 ${newLayers} 个新层`
              : currentLayer?.layer.title || "打开 Layers"
          }
          aria-label={
            newLayers
              ? `打开 Layers 面板，有 ${newLayers} 个新层`
              : "打开 Layers 面板"
          }
        >
          <span>{currentLayer?.layer.short_id ?? "L–"}</span>
          <small>正在看</small>
          {newLayers > 0 && <i key={newLayers}>{newLayers}</i>}
        </button>
        <span className="island-divider" />
        <button
          className={`icon-button ${leftPanelOpen ? "is-on" : ""}`}
          onClick={onToggleLeftPanel}
          aria-label={leftPanelOpen ? "收起 Agent 面板" : "打开 Agent 面板"}
          aria-pressed={leftPanelOpen}
        >
          <PanelLeftIcon />
        </button>
      </div>
      <div className="header-island actions-island">
        <button
          className={`connection-chip ${connected ? "is-online" : "is-offline"}`}
          onClick={onRefresh}
          title="刷新服务连接"
        >
          <span className="connection-dot" />
          <b>{connected ? "已连接" : "连接中"}</b>
        </button>
        <button
          className={`icon-button ${rightPanelOpen ? "is-on" : ""}`}
          onClick={onToggleRightPanel}
          aria-label={rightPanelOpen ? "收起资料面板" : "展开资料面板"}
          aria-pressed={rightPanelOpen}
        >
          <PanelRightIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"}
          title={theme === "dark" ? "切换到浅色" : "切换到深色"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        {status && (
          <a
            className="spaces-button"
            href={`?${new URLSearchParams({ view: "studio", project: status.project.id, space: status.space.id })}`}
          >
            版本画板
          </a>
        )}
        <span className="island-divider" />
        <button
          className={`spaces-button ${spacesNotice ? "has-news" : ""}`}
          onClick={onOpenSpaces}
          aria-label={spacesNotice ? "Spaces，有新的变化" : undefined}
        >
          Spaces <small>{status?.spaces.length ?? 0}</small>
          {spacesNotice && <i />}
        </button>
      </div>
    </header>
  );
}
