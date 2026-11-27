import {
  HumanBoardError,
  type ModelChatMessage,
  type ModelGenerationInput,
  type ModelGenerationOutput,
  type ModelProvider,
  type ModelToolCall,
} from "@humanboard/core-engine";

import type { Environment } from "./config";
import { readModelStream } from "./model-stream";

export type ModelRole = "agent" | "vision" | "text";

export type ModelOverrides = Partial<
  Record<
    ModelRole,
    {
      model?: string;
      base_url?: string;
      api_key?: string;
      enabled?: boolean;
      follow_agent?: boolean;
    }
  >
>;

export interface RoleModelConfig {
  readonly follow_agent?: boolean;
  readonly enabled: boolean;
  readonly source: "environment" | "saved";
  readonly role: ModelRole;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly configured: boolean;
  readonly missingEnv: readonly string[];
}

export interface ModelConfiguration {
  readonly agent: RoleModelConfig;
  readonly vision: RoleModelConfig;
  readonly text: RoleModelConfig;
}

export interface PublicRoleModelConfig {
  readonly follow_agent?: boolean;
  readonly enabled: boolean;
  readonly source: "environment" | "saved";
  readonly base_url: string | null;
  readonly configured: boolean;
  readonly model: string | null;
  readonly base_url_configured: boolean;
  readonly api_key_configured: boolean;
  readonly missing_env: readonly string[];
}

export interface PublicModelConfiguration {
  readonly agent: PublicRoleModelConfig;
  readonly vision: PublicRoleModelConfig;
  readonly text: PublicRoleModelConfig;
}

export type ModelFetch = (input: URL, init?: RequestInit) => Promise<Response>;

const SHARED_BASE_URL_ENV = "HUMAN_MODEL_BASE_URL";
const SHARED_API_KEY_ENV = "HUMAN_MODEL_API_KEY";
const ROLE_ENV: Readonly<
  Record<
    ModelRole,
    {
      readonly model: string;
      readonly baseUrl: string;
      readonly apiKey: string;
    }
  >
> = {
  agent: {
    model: "HUMAN_AGENT_MODEL",
    baseUrl: "HUMAN_AGENT_BASE_URL",
    apiKey: "HUMAN_AGENT_API_KEY",
  },
  vision: {
    model: "HUMAN_VISION_MODEL",
    baseUrl: "HUMAN_VISION_BASE_URL",
    apiKey: "HUMAN_VISION_API_KEY",
  },
  text: {
    model: "HUMAN_TEXT_MODEL",
    baseUrl: "HUMAN_TEXT_BASE_URL",
    apiKey: "HUMAN_TEXT_API_KEY",
  },
};

function value(env: Environment, key: string): string {
  return env[key]?.trim() ?? "";
}

function roleConfig(
  env: Environment,
  role: ModelRole,
  override?: ModelOverrides[ModelRole],
): RoleModelConfig {
  const names = ROLE_ENV[role];
  const model = override?.model ?? value(env, names.model);
  const baseUrl =
    override?.base_url ??
    (value(env, names.baseUrl) || value(env, SHARED_BASE_URL_ENV));
  const apiKey =
    override?.api_key ??
    (value(env, names.apiKey) || value(env, SHARED_API_KEY_ENV));
  const enabled = override?.enabled ?? model.length > 0;
  const missingEnv: string[] = [];
  if (model.length === 0) {
    missingEnv.push(names.model);
  }
  if (baseUrl.length === 0) {
    missingEnv.push(SHARED_BASE_URL_ENV);
  }
  if (apiKey.length === 0) {
    missingEnv.push(SHARED_API_KEY_ENV);
  }
  return {
    role,
    model,
    baseUrl,
    apiKey,
    enabled,
    source: override === undefined ? "environment" : "saved",
    configured: enabled && missingEnv.length === 0,
    missingEnv,
  };
}

export function resolveModelConfiguration(
  env: Environment,
  overrides: ModelOverrides = {},
): ModelConfiguration {
  const agent = roleConfig(env, "agent", overrides.agent);
  const auxiliary = (role: "vision" | "text") => {
    const own = roleConfig(env, role, overrides[role]);
    if (!overrides[role]?.follow_agent) return { ...own, follow_agent: false };
    const enabled = overrides[role]?.enabled ?? true;
    return {
      ...agent,
      role,
      source: "saved" as const,
      enabled,
      follow_agent: true,
      configured: enabled && agent.configured,
    };
  };
  return { agent, vision: auxiliary("vision"), text: auxiliary("text") };
}

function publicRoleConfig(config: RoleModelConfig): PublicRoleModelConfig {
  let endpoint: string | null = null;
  try {
    const url = new URL(config.baseUrl);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      endpoint = config.baseUrl;
  } catch {}
  return {
    follow_agent: config.follow_agent ?? false,
    enabled: config.enabled,
    source: config.source,
    base_url: endpoint,
    configured: config.configured,
    model: config.model.length === 0 ? null : config.model,
    base_url_configured: config.baseUrl.length > 0,
    api_key_configured: config.apiKey.length > 0,
    missing_env: config.missingEnv,
  };
}

export function publicModelConfiguration(
  config: ModelConfiguration,
): PublicModelConfiguration {
  return {
    agent: publicRoleConfig(config.agent),
    vision: publicRoleConfig(config.vision),
    text: publicRoleConfig(config.text),
  };
}

