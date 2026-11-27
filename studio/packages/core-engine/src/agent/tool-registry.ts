import { HumanBoardError } from "../domain/errors";
import type {
  ModelToolCall,
  ModelToolDefinition,
} from "../domain/model-provider";
export interface AgentToolResult {
  readonly data: unknown;
  readonly images?: readonly {
    readonly label: string;
    readonly png: Uint8Array;
  }[];
}
export interface AgentTool<C> {
  readonly definition: ModelToolDefinition;
  readonly execute: (
    args: Record<string, unknown>,
    context: C,
  ) => Promise<AgentToolResult>;
}
/** One registry owns advertised schemas and execution; unregistered tools cannot run. */
export class AgentToolRegistry<C> {
  private readonly tools = new Map<string, AgentTool<C>>();
  register(tool: AgentTool<C>): this {
    if (this.tools.has(tool.definition.name))
      throw new Error(`Duplicate tool: ${tool.definition.name}`);
    this.tools.set(tool.definition.name, tool);
    return this;
  }
  get definitions(): readonly ModelToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }
  async execute(call: ModelToolCall, context: C): Promise<AgentToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool)
      throw new HumanBoardError("E_USAGE", `Unknown tool ${call.name}`);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      throw new HumanBoardError("E_USAGE", "Tool arguments must be valid JSON");
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new HumanBoardError("E_USAGE", "Tool arguments must be an object");
    const parameters = tool.definition.parameters;
    const properties = parameters.properties as Record<
      string,
      { type?: string; enum?: unknown[] }
    >;
    for (const required of (parameters.required as string[] | undefined) ??
      []) {
      if (!(required in args))
        throw new HumanBoardError("E_USAGE", `Missing argument ${required}`);
    }
    for (const [key, value] of Object.entries(args)) {
      const schema = properties[key];
      if (!schema)
        throw new HumanBoardError("E_USAGE", `Unknown argument ${key}`);
      if (
        schema.type &&
        (schema.type === "object"
          ? !value || typeof value !== "object" || Array.isArray(value)
          : typeof value !== schema.type)
      )
        throw new HumanBoardError("E_USAGE", `Invalid type for ${key}`);
      if (schema.enum && !schema.enum.includes(value))
        throw new HumanBoardError("E_USAGE", `Invalid value for ${key}`);
    }
    return tool.execute(args as Record<string, unknown>, context);
  }
}
export function defineAgentTool<C>(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  execute: AgentTool<C>["execute"],
): AgentTool<C> {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
    execute,
  };
}
