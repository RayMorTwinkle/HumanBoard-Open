export interface CommitEventDiff {
  readonly mode: string;
  readonly summary: string;
  readonly [key: string]: unknown;
}

export interface CommitEvent {
  readonly event: "layer_committed";
  readonly layer_id: string;
  readonly project_id: string;
  readonly space_id: string;
  readonly seq: number;
  readonly short_id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly title_source: string;
  readonly author: {
    readonly kind: string;
    readonly name?: string;
  };
  readonly diff: CommitEventDiff;
}

export interface CommitEventSubscription {
  readonly sinceSeq?: number;
  readonly all?: boolean;
  readonly projectId?: string;
  readonly spaceId?: string;
}

export type CommitEventListener = (event: CommitEvent) => void;

interface ListenerEntry {
  readonly listener: CommitEventListener;
  readonly all: boolean;
  readonly projectId?: string;
  readonly spaceId?: string;
}

const DEFAULT_HISTORY_LIMIT = 1000;

function matchesScope(
  event: CommitEvent,
  subscription: Pick<CommitEventSubscription, "projectId" | "spaceId">,
): boolean {
  return (
    (subscription.projectId === undefined ||
      event.project_id === subscription.projectId) &&
    (subscription.spaceId === undefined ||
      event.space_id === subscription.spaceId)
  );
}

export class CommitEventBus {
  private readonly listeners = new Set<ListenerEntry>();
  private readonly history: CommitEvent[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = DEFAULT_HISTORY_LIMIT) {
    if (!Number.isInteger(historyLimit) || historyLimit < 0) {
      throw new Error("historyLimit must be a non-negative integer");
    }
    this.historyLimit = historyLimit;
  }

  publish(event: CommitEvent): void {
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    for (const entry of [...this.listeners]) {
      if (
        matchesScope(event, entry) &&
        (entry.all || event.author.kind === "human")
      ) {
        try {
          entry.listener(event);
        } catch {
          // Event delivery must never turn a successful commit into an error.
        }
      }
    }
  }

  subscribe(
    listener: CommitEventListener,
    subscription: CommitEventSubscription = {},
  ): () => void {
    const all = subscription.all ?? false;
    if (subscription.sinceSeq !== undefined) {
      for (const event of this.history) {
        if (
          matchesScope(event, subscription) &&
          event.seq > subscription.sinceSeq &&
          (all || event.author.kind === "human")
        ) {
          try {
            listener(event);
          } catch {
            // Ignore a broken replay consumer; commit persistence is authoritative.
          }
        }
      }
    }
    const entry: ListenerEntry = {
      listener,
      all,
      ...(subscription.projectId === undefined
        ? {}
        : { projectId: subscription.projectId }),
      ...(subscription.spaceId === undefined
        ? {}
        : { spaceId: subscription.spaceId }),
    };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
}