function chatCompletionsUrl(baseUrl: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    return new URL(
      trimmed.endsWith("/chat/completions")
        ? trimmed
        : `${trimmed}/chat/completions`,
    );
  } catch (error) {
    throw new HumanBoardError("E_USAGE", "Invalid model base URL", {
      base_url: baseUrl,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function openAiMessage(message: ModelChatMessage): Record<string, unknown> {
  return {
    ...(message.reasoning_content
      ? { reasoning_content: message.reasoning_content }
      : {}),
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tool_call_id === undefined
      ? {}
      : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined
      ? {}
      : {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        }),
  };
}

function parseToolCalls(value: unknown): ModelToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: ModelToolCall[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const fn =
      record.function !== null &&
      typeof record.function === "object" &&
      !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : null;
    if (
      typeof record.id !== "string" ||
      fn === null ||
      typeof fn.name !== "string"
    ) {
      continue;
    }
    calls.push({
      id: record.id,
      name: fn.name,
      arguments:
        typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return calls;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  private readonly model: string;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly fetchImpl: ModelFetch;
  private readonly timeoutMs: number;

  constructor(options: {
    readonly model: string;
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly fetch?: ModelFetch;
    readonly timeoutMs?: number;
  }) {
    if (
      options.model.trim().length === 0 ||
      options.baseUrl.trim().length === 0 ||
      options.apiKey.trim().length === 0
    ) {
      throw new HumanBoardError(
        "E_USAGE",
        "OpenAI-compatible model configuration is incomplete",
      );
    }
    this.model = options.model.trim();
    this.endpoint = chatCompletionsUrl(options.baseUrl.trim());
    this.apiKey = options.apiKey.trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(input: ModelGenerationInput): Promise<ModelGenerationOutput> {
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          ...(input.onTextDelta || input.onReasoningDelta
            ? { stream: true }
            : {}),
          messages: input.messages.map(openAiMessage),
          ...(input.tools === undefined || input.tools.length === 0
            ? {}
            : {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
                tool_choice: "auto",
              }),
          ...(input.temperature === undefined
            ? {}
            : { temperature: input.temperature }),
          ...(input.maxTokens === undefined
            ? {}
            : { max_tokens: input.maxTokens }),
        }),
        signal,
      });
    } catch (error) {
      throw new HumanBoardError(
        "E_CONNECT",
        "Cannot connect to the configured model endpoint",
        {
          endpoint: this.endpoint.href,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!response.ok) {
      let body = "";
      try {
        body = (await response.text()).slice(0, 500);
      } catch {
        // Status remains sufficient when the body cannot be read.
      }
      throw new HumanBoardError(
        "E_INTERNAL",
        `Model endpoint returned HTTP ${response.status}`,
        {
          endpoint: this.endpoint.href,
          status: response.status,
          body,
        },
      );
    }
    if (
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream")
    ) {
      return readModelStream(
        response,
        signal,
        input.onTextDelta ?? (() => {}),
        input.onReasoningDelta,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new HumanBoardError(
        "E_INTERNAL",
        "Model endpoint returned invalid JSON",
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new HumanBoardError(
        "E_INTERNAL",
        "Model endpoint returned an invalid response",
      );
    }
    const choices = (payload as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new HumanBoardError(
        "E_INTERNAL",
        "Model endpoint returned no choices",
      );
    }
    const first = choices[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        "Model endpoint returned an invalid choice",
      );
    }
    const choice = first as Record<string, unknown>;
    const message =
      choice.message !== null &&
      typeof choice.message === "object" &&
      !Array.isArray(choice.message)
        ? (choice.message as Record<string, unknown>)
        : {};
    const toolCalls = parseToolCalls(message.tool_calls);
    if (
      (toolCalls.length > 0 && choice.finish_reason !== "tool_calls") ||
      (input.onTextDelta &&
        typeof choice.finish_reason === "string" &&
        !["stop", "tool_calls"].includes(choice.finish_reason))
    ) {
      throw new HumanBoardError(
        "E_INTERNAL",
        "Model response did not finish normally",
      );
    }
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        try {
          JSON.parse(call.arguments);
        } catch {
          throw new HumanBoardError(
            "E_INTERNAL",
            "Model response returned invalid tool arguments",
          );
        }
      }
    }
    signal.throwIfAborted();
    const reasoning =
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message.reasoning === "string"
          ? message.reasoning
          : "";
    if (reasoning) input.onReasoningDelta?.(reasoning);
    if (typeof message.content === "string" && message.content)
      input.onTextDelta?.(message.content);
    return {
      content: typeof message.content === "string" ? message.content : null,
      ...(reasoning ? { reasoning } : {}),
      toolCalls,
      ...(typeof choice.finish_reason === "string"
        ? { finishReason: choice.finish_reason }
        : {}),
    };
  }
}

export function createRoleModelProvider(
  env: Environment,
  role: ModelRole,
  options: {
    readonly fetch?: ModelFetch;
    readonly timeoutMs?: number;
  } = {},
): ModelProvider | null {
  const config = roleConfig(env, role);
  if (!config.configured) {
    return null;
  }
  return new OpenAICompatibleModelProvider({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...options,
  });
}
