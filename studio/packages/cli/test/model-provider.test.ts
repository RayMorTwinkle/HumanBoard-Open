import { describe, expect, test } from "bun:test";

import {
  HumanBoardError,
  type ModelToolDefinition,
} from "@humanboard/core-engine";

import {
  OpenAICompatibleModelProvider,
  publicModelConfiguration,
  resolveModelConfiguration,
} from "../src/model-provider";

const TOOL: ModelToolDefinition = {
  name: "humanboard_update_canvas",
  description: "update canvas",
  parameters: { type: "object", properties: {} },
};

describe("OpenAI-compatible model provider", () => {
  test("keeps agent, vision, and text model configuration separate", () => {
    const config = resolveModelConfiguration({
      HUMAN_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      HUMAN_MODEL_API_KEY: "secret",
      HUMAN_AGENT_MODEL: "agent-model",
      HUMAN_VISION_MODEL: "vision-model",
      HUMAN_TEXT_MODEL: "text-model",
    });
    expect(config.agent.model).toBe("agent-model");
    expect(config.vision.model).toBe("vision-model");
    expect(config.text.model).toBe("text-model");
    expect(
      Object.values(publicModelConfiguration(config)).every(
        (role) => role.configured,
      ),
    ).toBe(true);
  });

  test("reports missing environment variables without exposing secrets", () => {
    const publicConfig = publicModelConfiguration(
      resolveModelConfiguration({ HUMAN_AGENT_MODEL: "agent-model" }),
    );
    expect(publicConfig.agent).toEqual({
      follow_agent: false,
      enabled: true,
      source: "environment",
      base_url: null,
      configured: false,
      model: "agent-model",
      base_url_configured: false,
      api_key_configured: false,
      missing_env: ["HUMAN_MODEL_BASE_URL", "HUMAN_MODEL_API_KEY"],
    });
    expect(JSON.stringify(publicConfig)).not.toContain("secret");
  });

  test("sends OpenAI tool calling and parses tool_calls", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const provider = new OpenAICompatibleModelProvider({
      model: "agent-model",
      baseUrl: "http://127.0.0.1:11434/v1/",
      apiKey: "secret",
      fetch: async (url, init) => {
        requestUrl = url.href;
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "humanboard_update_canvas",
                      arguments: '{"title":"新层"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      },
    });

    const output = await provider.generate({
      messages: [{ role: "user", content: "hello" }],
      tools: [TOOL],
      temperature: 0.2,
    });
    expect(requestUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "agent-model",
      tool_choice: "auto",
      temperature: 0.2,
    });
    expect(output.toolCalls).toEqual([
      {
        id: "call-1",
        name: "humanboard_update_canvas",
        arguments: '{"title":"新层"}',
      },
    ]);
    expect(output.finishReason).toBe("tool_calls");
  });

  test("maps provider HTTP failures to E_INTERNAL", async () => {
    const provider = new OpenAICompatibleModelProvider({
      model: "agent-model",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "secret",
      fetch: async () =>
        Response.json({ error: "bad request" }, { status: 400 }),
    });
    await expect(
      provider.generate({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(HumanBoardError);
    try {
      await provider.generate({
        messages: [{ role: "user", content: "hello" }],
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "E_INTERNAL",
        details: { status: 400 },
      });
    }
  });
});
