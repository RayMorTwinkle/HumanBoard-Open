import { expect, test } from "bun:test";
import { OpenAICompatibleModelProvider } from "../src/model-provider";

const encoder = new TextEncoder();
const event = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
function provider(stream: ReadableStream<Uint8Array>) {
  return new OpenAICompatibleModelProvider({
    model: "test",
    baseUrl: "http://127.0.0.1/v1",
    apiKey: "test",
    fetch: async (_url, init) => {
      expect(JSON.parse(String(init?.body)).stream).toBe(true);
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    },
  });
}

test("streams UTF-8 text before completion and assembles interleaved tool arguments privately", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const text: string[] = [];
  const reasoning: string[] = [];
  const result = provider(stream).generate({
    messages: [],
    onTextDelta: (delta) => text.push(delta),
    onReasoningDelta: (delta) => reasoning.push(delta),
  });
  const initial = encoder.encode(
    event({ content: "你好", reasoning_content: "PRIVATE" }),
  );
  for (const byte of initial) controller.enqueue(new Uint8Array([byte]));
  await Bun.sleep(10);
  expect(text.join("")).toBe("你好");
  controller.enqueue(
    encoder.encode(
      event({
        tool_calls: [
          {
            index: 1,
            id: "b",
            function: { name: "humanboard_", arguments: '{"layer_' },
          },
          {
            index: 0,
            id: "a",
            function: { name: "humanboard_capture", arguments: "{" },
          },
        ],
      }),
    ),
  );
  controller.enqueue(
    encoder.encode(
      event(
        {
          tool_calls: [
            { index: 0, function: { arguments: "}" } },
            { index: 1, function: { name: "get", arguments: 'id":"L1"}' } },
          ],
        },
        "tool_calls",
      ),
    ),
  );
  controller.enqueue(
    encoder.encode(
      'data: {"choices":[],"usage":{"total_tokens":10}}\r\n\r\ndata: [DONE]\r\n\r\n',
    ),
  );
  controller.close();
  expect(await result).toEqual({
    content: "你好",
    reasoning: "PRIVATE",
    toolCalls: [
      { id: "a", name: "humanboard_capture", arguments: "{}" },
      { id: "b", name: "humanboard_get", arguments: '{"layer_id":"L1"}' },
    ],
    finishReason: "tool_calls",
  });
  expect(text.join("")).not.toContain("PRIVATE");
  expect(reasoning.join("")).toBe("PRIVATE");
});

test("rejects truncated streams even with complete-looking tool JSON", async () => {
  for (const tail of ["", "data: [DONE]\n\n", event({}, "length")]) {
    const wire =
      event({
        tool_calls: [
          {
            index: 0,
            id: "commit",
            function: { name: "humanboard_commit", arguments: "{}" },
          },
        ],
      }) + tail;
    await expect(
      provider(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(wire));
            c.close();
          },
        }),
      ).generate({ messages: [], onTextDelta() {} }),
    ).rejects.toThrow();
  }
});

test("abort cancels a stalled response reader", async () => {
  let cancelled = false;
  const abort = new AbortController();
  const result = provider(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  ).generate({ messages: [], signal: abort.signal, onTextDelta() {} });
  await Bun.sleep(10);
  abort.abort();
  await expect(result).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("supports JSON-only compatible endpoints without duplicate deltas", async () => {
  const text: string[] = [];
  const p = new OpenAICompatibleModelProvider({
    model: "test",
    baseUrl: "http://127.0.0.1/v1",
    apiKey: "test",
    fetch: async () =>
      Response.json({
        choices: [{ message: { content: "完整回答" }, finish_reason: "stop" }],
      }),
  });
  expect(
    (
      await p.generate({
        messages: [],
        onTextDelta: (delta) => text.push(delta),
      })
    ).content,
  ).toBe("完整回答");
  expect(text).toEqual(["完整回答"]);
});

test("accepts a normal finish at EOF without DONE and cancels on timeout", async () => {
  const p = provider(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(event({ content: "完整" }, "stop")));
        c.close();
      },
    }),
  );
  expect((await p.generate({ messages: [], onTextDelta() {} })).content).toBe(
    "完整",
  );
  let cancelled = false;
  const stalled = new OpenAICompatibleModelProvider({
    model: "test",
    baseUrl: "http://127.0.0.1/v1",
    apiKey: "test",
    timeoutMs: 20,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  await expect(
    stalled.generate({ messages: [], onTextDelta() {} }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("JSON fallback rejects length-limited tool calls instead of executing them", async () => {
  for (const finish_reason of ["length", undefined]) {
    const p = new OpenAICompatibleModelProvider({
      model: "test",
      baseUrl: "http://127.0.0.1/v1",
      apiKey: "test",
      fetch: async () =>
        Response.json({
          choices: [
            {
              finish_reason,
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "commit",
                    function: { name: "humanboard_commit", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(
      p.generate({ messages: [], onTextDelta() {} }),
    ).rejects.toThrow("did not finish normally");
  }
});
