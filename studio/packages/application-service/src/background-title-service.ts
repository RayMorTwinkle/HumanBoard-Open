import type {
  Asset,
  Layer,
  ModelProvider,
  TitleTaskResult,
} from "@humanboard/core-engine";

import type { PublicModelConfiguration } from "./model-provider";
import type { LocalAppService } from "./local-app-service";

type TitleTaskKind = "layer" | "image";
type TitleTaskOutcome = "completed" | "failed" | "skipped";

export interface BackgroundTitleEvent {
  readonly task: TitleTaskKind;
  readonly target_id: string;
  readonly status: TitleTaskOutcome;
  readonly title?: string;
  readonly reason?: string;
  readonly at: string;
}

export interface BackgroundTitleStatus {
  readonly enabled: boolean;
  readonly vision: {
    readonly configured: boolean;
    readonly model: string | null;
    readonly missing_env: readonly string[];
  };
  readonly text: {
    readonly configured: boolean;
    readonly model: string | null;
    readonly missing_env: readonly string[];
  };
  readonly queue: {
    readonly pending: number;
    readonly running: boolean;
    readonly completed: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly recent: readonly BackgroundTitleEvent[];
}

export interface BackgroundTitleServiceOptions {
  readonly enabled: boolean;
  readonly configuration: PublicModelConfiguration;
  readonly visionProvider?: ModelProvider;
  readonly textProvider?: ModelProvider;
}

interface QueuedTitleTask {
  readonly kind: TitleTaskKind;
  readonly targetId: string;
  readonly run: () => Promise<TitleTaskResult>;
}

const RECENT_EVENT_LIMIT = 20;

export function autoTitleEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = env.HUMAN_AUTO_TITLE?.trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(value ?? "");
}

export class BackgroundTitleService {
  private enabled: boolean;
  private configuration: PublicModelConfiguration;
  private visionProvider?: ModelProvider;
  private textProvider?: ModelProvider;
  private readonly queue: QueuedTitleTask[] = [];
  private readonly scheduled = new Set<string>();
  private readonly retryable = new Set<string>();
  private readonly recent: BackgroundTitleEvent[] = [];
  private running = false;
  private readonly activeAttempts = new Set<Promise<void>>();
  private completed = 0;
  private skipped = 0;
  private failed = 0;

  constructor(options: BackgroundTitleServiceOptions) {
    this.enabled = options.enabled;
    this.configuration = options.configuration;
    this.visionProvider = options.visionProvider;
    this.textProvider = options.textProvider;
  }

