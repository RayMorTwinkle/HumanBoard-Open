import { revisionTools } from "./revision-tools";
export type McpScope = "read" | "write" | "admin";

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpCommandInvocation {
  readonly argv: readonly string[];
  readonly stdin?: string;
}

export class McpToolArgumentError extends Error {
  readonly code = "E_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "McpToolArgumentError";
  }
}

const GLOBAL_PROPERTIES = {
  project: {
    type: "string",
    description: "Project ULID or name. Defaults to the server cwd binding.",
  },
  space: {
    type: "string",
    description: "Space ULID or name. Defaults to the resolved project space.",
  },
} as const;

function schema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: {
      ...GLOBAL_PROPERTIES,
      ...properties,
    },
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "status",
    description:
      "Read the current Project, Space, active layer, and compact DAG summary. Always returns JSON.",
    inputSchema: schema({}),
  },
  {
    name: "layers",
    description:
      "Read the full layer DAG for the current Space. `all` is accepted for CLI compatibility.",
    inputSchema: schema({
      all: {
        type: "boolean",
        description:
          "Accepted for compatibility; layers always returns the full DAG.",
      },
    }),
  },
  {
    name: "get",
    description:
      "Read one layer's AST, render URL, asset manifest, and optional strokes.",
    inputSchema: schema({
      layer: { type: "string", description: "Layer short ID (L4) or ULID." },
      format: {
        type: "string",
        enum: ["ast", "render", "both"],
        description: "Content projection to return.",
      },
      with_strokes: {
        type: "boolean",
        description: "Include the full stroke point sets.",
      },
    }),
  },
  {
    name: "diff",
    description:
      "Compare a layer with its parent, or compare any two layers. Always returns JSON.",
    inputSchema: schema({
      layer: { type: "string", description: "Base or target layer reference." },
      compare_to: {
        type: "string",
        description: "Optional second layer for a cross-branch comparison.",
      },
      visual: {
        type: "boolean",
        description:
          "Request 3-PNG explicitly; by default only comparisons involving strokes include it.",
      },
      layers: {
        type: "array",
        items: { type: "string" },
        maxItems: 2,
        description: "Alternative two-layer form.",
      },
    }),
  },
  {
    name: "draft",
    description:
      "Create, show, or clear the draft bound to Mcp-Session-Id. Requires Mcp-Session-Id.",
    inputSchema: schema({
      action: {
        type: "string",
        enum: ["create", "show", "clear"],
        default: "create",
      },
      parent: { type: "string", description: "Parent layer short ID or ULID." },
      redo: { type: "boolean" },
      transform: { type: "boolean" },
      scene: {
        type: "object",
        additionalProperties: true,
        description: "Full Scene object; sent to the CLI as stdin.",
      },
      patch: {
        type: "object",
        additionalProperties: true,
        description: "Incremental Scene patch object; sent as --merge stdin.",
      },
    }),
  },
  {
    name: "commit",
    description:
      "Commit the draft bound to Mcp-Session-Id. Requires Mcp-Session-Id.",
    inputSchema: schema({
      draft_id: { type: "string" },
      message: { type: "string", description: "Optional layer title." },
    }),
  },
  {
    name: "capture",
    description:
      "Capture the human's current live frontend view. Returns E_LIVE_UNAVAILABLE when no frontend is connected.",
    inputSchema: schema({}),
  },
  {
    name: "inspect",
    description:
      "Read an image with overlaid strokes or a URL asset converted to Markdown.",
    inputSchema: schema(
      {
        asset: {
          type: "string",
          description: "Asset short ID (#001 / 001) or ULID.",
        },
        layer: { type: "string", description: "Optional layer reference." },
      },
      ["asset"],
    ),
  },
  {
    name: "project",
    description: "List, create, or switch Projects.",
    inputSchema: schema({
      action: { type: "string", enum: ["ls", "create", "switch"] },
      value: {
        type: "string",
        description: "Project name or ULID for create/switch.",
      },
    }),
  },
  {
    name: "space",
    description:
      "List/create/switch Spaces, or move to trash and restore. Deletion is reversible.",
    inputSchema: schema({
      action: {
        type: "string",
        enum: ["ls", "create", "switch", "delete", "restore", "trash"],
      },
      value: {
        type: "string",
        description: "Space name or ULID for create/switch/delete/restore.",
      },
      from: {
        type: "string",
        description: "Optional source layer for create.",
      },
    }),
  },
  ...revisionTools,
] as const;

const TOOL_SCOPES: Readonly<Record<string, McpScope>> = {
  board_state: "read",
  board_review: "read",
  board_fork: "write",
  board_save: "write",
  board_accept: "write",
  board_revert: "write",
  status: "read",
  layers: "read",
  get: "read",
  diff: "read",
  capture: "read",
  inspect: "read",
  draft: "write",
  commit: "write",
  project: "admin",
  space: "admin",
};

export function scopeForTool(name: string): McpScope | null {
  return Object.hasOwn(TOOL_SCOPES, name) ? TOOL_SCOPES[name]! : null;
}

export function requiresSession(name: string): boolean {
  return name === "draft" || name === "commit";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpToolArgumentError("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new McpToolArgumentError(`${key} must be a non-empty string`);
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) {
    throw new McpToolArgumentError(`${key} is required`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new McpToolArgumentError(`${key} must be a boolean`);
  }
  return value;
}

function optionalObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value);
}

