import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentPanel } from "./AgentPanel";

describe("AgentPanel", () => {
  test("completed thoughts are collapsed and tool records precede the answer", () => {
    const markup = renderToStaticMarkup(
      <AgentPanel
        config={null}
        pending={false}
        error={null}
        rightPanelOpen={false}
        onSend={() => {}}
        onClose={() => {}}
        messages={[
          {
            id: "answer",
            role: "assistant",
            content: "FINAL ANSWER",
            reasoning_steps: [{ step: 1, content: "PROVIDER THOUGHT" }],
            tool_trace: [
              {
                id: "call",
                tool: "humanboard_get",
                step: 1,
                status: "completed",
                summary: "读取完成",
                started_at: "2026-10-30T00:00:00Z",
              },
            ],
          },
        ]}
      />,
    );
    expect(markup.indexOf("PROVIDER THOUGHT")).toBeLessThan(
      markup.indexOf("FINAL ANSWER"),
    );
    expect(markup.indexOf("读取完成")).toBeLessThan(
      markup.indexOf("FINAL ANSWER"),
    );
    expect(markup).toContain('class="agent-reasoning"');
    expect(markup).not.toContain('class="agent-reasoning" open');
  });

  test("thoughts and tool calls alternate by step and fold once finished", () => {
    const call = (id: string, step: number, summary: string) => ({
      id,
      tool: "humanboard_get",
      step,
      status: "completed" as const,
      summary,
      started_at: "2026-10-30T00:00:00Z",
    });
    const markup = renderToStaticMarkup(
      <AgentPanel
        config={null}
        pending={false}
        error={null}
        rightPanelOpen={false}
        onSend={() => {}}
        onClose={() => {}}
        messages={[
          {
            id: "answer",
            role: "assistant",
            content: "FINAL ANSWER",
            reasoning_steps: [
              { step: 2, content: "THOUGHT TWO" },
              { step: 1, content: "THOUGHT ONE" },
            ],
            tool_trace: [call("b", 2, "TOOL TWO"), call("a", 1, "TOOL ONE")],
          },
        ]}
      />,
    );
    const order = ["THOUGHT ONE", "TOOL ONE", "THOUGHT TWO", "TOOL TWO"].map(
      (text) => markup.indexOf(text),
    );
    expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);
    expect(markup).toContain('<details class="agent-process">');
    expect(markup).toContain("思考和工具调用过程 · 2 步 · 2 次调用");
  });

  test("the current provider thought is expanded while streaming", () => {
    const markup = renderToStaticMarkup(
      <AgentPanel
        config={null}
        pending
        error={null}
        rightPanelOpen={false}
        onSend={() => {}}
        onClose={() => {}}
        messages={[]}
        run={{
          run_id: "run",
          phase: "thinking",
          step: 2,
          tool_trace: [],
          reasoning_steps: [{ step: 2, content: "WORKING THOUGHT" }],
        }}
      />,
    );
    expect(markup).toContain('class="agent-reasoning" open=""');
    expect(markup).toContain("WORKING THOUGHT");
  });
  test("renders disabled guidance with missing environment variables", () => {
    const markup = renderToStaticMarkup(
      <AgentPanel
        config={{
          agent: {
            configured: false,
            model: null,
            base_url_configured: false,
            api_key_configured: false,
            missing_env: [
              "HUMAN_AGENT_MODEL",
              "HUMAN_MODEL_BASE_URL",
              "HUMAN_MODEL_API_KEY",
            ],
          },
          vision: {
            configured: false,
            model: null,
            base_url_configured: false,
            api_key_configured: false,
            missing_env: ["HUMAN_VISION_MODEL"],
          },
          text: {
            configured: false,
            model: null,
            base_url_configured: false,
            api_key_configured: false,
            missing_env: ["HUMAN_TEXT_MODEL"],
          },
        }}
        messages={[]}
        pending={false}
        error={null}
        rightPanelOpen
        onSend={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain("Agent 未配置");
    expect(markup).toContain("聊天面板已置灰");
    expect(markup).toContain("HUMAN_AGENT_MODEL");
    expect(markup).toContain("HUMAN_MODEL_BASE_URL");
    expect(markup).toContain("HUMAN_MODEL_API_KEY");
    expect(markup).toContain("agent-panel is-offset");
    expect(markup).toContain("disabled");
  });

  test("renders chat history and generating state", () => {
    const markup = renderToStaticMarkup(
      <AgentPanel
        config={{
          agent: {
            configured: true,
            model: "agent-model",
            base_url_configured: true,
            api_key_configured: true,
            missing_env: [],
          },
          vision: {
            configured: true,
            model: "vision-model",
            base_url_configured: true,
            api_key_configured: true,
            missing_env: [],
          },
          text: {
            configured: true,
            model: "text-model",
            base_url_configured: true,
            api_key_configured: true,
            missing_env: [],
          },
        }}
        messages={[
          { id: "u1", role: "user", content: "把草图转成逻辑图" },
          { id: "a1", role: "assistant", content: "已提交转化层" },
        ]}
        pending
        error="上一次请求失败"
        rightPanelOpen={false}
        onSend={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain("agent-model");
    expect(markup).toContain("把草图转成逻辑图");
    expect(markup).toContain("已提交转化层");
    expect(markup).toContain("生成中");
    expect(markup).toContain("上一次请求失败");
  });
});

test("renders model Markdown without executing HTML or loading remote images", () => {
  const markup = renderToStaticMarkup(
    <AgentPanel
      config={null}
      messages={[
        {
          id: "a",
          role: "assistant",
          content:
            "**已完成**\n\n- 第一项\n\n![外部图](https://example.test/tracking.png)\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))",
        },
      ]}
      pending={false}
      error={null}
      rightPanelOpen
      onSend={() => {}}
      onClose={() => {}}
    />,
  );
  expect(markup).toContain("<strong>已完成</strong>");
  expect(markup).toContain("<li>第一项</li>");
  expect(markup).not.toContain("<script>");
  expect(markup).not.toContain('src="https://example.test');
  expect(markup).not.toContain('href="javascript:');
});
