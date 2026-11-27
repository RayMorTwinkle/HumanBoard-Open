import { readDraft, removeDraft } from "../draft-storage";
import { browserSceneHash } from "../scene-hash";
import { boardShortcutsBlocked } from "../board-shortcuts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  renderUrlForBrowser,
  HumanBoardClient,
  HumanBoardClientError,
} from "../client/HumanBoardClient";
import type {
  ModelSettingsUpdate,
  DiffData,
  AgentConfigData,
  AgentRunData,
  GetData,
  StatusData,
  ProjectSyncData,
} from "../client/types";
import type { AgentChatMessageView } from "../components/AgentPanel";
import { sceneFromGetData } from "../capture";
import { scenePatch } from "../editor";
import { useBoardStore } from "../store/useBoardStore";
import { useFrontendSession } from "./useFrontendSession";
const message = (e: unknown) =>
  e instanceof HumanBoardClientError
    ? `${e.code} · ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);
function makeClient() {
  let id = sessionStorage.getItem("humanboard:session");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("humanboard:session", id);
  }
  const client = new HumanBoardClient({ sessionId: id });
  try {
    const scope = JSON.parse(
      localStorage.getItem("humanboard:scope") ?? "null",
    );
    if (scope) client.setScope(scope.project, scope.space);
  } catch {}
  return client;
}
export function useBoardController() {
  const client = useMemo(makeClient, []);
  const [agentConfig, setAgentConfig] = useState<AgentConfigData | null>(null),
    [agentMessages, setAgentMessages] = useState<AgentChatMessageView[]>([]),
    [agentError, setAgentError] = useState<string | null>(null),
    [agentPending, setAgentPending] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true),
    [spacesOpen, setSpacesOpen] = useState(false),
    // Layers and Spaces added elsewhere (CLI, MCP, the agent) since the human looked.
    [freshLayers, setFreshLayers] = useState<ReadonlySet<string>>(new Set()),
    [freshSpaces, setFreshSpaces] = useState<
      Readonly<Record<string, "new" | "layers">>
    >({}),
    [spacesSeen, setSpacesSeen] = useState(true);
  const loadComplete = useRef<Promise<void>>(Promise.resolve());
  const loading = useRef(false),
    initial = useRef(true),
    generation = useRef(0);
  const [projectSync, setProjectSync] = useState<ProjectSyncData | null>(null);
  const [agentRun, setAgentRun] = useState<AgentRunData | null>(null);
  const [branchNotice, setBranchNotice] = useState<string | null>(null);
  const lastAgentResult = useRef<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewing = useRef(new Set<string>());
  const ownLayers = useRef(new Set<string>());
  const ownSpaces = useRef(new Set<string>());
  const knownSpaces = useRef<Map<string, number> | null>(null);
  const connection = useBoardStore((s) => s.connection),
    status = useBoardStore((s) => s.status),
    currentLayer = useBoardStore((s) => s.currentLayer);
  const remember = (status: StatusData) => {
    client.setScope(status.project.id, status.space.id);
    try {
      localStorage.setItem(
        "humanboard:scope",
        JSON.stringify({ project: status.project.id, space: status.space.id }),
      );
    } catch {
      /* Restricted browser storage does not block the live board. */
    }
  };
  /** Flags Spaces that appeared, or gained layers, outside the current one. */
  const noticeSpaces = (next: StatusData) => {
    const known = knownSpaces.current;
    knownSpaces.current = new Map(
      next.spaces.map((space) => [space.id, space.layer_count]),
    );
    if (!known) return;
    const fresh: Record<string, "new" | "layers"> = {};
    for (const space of next.spaces) {
      if (space.id === next.space.id || ownSpaces.current.has(space.id))
        continue;
      const before = known.get(space.id);
      if (before === undefined) fresh[space.id] = "new";
      else if (space.layer_count > before) fresh[space.id] = "layers";
    }
    if (!Object.keys(fresh).length) return;
    setFreshSpaces((prev) => {
      const merged = { ...prev };
      // A brand-new Space stays "new" even when its first layers arrive.
      for (const [id, why] of Object.entries(fresh))
        merged[id] = prev[id] === "new" ? "new" : why;
      return merged;
    });
    setSpacesSeen(false);
  };
  const load = useCallback(async (): Promise<boolean> => {
    // A Space transition must await fresh data, not return early behind an old poll.
    if (loading.current) {
      await loadComplete.current;
      return load();
    }
    loading.current = true;
    let release!: () => void;
    loadComplete.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = useBoardStore.getState();
    const version = generation.current;
    try {
      await client.health();
      if (s.connection !== "connected") s.setError(null);
      s.setConnection("connected");
      let next: StatusData;
      try {
        next = await client.status();
      } catch (e) {
        if (
          e instanceof HumanBoardClientError &&
          [
            "E_PROJECT_REQUIRED",
            "E_PROJECT_NOT_FOUND",
            "E_SPACE_NOT_FOUND",
          ].includes(e.code)
        ) {
          client.setScope();
          await client.command(["init"]);
          next = await client.status();
        } else throw e;
      }
      if (version !== generation.current) return false;
      if (next.space.deleted) {
        // A reload starts with dirty=false. Restore local recovery before deciding
        // whether it is safe to leave a Space deleted by another device.
        if (initial.current && !useBoardStore.getState().dirty) {
          const candidates = [
            next.active_layer,
            ...next.layers.map((l) => l.id),
          ];
          const recovery = candidates.find((id) => {
            try {
              return id && readDraft(id) !== null;
            } catch {
              return false;
            }
          });
          if (recovery) {
            const layer = await client.get(recovery, "ast", {
              withStrokes: true,
            });
            if (version !== generation.current) return false;
            s.setBoard({
              status: next,
              currentLayer: layer,
              activeLayerId: recovery,
              layers: {
                space: next.space,
                active_layer: next.active_layer,
                layers: next.layers,
                edges: next.layers
                  .filter((l) => l.parent_id !== null)
                  .map((l) => ({ from: l.parent_id!, to: l.id })),
              },
            });
          }
        }
        if (useBoardStore.getState().dirty) {
          initial.current = false;
          s.setError(
            "当前空间已被删除，未保存编辑仍在本机。请在 Spaces 回收站恢复空间后继续。",
          );
          useBoardStore.setState({ status: next });
          return true;
        }
        const fallback = next.spaces[0];
        if (fallback) {
          client.setScope(next.project.id, fallback.id);
          next = await client.status();
        } else {
          useBoardStore.setState({ status: next });
          s.setError("所有空间均已删除，请在 Spaces 回收站恢复一个空间。");
          return true;
        }
      }
      client.setScope(next.project.id, next.space.id);
      remember(next);
      noticeSpaces(next);
      const layers = await client.layers();
      const wanted = initial.current
        ? new URLSearchParams(location.search).get("layer")
        : null;
      const id =
        (wanted &&
        layers.layers.some((l) => l.id === wanted || l.short_id === wanted)
          ? layers.layers.find((l) => l.id === wanted || l.short_id === wanted)!
              .id
          : null) ??
        (s.activeLayerId && layers.layers.some((l) => l.id === s.activeLayerId)
          ? s.activeLayerId
          : null) ??
        next.active_layer ??
        layers.layers.at(-1)?.id ??
        null;
      const layer = id
        ? s.currentLayer?.layer.id === id && s.currentLayer.assets.length === 0
          ? {
              ...s.currentLayer,
              layer:
                layers.layers.find((l) => l.id === id) ?? s.currentLayer.layer,
            }
          : await client.get(id, "ast", { withStrokes: true })
        : null;
      if (s.layers && s.layers.space.id === layers.space.id) {
        const arrived = layers.layers.filter(
          (l) =>
            !s.layers!.layers.some((old) => old.id === l.id) &&
            l.id !== useBoardStore.getState().activeLayerId &&
            !ownLayers.current.has(l.id),
        );
        if (arrived.length)
          setFreshLayers(
            (prev) => new Set([...prev, ...arrived.map((l) => l.id)]),
          );
      } else setFreshLayers(new Set());
      if (version !== generation.current) return false;
      s.setBoard({
        status: next,
        layers,
        activeLayerId: id,
        currentLayer: layer,
      });
      if (initial.current && id) await client.setActiveLayer(next.space.id, id);
      initial.current = false;
      return true;
    } catch (e) {
      if (version !== generation.current) return false;
      s.setError(message(e));
      if (
        e instanceof HumanBoardClientError &&
        ["E_CONNECT", "E_AUTH"].includes(e.code)
      )
        s.setConnection("offline");
      return false;
    } finally {
      loading.current = false;
      release();
    }
  }, [client]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!useBoardStore.getState().editingLocked) void load();
    }, 2500);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const config = await client.agentConfig();
        if (cancelled) return;
        setAgentConfig(config);
        const projectId = useBoardStore.getState().status?.project.id;
        if (projectId) {
          const sync = await client.projectSync(projectId);
          if (!cancelled) setProjectSync(sync);
        }
        const pending = useBoardStore.getState().registeredAssets;
        if (pending.length) {
          const metadata = await Promise.all(
            pending.map((a) =>
              client.assetMetadata(a.asset_id).catch(() => null),
            ),
          );
          if (!cancelled)
            useBoardStore.setState((s) => ({
              registeredAssets: s.registeredAssets.map((a) => ({
                ...a,
                ...metadata.find((m) => m?.asset_id === a.asset_id),
              })),
            }));
        }
        const board = useBoardStore.getState();
        if (board.status && !board.editingLocked) {
          const scope = board.status,
            version = generation.current;
          const history = await client.agentHistory(
            scope.project.id,
            scope.space.id,
          );
          const current = useBoardStore.getState();
          if (
            !cancelled &&
            version === generation.current &&
            !current.editingLocked &&
            current.status?.space.id === scope.space.id
          ) {
            const next = history.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              tool_trace: m.tool_trace,
              reasoning_steps: m.reasoning_steps,
              result_layer_id: m.result_layer_id,
            }));
            setAgentMessages((old) =>
              JSON.stringify(old) === JSON.stringify(next) ? old : next,
            );
            lastAgentResult.current =
              [...history.messages].reverse().find((m) => m.result_layer_id)
                ?.result_layer_id ?? null;
          }
        }
      } catch (e) {
        if (!cancelled) setAgentError(message(e));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, connection, status?.project.id]);
  useEffect(() => {
    setAgentMessages([]);
    setAgentError(null);
    setBranchNotice(null);
    lastAgentResult.current = null;
    if (!status) return;
    const abort = new AbortController();
    void client
      .agentHistory(status.project.id, status.space.id, abort.signal)
      .then((h) => {
        lastAgentResult.current =
          [...h.messages].reverse().find((m) => m.result_layer_id)
            ?.result_layer_id ?? null;
        setAgentMessages(
          h.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            tool_trace: m.tool_trace,
            reasoning_steps: m.reasoning_steps,
            result_layer_id: m.result_layer_id,
          })),
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted) setAgentError(message(e));
      });
    return () => abort.abort();
  }, [client, status?.project.id, status?.space.id]);
  useFrontendSession(
    client,
    status?.project.id,
    status?.space.id,
    connection === "connected" && currentLayer !== null,
  );
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (useBoardStore.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  const activate = async (id: string) => {
    const s = useBoardStore.getState();
    const layer = await client.get(id, "ast", { withStrokes: true });
    if (s.status) await client.setActiveLayer(s.status.space.id, id);
    s.setActiveLayer(id);
    s.setCurrentLayer(layer);
    setFreshLayers((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    return layer;
  };
  const select = async (id: string) => {
    const s = useBoardStore.getState();
    if (s.editingLocked) return;
    if (s.dirty) {
      s.setError("当前有未提交修改，请先保存或放弃。");
      return;
    }
    generation.current++;
    s.setEditingLocked(true);
    try {
      const selected = await activate(id);
      const previous = lastAgentResult.current;
      if (previous) {
        const nodes = new Map(s.layers?.layers.map((l) => [l.id, l]) ?? []);
        let cursor: string | null = id;
        const visited = new Set<string>();
        while (cursor && cursor !== previous && !visited.has(cursor)) {
          visited.add(cursor);
          cursor = nodes.get(cursor)?.parent_id ?? null;
        }
        setBranchNotice(
          cursor === previous
            ? null
            : `已切到 ${selected.layer.short_id}，与上轮结果 ${nodes.get(previous)?.short_id ?? previous} 不在同一分支。下一轮会以当前画板为准。`,
        );
      }
    } catch (e) {
      s.setError(message(e));
    } finally {
      s.setEditingLocked(false);
    }
  };
  // Call only while holding the editing lock. Commit uses its explicit draft ID.
  const saveLocked = async (title?: string): Promise<GetData | null> => {
    const s = useBoardStore.getState();
    if (!s.currentLayer || !s.dirty || !s.workingScene) return s.currentLayer;
    const draft = await client.draft({
      parent: s.currentLayer.layer.id,
      mergeStdin: JSON.stringify(
        scenePatch(sceneFromGetData(s.currentLayer), s.workingScene),
      ),
    });
    const committed = await client.commit(
      draft.draft_id,
      (title ?? s.commitTitle).trim() || undefined,
    );
    ownLayers.current.add(committed.layer_id);
    try {
      removeDraft(s.currentLayer.layer.id);
    } catch {}
    return activate(committed.layer_id);
  };
  const save = async (title?: string) => {
    const s = useBoardStore.getState();
    if (s.editingLocked) return;
    generation.current++;
    s.setEditingLocked(true);
    s.setError(null);
    try {
      await saveLocked(title);
      await load();
    } catch (e) {
      s.setError(message(e));
    } finally {
      s.setEditingLocked(false);
    }
  };
  const send = async (text: string) => {
    const s = useBoardStore.getState();
    if (!s.status || s.editingLocked) return false;
    generation.current++;
    s.setEditingLocked(true);
    setAgentPending(true);
    setAgentError(null);
    setAgentPanelOpen(true);
    let accepted = false;
    try {
      const base = s.currentLayer;
      if (!base) throw new Error("请先创建一个画板层");
      setAgentMessages((old) => [
        ...old,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
      const result = await client.agentChat({
        project_id: s.status.project.id,
        space_id: s.status.space.id,
        message: text,
        base_layer_id: base.layer.id,
      });
      accepted = true;
      if (result.result_layer_id) {
        lastAgentResult.current = result.result_layer_id;
        setBranchNotice(null);
        ownLayers.current.add(result.result_layer_id);
        const current = useBoardStore.getState();
        const consumed =
          result.input_snapshot &&
          current.currentLayer?.layer.id === result.input_snapshot.layer_id &&
          current.workingScene &&
          (await browserSceneHash(current.workingScene)) ===
            result.input_snapshot.content_hash;
        if (!current.dirty || consumed) {
          if (consumed)
            try {
              removeDraft(current.currentLayer!.layer.id);
            } catch {}
          await activate(result.result_layer_id);
        } else {
          setBranchNotice(
            "AI 已保存新结果。当前未保存编辑已保留；保存或放弃后，可点击「查看本轮结果」。",
          );
        }
      }
      await load();
      const h = await client.agentHistory(
        s.status.project.id,
        s.status.space.id,
      );
      setAgentMessages(
        h.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          tool_trace: m.tool_trace,
          reasoning_steps: m.reasoning_steps,
          result_layer_id: m.result_layer_id,
        })),
      );
    } catch (e) {
      setAgentError(message(e));
      return accepted;
    } finally {
      s.setEditingLocked(false);
      setAgentPending(false);
      setAgentRun(null);
    }
    return true;
  };
  useEffect(() => {
    if (connection !== "connected" || !status) return;
    let cancelled = false;
    let hadRun = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = agentPending ? 600 : 2500;
    let refreshing = false;
    const refresh = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const state = await client.agentRun(status.project.id, status.space.id);
        if (!cancelled) {
          const finished = hadRun && !state.run;
          hadRun = !!state.run;
          delay = state.run || agentPending ? 600 : 2500;
          setAgentRun(state.run);
          if (finished && !agentPending) {
            const h = await client.agentHistory(
              status.project.id,
              status.space.id,
            );
            if (!cancelled)
              setAgentMessages(
                h.messages.map((m) => ({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  tool_trace: m.tool_trace,
                  reasoning_steps: m.reasoning_steps,
                  result_layer_id: m.result_layer_id,
                })),
              );
            await load();
          }
        }
      } catch {
        /* Connection errors are shown by the main health loop. */
      } finally {
        refreshing = false;
        if (!cancelled) timer = setTimeout(() => void refresh(), delay);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, connection, status?.project.id, status?.space.id, agentPending]);
  const cancelAgent = async () => {
    if (!status) return;
    try {
      await client.cancelAgent(status.project.id, status.space.id);
    } catch (e) {
      setAgentError(message(e));
    }
  };
  const [diffPending, setDiffPending] = useState(false);
  const diffRequestId = useRef(0);
  const diffRequests = useRef(new Map<string, Promise<DiffData>>());
  const diffCache = useRef(new Map<string, DiffData>());
  const readDiff = (id: string, visual?: boolean): Promise<DiffData> => {
    const scope = useBoardStore.getState().status;
    const metadataKey = JSON.stringify(
      useBoardStore.getState().currentLayer?.assets ?? [],
    );
    const key = `${scope?.space.id}:${id}:${visual ?? "auto"}:${metadataKey}`;
    const cached = diffCache.current.get(key);
    if (cached) return Promise.resolve(cached);
    let request = diffRequests.current.get(key);
    if (!request) {
      request = client
        .diff(id, undefined, visual)
        .then((result) => {
          if (diffCache.current.size >= 16)
            diffCache.current.delete(diffCache.current.keys().next().value!);
          diffCache.current.set(key, result);
          return result;
        })
        .finally(() => diffRequests.current.delete(key));
      diffRequests.current.set(key, request);
    }
    return request;
  };
  const diff = async (id?: string, visual?: boolean) => {
    const s = useBoardStore.getState();
    const target = id ?? s.activeLayerId;
    if (!target) return;
    const version = generation.current;
    const requestId = ++diffRequestId.current;
    if (s.diff?.target.id === target && s.diffView && visual === undefined) {
      s.setDiff(null);
      s.setDiffView(false);
      return;
    }
    try {
      setDiffPending(true);
      const result = await readDiff(target, visual);
      if (generation.current !== version || requestId !== diffRequestId.current)
        return;
      s.setDiff(result);
      s.setDiffImageMode("highlight");
      s.setDiffView(true);
    } catch (e) {
      if (generation.current === version) s.setError(message(e));
    } finally {
      if (requestId === diffRequestId.current) setDiffPending(false);
    }
  };
  const inspect = async (id: string) => {
    try {
      const s = useBoardStore.getState();
      s.setInspect(await client.inspect(id, s.activeLayerId ?? undefined));
    } catch (e) {
      useBoardStore.getState().setError(message(e));
    }
  };
  const switchSpace = async (id: string) => {
    const s = useBoardStore.getState();
    if (s.editingLocked) return false;
    if (s.dirty) {
      s.setError("当前有未提交修改，请先保存或放弃。");
      return false;
    }
    generation.current++;
    s.setError(null);
    s.setEditingLocked(true);
    try {
      await client.command(["space", "switch", id]);
      client.setScope(s.status!.project.id, id);
      s.setActiveLayer(null);
      s.setCurrentLayer(null);
      useBoardStore.setState({ layers: null, workingScene: null });
      if (!(await load())) return false;
      setFreshSpaces(({ [id]: _seen, ...rest }) => rest);
      setSpacesOpen(false);
      return true;
    } catch (e) {
      s.setError(message(e));
      return false;
    } finally {
      s.setEditingLocked(false);
    }
  };
  const createSpace = async (name: string) => {
    const s = useBoardStore.getState();
    if (s.editingLocked) return false;
    if (s.dirty) {
      s.setError("当前有未提交修改，请先保存或放弃。");
      return false;
    }
    try {
      const created = await client.command<{ space_id: string }>([
        "space",
        "create",
        name,
      ]);
      ownSpaces.current.add(created.space_id);
      return await switchSpace(created.space_id);
    } catch (e) {
      s.setError(message(e));
      return false;
    }
  };
  const changeSpaceVisibility = async (id: string, deleted: boolean) => {
    const s = useBoardStore.getState();
    if (s.editingLocked || (deleted && s.dirty)) return false;
    s.setError(null);
    s.setEditingLocked(true);
    generation.current++;
    try {
      await client.command(["space", deleted ? "delete" : "restore", id]);
      return await load();
    } catch (e) {
      s.setError(message(e));
      return false;
    } finally {
      s.setEditingLocked(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (boardShortcutsBlocked(e)) {
        const target = e.target as HTMLElement | null;
        const typing =
          target?.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
        if (
          (e.metaKey || e.ctrlKey) &&
          (e.key.toLowerCase() === "s" ||
            (!typing && e.key.toLowerCase() === "z"))
        )
          e.preventDefault();
        if (spacesOpen && e.key === "Escape") {
          e.preventDefault();
          setSpacesOpen(false);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!e.repeat) void saveRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
        const target = e.target as HTMLElement | null;
        if (
          !target?.isContentEditable &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
        ) {
          e.preventDefault();
          if (e.key === "[") setAgentPanelOpen((open) => !open);
          else useBoardStore.getState().toggleRightPanel();
        }
      }
      if (e.key === "Escape") {
        useBoardStore.getState().closeOverlays();
        setSpacesOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [spacesOpen]);
  const preview = async (id: string) => {
    if (previewing.current.has(id)) return;
    previewing.current.add(id);
    try {
      const layer = await client.get(id, "render");
      setPreviews((old) => ({
        ...old,
        [id]: renderUrlForBrowser(layer.render!.url),
      }));
    } catch {
      previewing.current.delete(id);
    }
  };
  const saveModelSettings = async (value: ModelSettingsUpdate) => {
    const config = await client.saveModelSettings(value);
    setAgentConfig(config);
    return config;
  };
  const toggleAutoTitle = async (enabled: boolean) => {
    try {
      await client.setAutoTitle(enabled);
      setAgentConfig(await client.agentConfig());
    } catch (e) {
      useBoardStore.getState().setError(message(e));
    }
  };
  const toggleProjectSync = async (enabled: boolean) => {
    if (!status) return;
    try {
      setProjectSync(await client.projectSync(status.project.id, enabled));
    } catch (e) {
      useBoardStore.getState().setError(message(e));
    }
  };
  const rename = async (id: string, title: string) => {
    try {
      await client.renameAsset(id, title);
      useBoardStore.setState((s) => ({
        registeredAssets: s.registeredAssets.map((a) =>
          a.asset_id === id ? { ...a, title, title_source: "human" } : a,
        ),
      }));
      await load();
    } catch (e) {
      useBoardStore.getState().setError(message(e));
      throw e;
    }
  };
  const deleteLayer = async (id: string) => {
    const s = useBoardStore.getState();
    const spaceId = s.status?.space.id;
    if (!spaceId || s.editingLocked) return;
    const layers = s.layers?.layers ?? [];
    const branch = new Set([id]);
    for (const layer of [...layers].sort((a, b) => a.seq - b.seq))
      if (layer.parent_id && branch.has(layer.parent_id)) branch.add(layer.id);
    if (s.dirty && s.activeLayerId && branch.has(s.activeLayerId)) {
      s.setError("当前层有未提交修改，请先保存或放弃，再删除。");
      return;
    }
    s.setEditingLocked(true);
    try {
      await client.deleteLayer(spaceId, id);
      if (
        s.diff &&
        (branch.has(s.diff.target.id) || branch.has(s.diff.base.id))
      ) {
        s.setDiff(null);
        s.setDiffView(false);
      }
    } catch (e) {
      s.setError(message(e));
    } finally {
      s.setEditingLocked(false);
    }
    await load();
  };
  return {
    deleteLayer,
    branchNotice,
    projectSync,
    toggleProjectSync,
    saveModelSettings,
    toggleAutoTitle,
    previews,
    preview,
    rename,
    client,
    load,
    save,
    select,
    send,
    diff,
    diffPending,
    inspect,
    switchSpace,
    createSpace,
    changeSpaceVisibility,
    agentConfig,
    agentMessages,
    agentError,
    agentPending: agentPending || !!agentRun,
    agentRun,
    cancelAgent,
    agentPanelOpen,
    setAgentPanelOpen,
    spacesOpen,
    setSpacesOpen: (open: boolean) => {
      if (open) setSpacesSeen(true);
      setSpacesOpen(open);
    },
    newLayers: freshLayers.size,
    freshLayers,
    freshSpaces,
    spacesNotice: !spacesSeen && Object.keys(freshSpaces).length > 0,
    clearFreshLayers: () => setFreshLayers(new Set()),
  };
}
