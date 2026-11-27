export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ModelTextContentPart {
  readonly type: "text";
  readonly text: string;
}

export interface ModelImageContentPart {
  readonly type: "image_url";
  readonly image_url: {
    readonly url: string;
  };
}

export type ModelContentPart = ModelTextContentPart | ModelImageContentPart;

export interface ModelChatMessage {
  readonly reasoning_content?: string;
  readonly role: ModelMessageRole;
  readonly content: string | null | readonly ModelContentPart[];
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelGenerationInput {
  readonly onReasoningDelta?: (delta: string) => void;
  readonly onTextDelta?: (delta: string) => void;
  readonly signal?: AbortSignal;
  readonly messages: readonly ModelChatMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ModelGenerationOutput {
  readonly reasoning?: string;
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason?: string;
}

export interface ModelProvider {
  /** Pin a provider for a complete logical task across hot configuration changes. */
  snapshot?(): ModelProvider;
  generate(input: ModelGenerationInput): Promise<ModelGenerationOutput>;
}
