import { useCallback, useEffect, useRef, useState } from "react";
import type { Scene } from "@humanboard/schema/scene";
import type { RevisionInput } from "@humanboard/schema/revisions";
import type {
  StudioState,
  Review,
} from "../../../core-engine/src/revisions/service";
export type Run = (input: RevisionInput) => Promise<unknown>;
type Draft = { head: string; scene: Scene };
export function useStudio(run: Run, scope: string) {
  const [branch, setBranch] = useState("main"),
    [state, setState] = useState<StudioState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null),
    [review, setReview] = useState<(Review & { sourceBranch?: string }) | null>(
      null,
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false);
  const key = (b: string) => "hb:studio:" + scope + ":" + b;
  const lock = useRef(false),
    epoch = useRef(0),
    active = useRef("main");
  const fetchState = useCallback(
    async (b: string) =>
      (await run({ action: "state", branch: b })) as StudioState,
    [run],
  );
  useEffect(() => {
    let alive = true,
      running = false;
    const poll = async () => {
      if (running || lock.current) return;
      running = true;
      const generation = epoch.current;
      try {
        const next = await fetchState(branch);
        if (
          alive &&
          epoch.current === generation &&
          active.current === branch
        ) {
          setState(next);
          setOffline(false);
        }
      } catch (e) {
        if (alive && epoch.current === generation) {
          setError((e as Error).message);
          setOffline(true);
        }
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) void poll();
    }, 2200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [branch, fetchState]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key(branch));
      setDraft(raw ? JSON.parse(raw) : null);
    } catch {
      setDraft(null);
    }
  }, [branch, scope]);
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  function remember(value: Draft | null, b = branch) {
    setDraft(value);
    try {
      if (value) sessionStorage.setItem(key(b), JSON.stringify(value));
      else sessionStorage.removeItem(key(b));
    } catch {
      setError("浏览器存储已满，草稿仅保留在当前页面。");
    }
  }
  function edit(scene: Scene) {
    if (state && !lock.current) {
      remember({ head: draft?.head ?? state.head, scene });
      setReview(null);
    }
  }
  async function task(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    epoch.current++;
    setBusy(true);
    setError("");
    try {
      await fn();
      setOffline(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function switchTo(b: string) {
    const next = await fetchState(b);
    setReview(null);
    setDraft(null);
    active.current = b;
    setBranch(b);
    setState(next);
  }
  function inspect(source: string, sourceBranch?: string) {
    if (!state || draft) return;
    void task(async () => {
      const r = (await run({
        action: "review",
        branch,
        head: state.head,
        source,
        sourceBranch,
      })) as Review;
      setReview({ ...r, sourceBranch });
    });
  }
  function save() {
    if (!draft) return;
    void task(async () => {
      await run({
        action: "save",
        branch,
        head: draft.head,
        scene: draft.scene,
        title: "编辑协作画板",
      });
      remember(null);
      setState(await fetchState(branch));
    });
  }
  function fork(name: string) {
    if (!state) return;
    void task(async () => {
      await run({
        action: "fork",
        branch: name,
        from: draft?.head ?? state.head,
      });
      if (draft) {
        try {
          sessionStorage.setItem(key(name), JSON.stringify(draft));
        } catch {
          /* Original stays on its branch. */
        }
      }
      await switchTo(name);
      if (draft) remember(draft, name);
    });
  }
  function replay() {
    if (!state || draft) return;
    void task(async () => {
      const proposal = (await run({
        action: "replay",
        branch,
        head: state.head,
      })) as { head: string; branch: string };
      setState(await fetchState(branch));
      const r = (await run({
        action: "review",
        branch,
        head: state.head,
        source: proposal.head,
        sourceBranch: proposal.branch,
      })) as Review;
      setReview({ ...r, sourceBranch: proposal.branch });
    });
  }
  function publish(action: "accept" | "revert") {
    if (!state || draft) return;
    void task(async () => {
      if (action === "accept" && review)
        await run({
          action,
          branch,
          head: review.head,
          source: review.source,
          sourceBranch: review.sourceBranch,
        });
      if (action === "revert") await run({ action, branch, head: state.head });
      setReview(null);
      setState(await fetchState(branch));
    });
  }
  return {
    reportError: setError,
    state,
    branch,
    draft,
    scene: draft?.scene ?? state?.scene,
    review,
    busy,
    error,
    offline,
    edit,
    save,
    fork,
    replay,
    publish,
    inspect,
    stale: !!draft && draft.head !== state?.head,
    closeReview: () => setReview(null),
    dismiss: () => setError(""),
    discard: () => remember(null),
    switchBranch: (b: string) => {
      if (!draft) void task(() => switchTo(b));
    },
  };
}
