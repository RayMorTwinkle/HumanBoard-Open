import { createInterface } from "node:readline";
import { Board, publicError } from "./board.mjs";

const board = new Board();
const str = { type: "string" };
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const card = obj({
  id: str,
  title: str,
  body: str,
  color: { enum: ["jade", "lavender", "amber", "coral"] },
  x: { type: "integer", minimum: 0, maximum: 800 },
  y: { type: "integer", minimum: 0, maximum: 436 },
});
const tools = new Map();
function define(name, description, inputSchema, run) {
  tools.set(name, { description, inputSchema, run });
}
define(
  "board_state",
  "读取分支、卡片、版本和分支头。默认分支为 main。",
  obj({ branch: str }, []),
  (a) => board.state(a.branch),
);
define("board_version", "读取不可变版本快照。", obj({ id: str }), (a) =>
  board.version(a.id),
);
define(
  "board_diff",
  "比较两个版本的卡片及其字段。",
  obj({ from: str, to: str }),
  (a) => board.compare(a.from, a.to),
);
define(
  "board_branch",
  "从指定版本创建提案分支。",
  obj({ name: str, from: str }),
  (a) => board.branch(a),
);
define(
  "board_commit",
  "基于当前版本提交完整卡片列表。建议在提案分支编辑。",
  obj({
    branch: str,
    base: str,
    cards: { type: "array", items: card, maxItems: 150 },
    message: str,
  }),
  (a) => board.commit({ ...a, author: "agent" }),
);
define(
  "board_merge",
  "先用 preview 查看三方合并，再以相同双端版本确认合入。",
  obj(
    {
      target: str,
      source: str,
      targetHead: str,
      sourceHead: str,
      preview: { type: "boolean" },
      resolutions: {
        type: "array",
        items: obj({
          id: str,
          field: str,
          use: { enum: ["target", "source"] },
        }),
      },
    },
    ["target", "source", "targetHead", "sourceHead", "preview"],
  ),
  (a) => board.merge({ ...a, author: "agent" }),
);

const protocolVersion = "2025-06-18";
let phase = "new";
const send = (response) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...response }) + "\n");
function failure(id, code, message) {
  send({ id, error: { code, message } });
}
function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Invalid JSON");
  }
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return failure(null, -32600, "Invalid request");
  const { id, method, params = {} } = req;
  if (id === undefined) {
    if (method === "notifications/initialized" && phase === "negotiated")
      phase = "ready";
    return;
  }
  const ok = (result) => send({ id, result });
  if (method === "ping") return ok({});
  if (method === "initialize" && phase === "new") {
    if (
      !params ||
      typeof params.protocolVersion !== "string" ||
      !params.clientInfo ||
      !params.capabilities
    )
      return failure(id, -32602, "Missing initialization parameters");
    phase = "negotiated";
    return ok({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "humanboard-open", version: "0.1.0" },
    });
  }
  if (phase !== "ready") return failure(id, -32002, "Initialization required");
  if (method === "tools/list")
    return ok({
      tools: [...tools].map(([name, { description, inputSchema }]) => ({
        name,
        description,
        inputSchema,
      })),
    });
  if (method !== "tools/call") return failure(id, -32601, "Method not found");
  const tool = tools.get(params?.name);
  if (!tool) return failure(id, -32602, "Unknown tool");
  const args = params.arguments ?? {};
  const schema = tool.inputSchema;
  if (
    typeof args !== "object" ||
    Array.isArray(args) ||
    schema.required.some((key) => !(key in args)) ||
    Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))
  ) {
    return failure(id, -32602, "Invalid tool arguments");
  }
  try {
    return ok({
      content: [{ type: "text", text: JSON.stringify(tool.run(args)) }],
    });
  } catch (error) {
    return ok({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify(publicError(error).body) },
      ],
    });
  }
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
lines.on("line", handle);
lines.on("close", () => board.close());
