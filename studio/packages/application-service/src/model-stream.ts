import {
  HumanBoardError,
  type ModelGenerationOutput,
  type ModelToolCall,
} from "@humanboard/core-engine";

const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const invalid = (message: string) => new HumanBoardError("E_INTERNAL", message);
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only complete, normally finished generations can return executable tool calls. */
export async function readModelStream(
  response: Response,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void = () => {},
): Promise<ModelGenerationOutput> {
  if (!response.body) throw invalid("Model stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    data: string[] = [],
    content = "",
    reasoning = "",
    finish: string | undefined;
  let bytes = 0,
    done = false;
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join("\n");
    data = [];
    if (raw.trim() === "[DONE]") {
      done = true;
      return;
    }
    const payload = record(JSON.parse(raw));
    if (!payload || payload.error)
      throw invalid("Model stream returned an error");
    if (!Array.isArray(payload.choices))
      throw invalid("Model stream returned invalid choices");
    for (const value of payload.choices) {
      const choice = record(value);
      if (!choice || choice.index !== 0) continue;
      const delta = record(choice.delta);
      if (
        finish &&
        delta &&
        Object.values(delta).some((v) => v !== null && v !== "")
      )
        throw invalid("Model stream continued after completion");
      if (delta) {
        const thought =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (thought) {
          reasoning += thought;
          onReasoning(thought);
        }
        for (const field of ["content", "refusal"]) {
          if (typeof delta[field] === "string" && delta[field]) {
            content += delta[field];
            onText(delta[field]);
          }
        }
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls))
            throw invalid("Model stream returned invalid tool calls");
          for (const item of delta.tool_calls) {
            const call = record(item);
            if (
              !call ||
              !Number.isInteger(call.index) ||
              Number(call.index) < 0 ||
              Number(call.index) >= 8
            )
              throw invalid("Model stream returned invalid tool index");
            const index = Number(call.index);
            const merged = calls.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (call.type !== undefined && call.type !== "function")
              throw invalid("Unsupported model tool type");
            if (call.id !== undefined) {
              if (typeof call.id !== "string")
                throw invalid("Invalid model tool ID");
              merged.id += call.id;
            }
            if (call.function !== undefined) {
              const fn = record(call.function);
              if (!fn) throw invalid("Invalid model function");
              for (const field of ["name", "arguments"] as const) {
                if (fn[field] !== undefined) {
                  if (typeof fn[field] !== "string")
                    throw invalid("Invalid model tool fragment");
                  merged[field] += fn[field];
                }
              }
            }
            calls.set(index, merged);
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (
          finish ||
          !["stop", "tool_calls"].includes(String(choice.finish_reason))
        )
          throw invalid("Model stream did not finish normally");
        finish = String(choice.finish_reason);
      }
    }
  };
  const line = (value: string) => {
    if (value === "") dispatch();
    else if (value.startsWith("data:"))
      data.push(value.slice(5).replace(/^ /, ""));
  };
  const consume = (eof = false) => {
    while (!done) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (!eof && buffer[index] === "\r" && index === buffer.length - 1) break;
      const width =
        buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const value = buffer.slice(0, index);
      buffer = buffer.slice(index + width);
      line(value);
    }
    if (eof && !done) {
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    }
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (!done) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        buffer += decoder.decode();
        consume(true);
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES)
        throw invalid("Model stream exceeded response size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      consume();
    }
    if (!finish) throw invalid("Model stream ended before completion");
    const toolCalls: ModelToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => {
        if (!call.id || !call.name || !call.arguments)
          throw invalid("Model stream returned an incomplete tool call");
        try {
          JSON.parse(call.arguments);
        } catch {
          throw invalid("Model stream returned invalid tool arguments");
        }
        return call;
      });
    if (toolCalls.length > 0 !== (finish === "tool_calls"))
      throw invalid("Model stream tool finish reason does not match its calls");
    return {
      content: content || null,
      ...(reasoning ? { reasoning } : {}),
      toolCalls,
      finishReason: finish,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof HumanBoardError) throw error;
    throw invalid("Model endpoint returned an invalid or interrupted stream");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