function action(
  args: Record<string, unknown>,
  allowed: readonly string[],
  fallback: string,
): string {
  const value = optionalString(args, "action") ?? fallback;
  if (!allowed.includes(value)) {
    throw new McpToolArgumentError(
      `action must be one of: ${allowed.join(", ")}`,
    );
  }
  return value;
}

function appendGlobal(argv: string[], args: Record<string, unknown>): void {
  const project = optionalString(args, "project");
  const space = optionalString(args, "space");
  if (project !== undefined) {
    argv.push("--project", project);
  }
  if (space !== undefined) {
    argv.push("--space", space);
  }
}

function withJson(argv: string[]): readonly string[] {
  return [...argv, "--json"];
}

export function buildToolInvocation(
  name: string,
  input: unknown,
): McpCommandInvocation {
  const args = input === undefined ? {} : asRecord(input);
  const argv: string[] = [];
  appendGlobal(argv, args);
  let stdin: string | undefined;

  if (revisionTools.some((tool) => tool.name === name)) {
    const { project, space, ...request } = args;
    return {
      argv: withJson([...argv, "revision"]),
      stdin: JSON.stringify({ ...request, action: name.slice(6) }),
    };
  }
  switch (name) {
    case "status":
      argv.push("status");
      break;
    case "layers":
      argv.push("layers");
      if (optionalBoolean(args, "all") === true) {
        argv.push("--all");
      }
      break;
    case "get": {
      argv.push("get");
      const layer = optionalString(args, "layer");
      if (layer !== undefined) {
        argv.push(layer);
      }
      const format = optionalString(args, "format") ?? "ast";
      if (!["ast", "render", "both"].includes(format)) {
        throw new McpToolArgumentError(
          "format must be one of: ast, render, both",
        );
      }
      argv.push("--format", format);
      if (optionalBoolean(args, "with_strokes") === true) {
        argv.push("--with-strokes");
      }
      break;
    }
    case "diff": {
      argv.push("diff");
      if (args.visual !== undefined) {
        if (typeof args.visual !== "boolean")
          throw new McpToolArgumentError("visual must be a boolean");
        argv.push(args.visual ? "--visual" : "--no-visual");
      }
      const list = args.layers;
      if (list !== undefined) {
        if (
          !Array.isArray(list) ||
          list.length > 2 ||
          !list.every((item) => typeof item === "string" && item.length > 0)
        ) {
          throw new McpToolArgumentError(
            "layers must be an array of at most two non-empty strings",
          );
        }
        argv.push(...list);
      } else {
        const layer = optionalString(args, "layer");
        const compareTo = optionalString(args, "compare_to");
        if (layer !== undefined) {
          argv.push(layer);
        }
        if (compareTo !== undefined) {
          argv.push(compareTo);
        }
      }
      break;
    }
    case "draft": {
      argv.push("draft");
      const draftAction = action(args, ["create", "show", "clear"], "create");
      if (draftAction === "show") {
        argv.push("--show");
      } else if (draftAction === "clear") {
        argv.push("--clear");
      } else {
        const parent = optionalString(args, "parent");
        if (parent !== undefined) {
          argv.push("--parent", parent);
        }
        if (optionalBoolean(args, "redo") === true) {
          argv.push("--redo");
        }
        if (optionalBoolean(args, "transform") === true) {
          argv.push("--transform");
        }
        const scene = optionalObject(args, "scene");
        const patch = optionalObject(args, "patch");
        if (scene !== undefined && patch !== undefined) {
          throw new McpToolArgumentError(
            "scene and patch are mutually exclusive",
          );
        }
        if (scene !== undefined) {
          stdin = JSON.stringify(scene);
          argv.push("--stdin");
        } else if (patch !== undefined) {
          stdin = JSON.stringify(patch);
          argv.push("--merge", "-");
        }
      }
      break;
    }
    case "commit": {
      argv.push("commit");
      const draftId = optionalString(args, "draft_id");
      if (draftId !== undefined) {
        argv.push(draftId);
      }
      const message = optionalString(args, "message");
      if (message !== undefined) {
        argv.push("-m", message);
      }
      break;
    }
    case "capture":
      argv.push("capture");
      break;
    case "inspect": {
      argv.push("inspect", requiredString(args, "asset"));
      const layer = optionalString(args, "layer");
      if (layer !== undefined) {
        argv.push("--layer", layer);
      }
      break;
    }
    case "project": {
      const projectAction = action(args, ["ls", "create", "switch"], "ls");
      argv.push("project", projectAction);
      if (projectAction !== "ls") {
        argv.push(requiredString(args, "value"));
      }
      break;
    }
    case "space": {
      const spaceAction = action(
        args,
        ["ls", "create", "switch", "delete", "restore", "trash"],
        "ls",
      );
      argv.push("space", spaceAction);
      if (spaceAction !== "ls" && spaceAction !== "trash") {
        argv.push(requiredString(args, "value"));
      }
      if (spaceAction === "create") {
        const from = optionalString(args, "from");
        if (from !== undefined) {
          argv.push("--from", from);
        }
      }
      break;
    }
    case "connect":
      argv.push("connect", requiredString(args, "target"));
      break;
    default:
      throw new McpToolArgumentError(`Unknown tool: ${name}`);
  }

  return {
    argv: withJson(argv),
    ...(stdin === undefined ? {} : { stdin }),
  };
}