  setModels(
    configuration: PublicModelConfiguration,
    visionProvider?: ModelProvider,
    textProvider?: ModelProvider,
  ): void {
    for (const key of this.retryable) this.scheduled.delete(key);
    this.retryable.clear();
    this.configuration = configuration;
    this.visionProvider = visionProvider;
    this.textProvider = textProvider;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      for (const task of this.queue)
        this.scheduled.delete(
          `${task.kind === "image" ? "image" : "layer"}:${task.targetId}`,
        );
      this.queue.length = 0;
    }
  }

  scheduleAssets(service: LocalAppService, assets: readonly Asset[]): void {
    for (const asset of assets) {
      if (
        asset.type !== "image" ||
        asset.title.length > 0 ||
        asset.title_source !== "pending"
      ) {
        continue;
      }
      if (!this.enabled) {
        this.recordSkipped("image", asset.asset_id, "auto_title_disabled");
        continue;
      }
      const key = `image:${asset.asset_id}`;
      if (this.scheduled.has(key)) {
        continue;
      }
      this.scheduled.add(key);
      if (!this.enabled || this.visionProvider === undefined) {
        this.recordSkipped(
          "image",
          asset.asset_id,
          this.enabled ? "model_unconfigured" : "auto_title_disabled",
        );
        continue;
      }
      const provider = this.visionProvider;
      this.enqueue({
        kind: "image",
        targetId: asset.asset_id,
        run: () =>
          service.getTitleService().titleImageAsset(asset.asset_id, provider),
      });
    }
  }

  async attemptLayerTitle(
    service: LocalAppService,
    layer: Layer,
    timeoutMs = 3000,
  ): Promise<void> {
    const key = `layer:${layer.id}`;
    if (
      !this.enabled ||
      !this.textProvider ||
      layer.title_source !== "pending" ||
      this.scheduled.has(key)
    )
      return;
    this.scheduled.add(key);
    const task = service
      .getTitleService()
      .titleLayer(layer.id, this.textProvider)
      .then((result) => {
        if (result.status === "updated") this.completed++;
        else this.skipped++;
        this.record({
          task: "layer",
          target_id: layer.id,
          status: result.status === "updated" ? "completed" : "skipped",
          ...(result.title ? { title: result.title } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          at: new Date().toISOString(),
        });
      })
      .catch((error) => {
        this.failed++;
        this.retryable.add(key);
        this.record({
          task: "layer",
          target_id: layer.id,
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        });
      });
    const tracked = task.finally(() => this.activeAttempts.delete(tracked));
    this.activeAttempts.add(tracked);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        tracked,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  scheduleLayer(service: LocalAppService, layer: Layer): void {
    if (!this.enabled) {
      this.recordSkipped("layer", layer.id, "auto_title_disabled");
      return;
    }
    const key = `layer:${layer.id}`;
    if (this.scheduled.has(key)) {
      return;
    }
    this.scheduled.add(key);
    if (!this.enabled || this.textProvider === undefined) {
      this.recordSkipped(
        "layer",
        layer.id,
        this.enabled ? "model_unconfigured" : "auto_title_disabled",
      );
      return;
    }
    const provider = this.textProvider;
    this.enqueue({
      kind: "layer",
      targetId: layer.id,
      run: () => service.getTitleService().titleLayer(layer.id, provider),
    });
  }

  async scheduleCommitted(
    service: LocalAppService,
    layer: Layer,
  ): Promise<void> {
    if (layer.title.length === 0 && layer.title_source === "pending") {
      this.scheduleLayer(service, layer);
    }
    const assetIds = await service
      .getTitleService()
      .pendingImageAssetIds(layer.id);
    if (assetIds.length === 0) {
      return;
    }
    const assets = await Promise.all(
      assetIds.map((assetId) => service.getAsset(assetId)),
    );
    this.scheduleAssets(
      service,
      assets.filter((asset): asset is Asset => asset !== null),
    );
  }

  status(): BackgroundTitleStatus {
    return {
      enabled: this.enabled,
      vision: {
        configured: this.configuration.vision.configured,
        model: this.configuration.vision.model,
        missing_env: this.configuration.vision.missing_env,
      },
      text: {
        configured: this.configuration.text.configured,
        model: this.configuration.text.model,
        missing_env: this.configuration.text.missing_env,
      },
      queue: {
        pending: this.queue.length,
        running: this.running || this.activeAttempts.size > 0,
        completed: this.completed,
        skipped: this.skipped,
        failed: this.failed,
      },
      recent: [...this.recent],
    };
  }

  async waitForIdle(): Promise<void> {
    while (
      this.running ||
      this.queue.length > 0 ||
      this.activeAttempts.size > 0
    ) {
      await Bun.sleep(10);
    }
  }

  private enqueue(task: QueuedTitleTask): void {
    this.queue.push(task);
    if (!this.running) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          const result = await task.run();
          if (result.status === "updated") {
            this.completed += 1;
            this.record({
              task: task.kind,
              target_id: task.targetId,
              status: "completed",
              title: result.title,
              at: new Date().toISOString(),
            });
          } else {
            this.skipped += 1;
            this.record({
              task: task.kind,
              target_id: task.targetId,
              status: "skipped",
              reason: result.reason ?? result.status,
              at: new Date().toISOString(),
            });
          }
        } catch (error) {
          this.failed += 1;
          this.retryable.add(`${task.kind}:${task.targetId}`);
          this.record({
            task: task.kind,
            target_id: task.targetId,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private recordSkipped(
    task: TitleTaskKind,
    targetId: string,
    reason: string,
  ): void {
    if (reason === "model_unconfigured")
      this.retryable.add(`${task === "image" ? "image" : "layer"}:${targetId}`);
    this.skipped += 1;
    this.record({
      task,
      target_id: targetId,
      status: "skipped",
      reason,
      at: new Date().toISOString(),
    });
  }

  private record(event: BackgroundTitleEvent): void {
    this.recent.push(event);
    if (this.recent.length > RECENT_EVENT_LIMIT) {
      this.recent.splice(0, this.recent.length - RECENT_EVENT_LIMIT);
    }
  }
}
