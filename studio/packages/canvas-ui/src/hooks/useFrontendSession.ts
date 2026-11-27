import { useEffect } from "react";

import {
  HumanBoardClient,
  HumanBoardClientError,
} from "../client/HumanBoardClient";
import { buildFrontendCapturePayload } from "../capture";
import { useBoardStore } from "../store/useBoardStore";

function sessionErrorMessage(error: unknown): string {
  if (error instanceof HumanBoardClientError) {
    return `${error.code} · ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export function useFrontendSession(
  client: HumanBoardClient,
  projectId: string | undefined,
  spaceId: string | undefined,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || projectId === undefined || spaceId === undefined) {
      return;
    }
    let cancelled = false;
    const abort = new AbortController();

    const run = async (): Promise<void> => {
      let sessionId: string | null = null;
      while (!cancelled) {
        try {
          if (sessionId === null) {
            const registration = await client.registerFrontendSession(
              projectId,
              spaceId,
              abort.signal,
            );
            sessionId = registration.session_id;
          }
          const request = await client.waitForCaptureRequest(
            sessionId,
            20_000,
            abort.signal,
          );
          if (cancelled || request === null) {
            continue;
          }
          const state = useBoardStore.getState();
          if (!state.currentLayer) {
            continue;
          }
          const payload = buildFrontendCapturePayload(
            state.currentLayer,
            state.uncommittedStrokes,
            state.workingScene,
            state.registeredAssets,
          );
          await client.respondCapture(
            sessionId,
            request.request_id,
            payload,
            abort.signal,
          );
        } catch (error) {
          if (cancelled || abort.signal.aborted) {
            break;
          }
          useBoardStore.getState().setError(sessionErrorMessage(error));
          sessionId = null;
          await sleep(1000);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [client, enabled, projectId, spaceId]);
}
