import { isSpaceDeleted } from "./space-visibility";
import { validateSceneAssetRefs } from "./scene-assets";
import { lintScene } from "./scene-lint";
import {
  SceneSchema,
  canonicalJson,
  sceneContentHash,
  type Scene,
} from "@humanboard/schema";
import { HUMANBOARD_SYSTEM_PROMPT } from "../agent/system-prompt";
import {
  AgentToolRegistry,
  defineAgentTool,
  type AgentToolResult,
} from "../agent/tool-registry";
import { renderSceneToPNG, renderDiffToPNGs } from "../render/scene-png";
import { HumanBoardError } from "../domain/errors";
import type { ModelChatMessage, ModelProvider } from "../domain/model-provider";
import type { Clock, IdGenerator } from "../domain/ports";
import { SystemClock, UlidGenerator } from "../domain/ports";
import type {
  AgentMessage,
  AgentSession,
  AgentToolTrace,
  Asset,
  Draft,
  Layer,
  LayerKind,
  ScenePatch,
  ULID,
} from "../domain/types";
import { listVisibleLayers } from "./layer-visibility";
import type { StorageAdapter } from "../storage/storage-adapter";
import { MAX_TITLE_CODE_POINTS, type DraftService } from "./draft-service";
import { ScenePatchService } from "./scene-patch-service";
import type { SceneDiffResult, SceneDiffService } from "./scene-diff-service";

// Source compatibility: the old update tool now means stage a private draft, never auto-commit.
export const AGENT_CANVAS_TOOL_NAME = "humanboard_draft";
export interface AgentChatRequest {
  readonly projectId: ULID;
  readonly spaceId: ULID;
  readonly message: string;
  readonly baseLayerId?: ULID;
}
export interface AgentUrlPage {
  readonly title: string;
  readonly markdown: string;
  readonly fetched_at: string;
  readonly truncated: boolean;
}
export type AgentUrlContentProvider = (url: string) => Promise<AgentUrlPage>;
export interface AgentChatDiff extends SceneDiffResult {
  readonly base_layer_id: ULID;
  readonly result_layer_id: ULID;
}
export interface AgentInputSnapshot {
  readonly layer_id: ULID;
  readonly content_hash: string;
}
export interface AgentCapturedView {
  readonly based_on_layer: string;
  readonly scene: Scene;
  readonly has_uncommitted: boolean;
  readonly captured_at: string;
  readonly uncommitted?: unknown;
}
export interface AgentChatResult {
  readonly input_snapshot?: AgentInputSnapshot;
  readonly session_id: ULID;
  readonly message_id: ULID;
  readonly assistant_message: string;
  readonly base_layer_id: ULID;
  readonly result_layer_id: ULID | null;
  readonly kind: LayerKind | null;
  readonly title: string | null;
  readonly diff: AgentChatDiff | null;
  readonly tool_trace: readonly AgentToolTrace[];
  readonly status: "completed" | "cancelled" | "limited" | "failed";
}
export interface AgentHistoryResult {
  readonly session_id: ULID | null;
  readonly messages: readonly AgentMessage[];
}
export interface AgentRunStatus {
  readonly reasoning_steps: readonly { step: number; content: string }[];
  readonly partial_message: string;
  readonly run_id: string;
  readonly phase: "thinking" | "tool";
  readonly step: number;
  readonly tool_trace: readonly AgentToolTrace[];
}
export interface AgentServiceOptions {
  readonly storage: StorageAdapter;
  readonly drafts: DraftService;
  readonly diffs: SceneDiffService;
  readonly provider: ModelProvider;
  readonly urlContentProvider?: AgentUrlContentProvider;
  readonly captureView?: (scope: {
    projectId: string;
    spaceId: string;
    signal: AbortSignal;
  }) => Promise<AgentCapturedView>;
  readonly inspectAsset?: (
    asset: Asset,
    layer: Layer,
    liveScene?: Scene,
  ) => Promise<AgentToolResult>;
  readonly renderContext?: (scene: Scene) => Promise<Uint8Array>;
  readonly renderDiff?: (
    base: Scene,
    target: Scene,
  ) => Promise<{
    before: Uint8Array;
    after: Uint8Array;
    highlight: Uint8Array;
  }>;
  readonly onCommitted?: (
    layer: Layer,
    diff: AgentChatDiff,
  ) => Promise<void> | void;
  readonly maxSteps?: number;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}
