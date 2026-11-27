import { randomUUID } from "node:crypto";

import { HumanBoardError } from "@humanboard/core-engine";
import type { Scene } from "@humanboard/schema";

export interface FrontendRegistrationInput {
  readonly project_id: string;
  readonly space_id: string;
}

export interface FrontendRegistration {
  readonly session_id: string;
  readonly heartbeat_ms: number;
}

export interface FrontendCaptureRequest {
  readonly request_id: string;
  readonly timeout_ms: number;
}

export interface FrontendCapturePayload {
  readonly based_on_layer: string;
  readonly based_on_seq: number;
  readonly scene: Scene;
  readonly layer: Readonly<Record<string, unknown>>;
  readonly assets: readonly unknown[];
  readonly has_uncommitted: boolean;
  readonly uncommitted: Readonly<Record<string, unknown>>;
  readonly captured_at: string;
}

export interface CaptureScope {
  readonly projectId?: string;
  readonly spaceId?: string;
  readonly timeoutMs?: number;
}

interface SessionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly spaceId: string;
  lastSeenAt: number;
  queue: FrontendCaptureRequest[];
  waiter: {
    readonly resolve: (request: FrontendCaptureRequest | null) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null;
}

interface PendingCapture {
  readonly sessionId: string;
  readonly resolve: (payload: FrontendCapturePayload) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const SESSION_TTL_MS = 60_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2_000;

export class FrontendSessionHub {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pending = new Map<string, PendingCapture>();

  register(input: FrontendRegistrationInput): FrontendRegistration {
    this.prune();
    const session: SessionRecord = {
      id: randomUUID(),
      projectId: input.project_id,
      spaceId: input.space_id,
      lastSeenAt: Date.now(),
      queue: [],
      waiter: null,
    };
    this.sessions.set(session.id, session);
    return { session_id: session.id, heartbeat_ms: 5_000 };
  }

  touch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.lastSeenAt = Date.now();
    return true;
  }

  async waitForRequest(
    sessionId: string,
    timeoutMs = 25_000,
  ): Promise<FrontendCaptureRequest | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new HumanBoardError(
        "E_LIVE_UNAVAILABLE",
        "Frontend session is not registered",
        { session_id: sessionId },
      );
    }
    session.lastSeenAt = Date.now();
    const queued = session.queue.shift();
    if (queued) {
      return queued;
    }
    if (session.waiter) {
      clearTimeout(session.waiter.timer);
      session.waiter.resolve(null);
      session.waiter = null;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (session.waiter?.timer === timer) {
          session.waiter = null;
        }
        resolve(null);
      }, timeoutMs);
      session.waiter = { resolve, timer };
    });
  }

  async requestCapture(
    scope: CaptureScope = {},
  ): Promise<FrontendCapturePayload> {
    this.prune();
    const now = Date.now();
    const candidates = [...this.sessions.values()]
      .filter(
        (session) =>
          now - session.lastSeenAt <= SESSION_TTL_MS &&
          (scope.projectId === undefined ||
            session.projectId === scope.projectId) &&
          (scope.spaceId === undefined || session.spaceId === scope.spaceId),
      )
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    const session = candidates[0];
    if (!session) {
      throw new HumanBoardError(
        "E_LIVE_UNAVAILABLE",
        "No frontend real-time view is connected",
        {
          feature: "capture",
          reason: "frontend_not_connected",
          ...(scope.projectId === undefined
            ? {}
            : { project_id: scope.projectId }),
          ...(scope.spaceId === undefined ? {} : { space_id: scope.spaceId }),
        },
      );
    }

    const timeoutMs = scope.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    const request: FrontendCaptureRequest = {
      request_id: randomUUID(),
      timeout_ms: timeoutMs,
    };
    session.lastSeenAt = now;

    const response = new Promise<FrontendCapturePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.request_id);
        session.queue = session.queue.filter(
          (item) => item.request_id !== request.request_id,
        );
        reject(
          new HumanBoardError(
            "E_LIVE_UNAVAILABLE",
            "Frontend did not respond to the capture request",
            {
              feature: "capture",
              reason: "frontend_timeout",
              session_id: session.id,
              request_id: request.request_id,
              timeout_ms: timeoutMs,
            },
          ),
        );
      }, timeoutMs);
      this.pending.set(request.request_id, {
        sessionId: session.id,
        resolve,
        reject,
        timer,
      });
    });

    if (session.waiter) {
      const waiter = session.waiter;
      session.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(request);
    } else {
      session.queue.push(request);
    }
    return response;
  }

  respond(
    sessionId: string,
    requestId: string,
    payload: FrontendCapturePayload,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new HumanBoardError(
        "E_USAGE",
        "Capture response does not match a pending request",
        { session_id: sessionId, request_id: requestId },
      );
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(payload);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  private prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [sessionId, session] of this.sessions) {
      if (
        session.lastSeenAt < cutoff &&
        session.waiter === null &&
        session.queue.length === 0
      ) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
