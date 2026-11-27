import { SpacesOverview } from "./components/SpacesOverview";
import { useState } from "react";
import { AssetsPanel } from "./components/AssetsPanel";
import { AgentPanel } from "./components/AgentPanel";
import { DiffPreview } from "./components/DiffPreview";
import { CanvasViewport } from "./components/CanvasViewport";
import { LayersPanel } from "./components/LayersPanel";
import { ServiceOffline } from "./components/ServiceOffline";
import { ToolDock } from "./components/ToolDock";
import { TopBar } from "./components/TopBar";
import { UncommittedBar } from "./components/UncommittedBar";
import { countDiffBoxes } from "./diff";
import { useShallow } from "zustand/react/shallow";
import { useBoardStore } from "./store/useBoardStore";
import { useBoardController } from "./hooks/useBoardController";
export function App() {
  // Pan, zoom and tool changes stay out of the shell so the side panels hold still.
  const s = useBoardStore(
      useShallow((x) => ({
        activeLayerId: x.activeLayerId,
        connection: x.connection,
        currentLayer: x.currentLayer,
        diff: x.diff,
        diffImageMode: x.diffImageMode,
        diffView: x.diffView,
        dirty: x.dirty,
        discardStrokes: x.discardStrokes,
        editingLocked: x.editingLocked,
        error: x.error,
        inspect: x.inspect,
        layers: x.layers,
        registeredAssets: x.registeredAssets,
        rightPanelOpen: x.rightPanelOpen,
        setDiff: x.setDiff,
        setDiffImageMode: x.setDiffImageMode,
        setDiffView: x.setDiffView,
        setError: x.setError,
        setInspect: x.setInspect,
        setRightPanelOpen: x.setRightPanelOpen,
        status: x.status,
        toggleRightPanel: x.toggleRightPanel,
        workingScene: x.workingScene,
      })),
    ),
    c = useBoardController();
  const [inspectorTab, setInspectorTab] = useState<"layers" | "assets">(
    "layers",
  );
  const assets = (s.workingScene?.assets ?? []).map((ref) => ({
    ...(s.currentLayer?.assets.find((a) => a.asset_id === ref.asset_id) ??
      s.registeredAssets.find((a) => a.asset_id === ref.asset_id)!),
    ...ref,
  }));
  return (
    <div
      inert={c.spacesOpen}
      className={`app-shell ${c.spacesOpen ? "spaces-visible" : ""} ${c.agentPanelOpen ? "" : "chat-collapsed"} ${s.rightPanelOpen ? "" : "inspector-collapsed"}`}
    >
      <TopBar
        status={s.status}
        currentLayer={s.currentLayer}
        connection={s.connection}
        leftPanelOpen={c.agentPanelOpen}
        rightPanelOpen={s.rightPanelOpen}
        agentPanelOpen={c.agentPanelOpen}
        onToggleLeftPanel={() => c.setAgentPanelOpen(!c.agentPanelOpen)}
        onToggleRightPanel={() => {
          if (
            !s.rightPanelOpen &&
            window.matchMedia("(max-width: 760px)").matches
          )
            c.setAgentPanelOpen(false);
          s.toggleRightPanel();
        }}
        onToggleAgentPanel={() => c.setAgentPanelOpen(!c.agentPanelOpen)}
        onOpenLayers={() => {
          setInspectorTab("layers");
          s.setRightPanelOpen(true);
          if (window.matchMedia("(max-width: 760px)").matches)
            c.setAgentPanelOpen(false);
        }}
        onRefresh={() => void c.load()}
        onOpenSpaces={() => c.setSpacesOpen(true)}
        newLayers={c.newLayers}
        spacesNotice={c.spacesNotice}
      />
      <div className="workspace-grid">
        <CanvasViewport />
        <section className="workspace-inspector" aria-label="画板资料">
          <div className="inspector-heading">
            <div
              className="inspector-tabs"
              role="tablist"
              aria-label="画板资料"
            >
              <button
                role="tab"
                id="layers-tab"
                aria-selected={inspectorTab === "layers"}
                aria-controls="layers-pane"
                onClick={() => setInspectorTab("layers")}
              >
                Layers <span>{s.layers?.layers.length ?? 0}</span>
              </button>
              <button
                role="tab"
                id="assets-tab"
                aria-selected={inspectorTab === "assets"}
                aria-controls="assets-pane"
                onClick={() => setInspectorTab("assets")}
              >
                Assets <span>{assets.length}</span>
              </button>
            </div>
            <button
              className="panel-collapse"
              aria-label="收起资料面板"
              onClick={() => s.setRightPanelOpen(false)}
            >
              ›
            </button>
          </div>
          {c.newLayers > 0 && (
            <button
              className="new-layer-notice"
              onClick={() => {
                setInspectorTab("layers");
                void c.load();
              }}
            >
              有 {c.newLayers} 个新层 · 查看历史
            </button>
          )}
          <div
            id="layers-pane"
            role="tabpanel"
            aria-labelledby="layers-tab"
            hidden={inspectorTab !== "layers"}
          >
            <LayersPanel
              editingLocked={s.editingLocked}
              previews={c.previews}
              onPreview={(id) => void c.preview(id)}
              spaceName={s.status?.space.name}
              layers={s.layers?.layers ?? []}
              freshLayerIds={c.freshLayers}
              activeLayerId={s.activeLayerId}
              currentLayer={s.currentLayer}
              diffPending={c.diffPending}
              onSelect={(id) => void c.select(id)}
              onDiff={(id, visual) => void c.diff(id, visual)}
              onDelete={(id) => void c.deleteLayer(id)}
              onCollapse={() => s.setRightPanelOpen(false)}
            />
          </div>
          <div
            id="assets-pane"
            role="tabpanel"
            aria-labelledby="assets-tab"
            hidden={inspectorTab !== "assets"}
          >
            <AssetsPanel
              autoTitleEnabled={c.agentConfig?.titles?.enabled}
              onToggleAutoTitle={(enabled) => void c.toggleAutoTitle(enabled)}
              projectSync={c.projectSync}
              onToggleSync={(enabled) => void c.toggleProjectSync(enabled)}
              onRename={c.rename}
              assets={assets}
              activeLayerShortId={s.currentLayer?.layer.short_id ?? null}
              inspect={s.inspect}
              onInspect={(id) => void c.inspect(id)}
              onClearInspect={() => s.setInspect(null)}
              onCollapse={() => s.setRightPanelOpen(false)}
            />
          </div>
        </section>
      </div>
      <UncommittedBar
        saving={s.editingLocked}
        onSave={(title) => void c.save(title)}
        onDiscard={s.discardStrokes}
        onTransform={() =>
          void c.send(
            "请看画板图像，将手绘草图转化为结构化逻辑图，保留用户批注并为变化命名。",
          )
        }
        transformAvailable={c.agentConfig?.agent.configured ?? false}
      />
      <ToolDock />
      {s.diff && s.diffView && (
        <DiffPreview
          diff={s.diff}
          mode={s.diffImageMode}
          boxes={countDiffBoxes(s.diff.visual?.boxes ?? [])}
          onMode={s.setDiffImageMode}
          pending={c.diffPending}
          objectNames={Object.fromEntries([
            ...(s.currentLayer?.ast?.nodes ?? []).map((n) => [n.id, n.title]),
            ...(s.currentLayer?.ast?.edges ?? [])
              .filter((e) => e.label)
              .map((e) => [e.id, e.label!]),
            ...assets.map((a) => [a.asset_id, `#${a.display_no} ${a.title}`]),
          ])}
          onVisual={() => void c.diff(s.diff!.target.id, true)}
          onClose={() => {
            s.setDiff(null);
            s.setDiffView(false);
          }}
        />
      )}
      {
        <AgentPanel
          closed={!c.agentPanelOpen}
          projectId={s.status?.project.id}
          spaceId={s.status?.space.id}
          branchNotice={c.branchNotice}
          config={c.agentConfig}
          onSaveModelSettings={c.saveModelSettings}
          messages={c.agentMessages}
          pending={c.agentPending}
          editingLocked={s.editingLocked}
          run={c.agentRun}
          onCancel={() => void c.cancelAgent()}
          onViewLayer={(id) => void c.select(id)}
          onCompare={(id) => void c.diff(id)}
          error={c.agentError}
          rightPanelOpen={s.rightPanelOpen}
          onSend={c.send}
          onClose={() => c.setAgentPanelOpen(false)}
        />
      }
      {s.connection === "connected" && s.error && (
        <div className="error-banner" role="alert">
          <span>{s.error}</span>
          <button onClick={() => s.setError(null)}>关闭</button>
        </div>
      )}
      <ServiceOffline
        connection={s.connection}
        error={s.error}
        onRetry={() => void c.load()}
      />
      <SpacesOverview
        open={c.spacesOpen}
        status={s.status}
        dirty={s.dirty}
        locked={s.editingLocked}
        error={s.error}
        onClose={() => c.setSpacesOpen(false)}
        onSelect={c.switchSpace}
        onCreate={c.createSpace}
        onVisibility={c.changeSpaceVisibility}
        freshSpaces={c.freshSpaces}
      />
    </div>
  );
}