interface ToolContext {
  readonly request: AgentChatRequest;
  readonly sessionId: string;
  readonly base: Layer;
  readonly signal: AbortSignal;
  step: number;
  draft: Draft | null;
  capture?: { layer: Layer; scene: Scene; snapshot: AgentInputSnapshot };
  inputSnapshot?: AgentInputSnapshot;
  previewHash?: string;
  previewStep?: number;
  committed: Layer | null;
  diff: AgentChatDiff | null;
}
interface ActiveRun {
  reasoningSteps: { step: number; content: string }[];
  partialMessage: string;
  done?: Promise<AgentChatResult>;
  readonly controller: AbortController;
  readonly runId: string;
  phase: "thinking" | "tool";
  step: number;
  readonly trace: AgentToolTrace[];
}
const toolError = (message: string) => new HumanBoardError("E_USAGE", message);
function untrustedJson(value: unknown): string {
  return canonicalJson(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
function imagePart(png: Uint8Array) {
  return {
    type: "image_url" as const,
    image_url: {
      url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    },
  };
}
function sceneIndex(scene: Scene) {
  return {
    ...(scene.diagram ? {diagram:scene.diagram,assets:scene.assets} : scene),
    strokes: scene.strokes.map(({ points, ...stroke }) => ({
      ...stroke,
      point_count: points.length,
    })),
  };
}
export function buildAgentPrompt(input: {
  message: string;
  history: readonly AgentMessage[];
  layer: Layer;
  projectId?: string;
  spaceId?: string;
}): readonly ModelChatMessage[] {
  return [
    { role: "system", content: HUMANBOARD_SYSTEM_PROMPT },
    ...input.history
      .slice(-20)
      .map((m): ModelChatMessage => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `${input.message}\n\n<untrusted_board_context>\n${untrustedJson({ project_id: input.projectId, space_id: input.spaceId ?? input.layer.space_id, base_layer_id: input.layer.id })}\n</untrusted_board_context>`,
    },
  ];
}
export class AgentService {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly render: (scene: Scene) => Promise<Uint8Array>;
  private readonly patches: ScenePatchService;
  private readonly tools: AgentToolRegistry<ToolContext>;
  private readonly maxSteps: number;
  constructor(private readonly options: AgentServiceOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new UlidGenerator(this.clock);
    this.render =
      options.renderContext ?? (async (scene) => renderSceneToPNG(scene));
    this.patches = new ScenePatchService({
      storage: options.storage,
      clock: this.clock,
      ids: this.ids,
    });
    this.maxSteps = options.maxSteps ?? 16;
    if (
      !Number.isInteger(this.maxSteps) ||
      this.maxSteps < 2 ||
      this.maxSteps > 64
    )
      throw toolError("maxSteps must be 2..64");
    this.tools = this.registerTools();
  }
  status(projectId: string, spaceId: string): AgentRunStatus | null {
    const run = this.runs.get(`${projectId}:${spaceId}`);
    return run
      ? {
          run_id: run.runId,
          partial_message: run.partialMessage,
          reasoning_steps: structuredClone(run.reasoningSteps),
          phase: run.phase,
          step: run.step,
          tool_trace: structuredClone(run.trace),
        }
      : null;
  }
  cancel(projectId: string, spaceId: string): { cancelled: boolean } {
    const run = this.runs.get(`${projectId}:${spaceId}`);
    if (run) run.controller.abort();
    return { cancelled: !!run };
  }
  async chat(input: AgentChatRequest): Promise<AgentChatResult> {
    const key = `${input.projectId}:${input.spaceId}`;
    if (this.runs.has(key))
      throw toolError("An Agent round is already running in this Space");
    if (!input.message.trim())
      throw toolError("Agent message must not be empty");
    const provider =
      this.options.provider.snapshot?.() ?? this.options.provider;
    const run: ActiveRun = {
      partialMessage: "",
      reasoningSteps: [],
      controller: new AbortController(),
      runId: this.ids.next(),
      phase: "thinking",
      step: 0,
      trace: [],
    };
    this.runs.set(key, run);
    try {
      run.done = this.run(input, run, provider);
      return await run.done;
    } finally {
      this.runs.delete(key);
    }
  }
  async stop(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map((run) => run.done));
  }
  private async run(
    input: AgentChatRequest,
    run: ActiveRun,
    provider: ModelProvider,
  ): Promise<AgentChatResult> {
    const { storage } = this.options;
    const project = await storage.getProject(input.projectId);
    if (!project)
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        "Project does not exist",
      );
    const space = await storage.getSpace(input.spaceId);
    if (!space || space.project_id !== project.id)
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        "Space does not exist in Project",
      );
    if (await isSpaceDeleted(storage, space.id))
      throw new HumanBoardError(
        "E_SPACE_DELETED",
        "Restore the deleted Space before starting an Agent.",
      );
    const id = input.baseLayerId ?? space.active_layer_id;
    if (!id)
      throw new HumanBoardError(
        "E_NO_ACTIVE_VIEW",
        "Agent requires an active or explicit base Layer",
      );
    const base = await this.layer(id, input.spaceId);
    const session = await this.ensureSession(project.id, space.id);
    const history = await storage.listAgentMessages(session.id);
    const messages = [
      ...buildAgentPrompt({
        message: input.message,
        history,
        layer: base,
        projectId: project.id,
        spaceId: space.id,
      }),
    ];
    const previousResult = [...history]
      .reverse()
      .find((m) => m.result_layer_id)?.result_layer_id;
    if (previousResult && !(await this.isDescendant(base.id, previousResult)))
      messages[0] = {
        role: "system",
        content: `${HUMANBOARD_SYSTEM_PROMPT}\nBRANCH SWITCH: Current base ${base.id} is not a descendant of previous result ${previousResult}. Explain this and use the current board.`,
      };
    const ctx: ToolContext = {
      request: input,
      base,
      sessionId: `agent:${session.id}:${run.runId}`,
      signal: run.controller.signal,
      step: 0,
      draft: null,
      committed: null,
      diff: null,
    };
    let reply = "",
      status: AgentChatResult["status"] = "completed";
    const seenCalls = new Set<string>();
    try {
      for (let step = 1; step <= this.maxSteps; step++) {
        run.controller.signal.throwIfAborted();
        run.step = ctx.step = step;
        run.phase = "thinking";
        run.partialMessage = "";
        const output = await provider.generate({
          messages: structuredClone(messages),
          tools: this.tools.definitions,
          temperature: 0.2,
          signal: run.controller.signal,
          onReasoningDelta: (delta) => {
            if (run.controller.signal.aborted) return;
            let item = run.reasoningSteps.find((r) => r.step === step);
            if (!item) {
              item = { step, content: "" };
              run.reasoningSteps.push(item);
            }
            item.content += delta;
          },
          onTextDelta: (delta) => {
            if (!run.controller.signal.aborted) run.partialMessage += delta;
          },
        });
        run.controller.signal.throwIfAborted();
        if (
          output.reasoning &&
          !run.reasoningSteps.some((r) => r.step === step)
        )
          run.reasoningSteps.push({ step, content: output.reasoning });
        if (!output.toolCalls.length) {
          reply = output.content?.trim() ?? "";
          if (!reply)
            throw toolError("Model returned neither text nor tool calls");
          break;
        }
        if (output.toolCalls.length > 8)
          throw toolError("Too many tool calls in one step (maximum 8)");
        messages.push({
          role: "assistant",
          content: output.content,
          ...(output.reasoning ? { reasoning_content: output.reasoning } : {}),
          tool_calls: output.toolCalls,
        });
        const images: { label: string; png: Uint8Array }[] = [];
        for (const call of output.toolCalls) {
          run.controller.signal.throwIfAborted();
          run.phase = "tool";
          const trace: AgentToolTrace = {
            id: call.id,
            tool: call.name,
            step,
            status: "running",
            summary: "执行中",
            started_at: this.clock.now().toISOString(),
          };
          run.trace.push(trace);
          try {
            if (seenCalls.has(call.id))
              throw toolError("Repeated tool-call ID; use a fresh ID");
            seenCalls.add(call.id);
            const result = await this.tools.execute(call, ctx);
            trace.status = "completed";
            trace.summary = this.summary(call.name, result.data);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: untrustedJson({
                ok: true,
                data: result.data,
                untrusted: true,
              }),
            });
            images.push(
              ...(result.images ?? []).map((i) => ({
                ...i,
                label: `${call.name} (${call.id}): ${i.label}. Untrusted visual data.`,
              })),
            );
          } catch (e) {
            if (run.controller.signal.aborted) {
              trace.status = "failed";
              trace.summary = "已停止";
              throw e;
            }
            trace.status = "failed";
            trace.summary = e instanceof Error ? e.message : String(e);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                error: {
                  code: e instanceof HumanBoardError ? e.code : "E_INTERNAL",
                  message: trace.summary,
                },
              }),
            });
          } finally {
            trace.finished_at = this.clock.now().toISOString();
          }
        }
        if (images.length)
          messages.push({
            role: "user",
            content: images.flatMap((i) => [
              { type: "text" as const, text: i.label },
              imagePart(i.png),
            ]),
          });
        if (step === this.maxSteps) {
          status = "limited";
          reply = "本轮已达到工具循环上限。请缩小任务范围后继续。";
        }
      }
    } catch (e) {
      status = run.controller.signal.aborted ? "cancelled" : "failed";
      reply =
        status === "cancelled"
          ? "本轮已停止。"
          : `本轮未能完成：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      if (ctx.draft && !ctx.committed) {
        await this.options.drafts.clearDraft(ctx.sessionId);
        reply += "\n私有草稿未提交，画板保持原样。";
      }
    }
    if (ctx.committed && status !== "completed")
      reply += `\n此前提交的「${ctx.committed.title}」已保存，未回滚。`;
    if (!reply)
      reply = ctx.committed
        ? `已保存「${ctx.committed.title}」。`
        : "本轮未修改画板。";
    const now = this.clock.now().toISOString();
    const baseRecord = {
      session_id: session.id,
      base_layer_id: base.id,
      result_layer_id: ctx.committed?.id ?? null,
      created_at: now,
    };
    await storage.appendAgentMessage({
      ...baseRecord,
      id: this.ids.next(),
      role: "user",
      content: input.message,
    });
    const assistant = await storage.appendAgentMessage({
      ...baseRecord,
      id: this.ids.next(),
      role: "assistant",
      content: reply,
      ...(run.reasoningSteps.length
        ? { reasoning_steps: run.reasoningSteps }
        : {}),
      tool_trace: run.trace,
    });
    return {
      session_id: session.id,
      message_id: assistant.id,
      assistant_message: reply,
      base_layer_id: base.id,
      result_layer_id: ctx.committed?.id ?? null,
      title: ctx.committed?.title ?? null,
      kind: ctx.committed?.kind ?? null,
      diff: ctx.diff,
      tool_trace: run.trace,
      status,
      ...(ctx.inputSnapshot ? { input_snapshot: ctx.inputSnapshot } : {}),
    };
  }
  private summary(name: string, data: unknown): string {
    const d = data as Record<string, unknown>;
    return name === "humanboard_capture"
      ? "当前画板快照已返回，未保存"
      : name === "humanboard_commit"
        ? `已保存：${d.title}`
        : name === "humanboard_draft"
          ? "私有草稿已生成，预览已返回"
          : name === "humanboard_inspect"
            ? "精读结果已返回"
            : "完成";
  }
  private registerTools(): AgentToolRegistry<ToolContext> {
    const r = new AgentToolRegistry<ToolContext>();
    const str = { type: "string" };
    r.register(
      defineAgentTool(
        "humanboard_capture",
        "Read the human's LIVE board, including unsaved edits. Optional: call only when the current visual view matters. Does not save or move the view. No frontend returns E_LIVE_UNAVAILABLE, never archived content. A later draft may use this snapshot.",
        {},
        [],
        async (_a, c) => {
          if (!this.options.captureView)
            throw new HumanBoardError(
              "E_LIVE_UNAVAILABLE",
              "Live capture adapter is unavailable",
            );
          c.signal.throwIfAborted();
          const captured = await this.options.captureView({
            projectId: c.request.projectId,
            spaceId: c.request.spaceId,
            signal: c.signal,
          });
          c.signal.throwIfAborted();
          const layer = await this.layer(
            captured.based_on_layer,
            c.request.spaceId,
          );
          const scene = SceneSchema.parse(captured.scene);
          await validateSceneAssetRefs(
            this.options.storage,
            scene,
            c.request.spaceId,
          );
          const snapshot = {
            layer_id: layer.id,
            content_hash: sceneContentHash(scene),
          };
          c.capture = { layer, scene, snapshot };
          const assets = (
            await this.options.storage.listAssets(c.request.spaceId)
          ).filter((a) => scene.assets.some((r) => r.asset_id === a.asset_id));
          return {
            data: {
              snapshot_id: this.ids.next(),
              based_on_layer: layer.id,
              has_uncommitted: captured.has_uncommitted,
              captured_at: captured.captured_at,
              uncommitted: captured.uncommitted ?? {},
              scene: sceneIndex(scene),
              assets,
            },
            images: [
              {
                label: "Live view including unsaved human edits",
                png: await this.render(scene),
              },
            ],
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_layers",
        "List this Space's history and topology; does not change the active view.",
        {},
        [],
        async (_a, c) => ({
          data: {
            layers: await listVisibleLayers(
              this.options.storage,
              c.request.spaceId,
            ),
            current: c.base.id,
          },
        }),
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_get",
        "Read a Layer's Scene index and actual image. Default: current turn base; aliases L<n> allowed in this Space.",
        { layer: str },
        [],
        async (a, c) => {
          const layer = await this.layer(
            String(a.layer ?? c.committed?.id ?? c.base.id),
            c.request.spaceId,
          );
          const scene = (await this.options.storage.getLayerScene(layer.id))!;
          return {
            data: { layer, scene: sceneIndex(scene) },
            images: [
              { label: layer.title || layer.id, png: await this.render(scene) },
            ],
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_diff",
        "Compare saved Layers. Pure logic diagrams return structured changes; 3-PNG is automatic only if either layer has strokes. Set visual true to request it, false for structure only. Default: base Layer versus its parent.",
        { base: str, target: str, visual: { type: "boolean" } },
        [],
        async (a, c) => {
          const target = await this.layer(
            String(a.target ?? c.committed?.id ?? c.base.id),
            c.request.spaceId,
          );
          if (!target.parent_id && !a.base)
            throw toolError("Root Layer has no parent; specify base");
          const base = await this.layer(
            String(a.base ?? target.parent_id),
            c.request.spaceId,
          );
          const diff = await this.options.diffs.diffLayers(base.id, target.id);
          const before = (await this.options.storage.getLayerScene(base.id))!;
          const after = (await this.options.storage.getLayerScene(target.id))!;
          const hasStrokes =
            before.strokes.length > 0 || after.strokes.length > 0;
          if (!(a.visual ?? hasStrokes))
            return { data: { ...diff, has_strokes: hasStrokes } };
          const rendered = await this.renderDiff(before, after);
          return {
            data: { ...diff, has_strokes: hasStrokes },
            images: (["before", "after", "highlight"] as const).map(
              (label) => ({ label, png: rendered[label] }),
            ),
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_inspect",
        "Read one #asset at original resolution with local annotations, or its webpage text. Only this Space's registered assets.",
        { asset: str, layer: str },
        ["asset"],
        async (a, c) => {
          const ref = String(a.asset).replace(/^#/, "");
          const asset = (
            await this.options.storage.listAssets(c.request.spaceId)
          ).find((v) => v.asset_id === ref || v.display_no === ref);
          if (!asset)
            throw new HumanBoardError(
              "E_ASSET_NOT_FOUND",
              "Asset is not registered in this Space",
            );
          const layer = await this.layer(
            String(a.layer ?? c.capture?.layer.id ?? c.base.id),
            c.request.spaceId,
          );
          if (this.options.inspectAsset)
            return this.options.inspectAsset(
              asset,
              layer,
              !a.layer && c.capture?.layer.id === layer.id
                ? c.capture.scene
                : undefined,
            );
          if (
            asset.type === "url" &&
            asset.source_url &&
            this.options.urlContentProvider
          ) {
            const page = await this.options.urlContentProvider(
              asset.source_url,
            );
            return {
              data: {
                asset,
                ...page,
                markdown: Array.from(page.markdown).slice(0, 24000).join(""),
                untrusted: true,
              },
            };
          }
          throw toolError("Asset inspection adapter is unavailable");
        },
      ),
    );
    r.register(
      defineAgentTool(
        AGENT_CANVAS_TOOL_NAME,
        "Stage or refine a PRIVATE draft. Returns a rendered image to review before commit. Patches accumulate. Choose kind/basis on first draft. Default basis is the latest captured LIVE snapshot when available, otherwise the saved base. redo uses the previous attempt's parent.",
        {
          patch: { type: "object" },
          scene: { type: "object" },
          kind: { type: "string", enum: ["derive", "transform", "redo"] },
          basis: { type: "string", enum: ["capture", "layer"] },
        },
        [],
        async (a, c) => {
          c.signal.throwIfAborted();
          if (c.committed)
            throw toolError(
              "Already committed in this turn; continue changes in a new user turn",
            );
          if ((a.patch === undefined) === (a.scene === undefined))
            throw toolError("Provide exactly one of patch or scene");
          if (c.draft && a.basis)
            throw toolError(
              "Choose basis only on the first draft; discard to change it",
            );
          if (a.basis === "capture" && !c.capture)
            throw toolError("Call capture first to use its snapshot");
          if (c.draft && a.kind && a.kind !== c.draft.kind)
            throw toolError("Discard this draft before changing kind");
          const patch = a.patch as ScenePatch | undefined;
          if (
            patch?.upsert_assets?.some((v) => "source" in v) ||
            patch?.add_assets?.some((v) => "source" in v)
          )
            throw toolError(
              "Only registered asset references are allowed here; file/URL ingestion is not available",
            );
          let scene = a.scene as Scene | undefined;
          if (patch && c.draft)
            scene = (
              await this.patches.apply({
                baseScene: c.draft.scene,
                patch,
                spaceId: c.request.spaceId,
              })
            ).scene;
          const kind =
            c.draft?.kind ?? (a.kind as LayerKind | undefined) ?? "derive";
          const live =
            !c.draft && kind !== "redo" && a.basis !== "layer"
              ? c.capture
              : undefined;
          const parent = live?.layer ?? c.base;
          if (patch && !c.draft && (kind === "redo" || live)) {
            if (kind === "redo" && !parent.parent_id)
              throw new HumanBoardError(
                "E_REDO_INVALID",
                "Cannot redo a root Layer",
              );
            const patchBase =
              live?.scene ??
              (await this.options.storage.getLayerScene(parent.parent_id!))!;
            scene = (
              await this.patches.apply({
                baseScene: patchBase,
                patch,
                spaceId: c.request.spaceId,
              })
            ).scene;
          }
          const staged = await this.options.drafts.createDraft({
            sessionId: c.sessionId,
            projectId: c.request.projectId,
            spaceId: c.request.spaceId,
            parentId:
              kind === "redo" ? c.base.id : (c.draft?.parent_id ?? parent.id),
            kind,
            ...(scene ? { scene } : { patch }),
            author: { kind: "builtin", name: "humanboard-agent" },
          });
          c.draft = staged.draft;
          if (live) c.inputSnapshot = live.snapshot;
          const png = await this.render(staged.draft.scene);
          c.previewHash = sceneContentHash(staged.draft.scene);
          c.previewStep = c.step;
          return {
            data: {
              draft_id: staged.draft.id,
              kind: staged.draft.kind,
              content_hash: c.previewHash,
              committed: false,
              warnings: lintScene(staged.draft.scene),
            },
            images: [
              {
                label:
                  "PRIVATE DRAFT: review layout and labels; call draft again to fix, or commit in the next step",
                png,
              },
            ],
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_preview",
        "Render the current private draft again without modifying it.",
        {},
        [],
        async (_a, c) => {
          if (!c.draft || c.committed)
            throw new HumanBoardError("E_NO_DRAFT", "No open private draft");
          const png = await this.render(c.draft.scene);
          c.previewHash = sceneContentHash(c.draft.scene);
          c.previewStep = c.step;
          return {
            data: { draft_id: c.draft.id },
            images: [{ label: "Private draft preview", png }],
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_commit",
        "Explicitly save the latest previewed draft as one immutable Layer. Must follow review in a subsequent model step. Does not move the user's view.",
        { title: str },
        ["title"],
        async (a, c) => {
          c.signal.throwIfAborted();
          if (c.committed)
            throw toolError("Already committed; do not commit twice");
          if (!c.draft)
            throw new HumanBoardError(
              "E_NO_DRAFT",
              "Create and review a draft first",
            );
          if (
            c.previewHash !== sceneContentHash(c.draft.scene) ||
            c.previewStep === undefined ||
            c.previewStep >= c.step
          )
            throw toolError(
              "Review the latest preview in the next model step before commit",
            );
          let title = String(a.title).trim();
          if (!title) throw toolError("Commit title must not be empty");
          const prefix =
            c.draft.kind === "transform"
              ? "@转化："
              : c.draft.kind === "redo"
                ? "重做："
                : "";
          if (prefix && !title.startsWith(prefix)) title = prefix + title;
          if (Array.from(title).length > MAX_TITLE_CODE_POINTS)
            throw toolError("Title must have at most 40 characters");
          const committed = await this.options.drafts.commitDraft({
            sessionId: c.sessionId,
            draftId: c.draft.id,
            title,
            titleSource: "agent",
          });
          c.committed = committed.layer;
          const baseId = committed.layer.parent_id ?? c.base.id;
          c.diff = {
            ...(await this.options.diffs.diffLayers(
              baseId,
              committed.layer.id,
            )),
            base_layer_id: baseId,
            result_layer_id: committed.layer.id,
          };
          await this.options.onCommitted?.(committed.layer, c.diff);
          return {
            data: {
              layer_id: committed.layer.id,
              title,
              kind: committed.layer.kind,
              parent_id: committed.layer.parent_id,
              redo_of: committed.layer.redo_of,
              saved: true,
              warnings: committed.warnings,
            },
          };
        },
      ),
    );
    r.register(
      defineAgentTool(
        "humanboard_discard",
        "Discard your private draft; no saved Layer is removed.",
        {},
        [],
        async (_a, c) => {
          if (c.draft && !c.committed)
            await this.options.drafts.clearDraft(c.sessionId);
          c.draft = null;
          c.inputSnapshot = undefined;
          c.previewHash = undefined;
          c.previewStep = undefined;
          return { data: { discarded: true } };
        },
      ),
    );
    return r;
  }
  private async layer(ref: string, spaceId: string): Promise<Layer> {
    const layer = /^L\d+$/.test(ref)
      ? (await listVisibleLayers(this.options.storage, spaceId)).find(
          (l) => l.seq === Number(ref.slice(1)),
        )
      : await this.options.storage.getLayer(ref);
    if (!layer || layer.space_id !== spaceId)
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        "Layer is not in this Space",
      );
    return layer;
  }
  private renderDiff(base: Scene, target: Scene) {
    return (
      this.options.renderDiff?.(base, target) ??
      Promise.resolve(renderDiffToPNGs(base, target))
    );
  }
  private async isDescendant(id: string, ancestor: string): Promise<boolean> {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      if (id === ancestor) return true;
      seen.add(id);
      const l = await this.options.storage.getLayer(id);
      if (!l?.parent_id) return false;
      id = l.parent_id;
    }
    return false;
  }
  async history(projectId: ULID, spaceId: ULID): Promise<AgentHistoryResult> {
    const p = await this.options.storage.getProject(projectId),
      s = await this.options.storage.getSpace(spaceId);
    if (!p)
      throw new HumanBoardError("E_PROJECT_NOT_FOUND", "Project not found");
    if (!s || s.project_id !== projectId)
      throw new HumanBoardError("E_SPACE_NOT_FOUND", "Space not found");
    const session = await this.options.storage.getAgentSession(
      projectId,
      spaceId,
    );
    return {
      session_id: session?.id ?? null,
      messages: session
        ? await this.options.storage.listAgentMessages(session.id)
        : [],
    };
  }
  private async ensureSession(
    projectId: ULID,
    spaceId: ULID,
  ): Promise<AgentSession> {
    const existing = await this.options.storage.getAgentSession(
      projectId,
      spaceId,
    );
    if (existing) return existing;
    const now = this.clock.now().toISOString();
    return this.options.storage.createAgentSession({
      id: this.ids.next(),
      project_id: projectId,
      space_id: spaceId,
      created_at: now,
      updated_at: now,
    });
  }
}
