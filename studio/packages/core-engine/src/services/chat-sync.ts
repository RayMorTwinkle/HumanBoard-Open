import { canonicalJson, UlidSchema } from "@humanboard/schema";
import { HumanBoardError } from "../domain/errors";
import type {
  AgentMessage,
  AgentSession,
  AgentToolTrace,
} from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";

export interface SyncChatPayload {
  readonly session: AgentSession;
  readonly messages: readonly AgentMessage[];
}

export async function readSyncChat(
  storage: StorageAdapter,
  projectId: string,
  spaceId: string,
  knownIds: readonly string[] = [],
) {
  const session = await storage.getAgentSession(projectId, spaceId);
  if (!session) return { have: [] as string[], chat: undefined };
  const messages = await storage.listAgentMessages(session.id),
    known = new Set(knownIds);
  return {
    have: messages.map((m) => m.id),
    chat: { session, messages: messages.filter((m) => !known.has(m.id)) },
  };
}

const validId = (value: unknown) => UlidSchema.safeParse(value).success;
const validDate = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableId = (value: unknown) => value === null || validId(value);
function validateChat(
  value: SyncChatPayload,
  projectId: string,
  spaceId: string,
): void {
  const session = value?.session;
  if (
    !session ||
    !validId(session.id) ||
    session.project_id !== projectId ||
    session.space_id !== spaceId ||
    !validDate(session.created_at) ||
    !validDate(session.updated_at) ||
    !Array.isArray(value.messages)
  )
    throw new HumanBoardError("E_USAGE", "Invalid chat sync scope or session");
  for (const m of value.messages) {
    if (
      !m ||
      !validId(m.id) ||
      m.session_id !== session.id ||
      !Number.isSafeInteger(m.seq) ||
      m.seq < 1 ||
      !["user", "assistant"].includes(m.role) ||
      typeof m.content !== "string" ||
      !nullableId(m.base_layer_id) ||
      !nullableId(m.result_layer_id) ||
      !validDate(m.created_at)
    )
      throw new HumanBoardError("E_USAGE", "Invalid synced chat message");
    if (
      m.reasoning_steps !== undefined &&
      (!Array.isArray(m.reasoning_steps) ||
        m.reasoning_steps.some(
          (r: { step: number; content: string }) =>
            !r ||
            !Number.isSafeInteger(r.step) ||
            r.step < 1 ||
            typeof r.content !== "string",
        ))
    )
      throw new HumanBoardError("E_USAGE", "Invalid synced reasoning steps");
    if (
      m.tool_trace !== undefined &&
      (!Array.isArray(m.tool_trace) ||
        m.tool_trace.some(
          (t: AgentToolTrace) =>
            !t ||
            typeof t.id !== "string" ||
            typeof t.tool !== "string" ||
            typeof t.summary !== "string" ||
            !Number.isSafeInteger(t.step) ||
            t.step < 0 ||
            !["running", "completed", "failed"].includes(t.status) ||
            !validDate(t.started_at) ||
            (t.finished_at !== undefined && !validDate(t.finished_at)),
        ))
    )
      throw new HumanBoardError("E_USAGE", "Invalid synced chat tool trace");
  }
}
function immutableContent(m: AgentMessage): string {
  return canonicalJson({
    id: m.id,
    role: m.role,
    content: m.content,
    base_layer_id: m.base_layer_id,
    result_layer_id: m.result_layer_id,
    created_at: m.created_at,
    tool_trace: m.tool_trace ?? [],
    reasoning_steps: m.reasoning_steps ?? [],
  });
}

/** Message IDs are immutable; local session/sequence allocation remains local. */
export async function importSyncChat(
  storage: StorageAdapter,
  projectId: string,
  spaceId: string,
  value: SyncChatPayload,
): Promise<number> {
  validateChat(value, projectId, spaceId);
  let session = await storage.getAgentSession(projectId, spaceId);
  const existing = new Map(
    (session ? await storage.listAgentMessages(session.id) : []).map((m) => [
      m.id,
      immutableContent(m),
    ]),
  );
  const incoming = [...value.messages].sort(
    (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
  );
  const additions: AgentMessage[] = [];
  for (const m of incoming) {
    const content = immutableContent(m),
      known = existing.get(m.id);
    if (known !== undefined && known !== content)
      throw new HumanBoardError(
        "E_HASH_MISMATCH",
        "Synced chat message ID has different immutable content",
        { message_id: m.id },
      );
    if (known === undefined) additions.push(m);
    existing.set(m.id, content);
  }
  session ??= await storage.createAgentSession({
    ...value.session,
    project_id: projectId,
    space_id: spaceId,
  });
  for (const m of additions) {
    const { seq: _remoteSequence, ...message } = m;
    await storage.appendAgentMessage({ ...message, session_id: session.id });
  }
  return additions.length;
}
