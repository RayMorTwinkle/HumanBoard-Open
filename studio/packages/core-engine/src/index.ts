export * from "./domain/errors";
export * from "./domain/model-provider";
export * from "./domain/ports";
export * from "./domain/types";
export {
  SCENE_MIN_VIEWPORT,
  SCENE_PADDING,
  computeSceneBounds,
  computeScenesBounds,
  renderSceneToSVG,
} from "./render/scene-svg";
export type {
  Bounds,
  RenderSceneOptions,
  SceneBoundsOptions,
} from "./render/scene-svg";
export { computeDiffBoxes, renderDiffToSVGs } from "./render/scene-diff-svg";
export type {
  DiffSVGs,
  RenderDiffOptions,
  SceneDiffBox,
} from "./render/scene-diff-svg";
export {
  renderDiffToPNGs,
  renderSceneToPNG,
  renderDiffToPNGsAsync,
  renderSceneToPNGAsync,
} from "./render/scene-png";
export type { DiffPNGs } from "./render/scene-png";
export {
  renderInspectCompositePNG,
  renderInspectOverlay,
  renderInspectOverlayPNG,
} from "./render/inspect-overlay";
export type { InspectOverlayOptions } from "./render/inspect-overlay";
export * from "./services/asset-ingest-service";
export * from "./services/agent-service";
export * from "./services/draft-service";
export * from "./services/layer-visibility";
export * from "./services/scene-assets";
export * from "./services/scene-diff-service";
export * from "./services/scene-patch-service";
export * from "./services/sync-service";
export * from "./services/title-service";
export * from "./storage/memory-storage-adapter";
export * from "./storage/blob-adapter";
export * from "./storage/local-blob-adapter";
export * from "./storage/sqlite/schema";
export * from "./storage/sqlite/sqlite-storage-adapter";
export * from "./storage/storage-adapter";

export { SCENE_CONTRACT } from "./agent/scene-contract";
export { lintScene, type SceneWarning } from "./services/scene-lint";

export * from "./services/space-visibility";

export { RevisionService } from "./revisions/service";
