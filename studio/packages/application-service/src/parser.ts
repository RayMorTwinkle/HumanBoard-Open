import { HumanBoardError } from "@humanboard/core-engine";

export type OutputMode = "auto" | "json" | "text";

export interface GlobalOptions {
  readonly project?: string;
  readonly space?: string;
  readonly output: OutputMode;
}

export type ParsedCommand =
  | { readonly kind: "revision" }
  | { readonly kind: "status" }
  | { readonly kind: "layers"; readonly all: boolean }
  | {
      readonly kind: "get";
      readonly layer?: string;
      readonly format: "ast" | "render" | "both" | "index";
      readonly withStrokes: boolean;
    }
  | {
      readonly kind: "diff";
      readonly visual?: boolean;
      readonly layers: readonly string[];
    }
  | {
      readonly kind: "draft";
      readonly action: "create" | "show" | "clear";
      readonly parent?: string;
      readonly redo: boolean;
      readonly transform: boolean;
      readonly input:
        | { readonly kind: "none" }
        | { readonly kind: "file"; readonly path: string }
        | { readonly kind: "stdin" }
        | { readonly kind: "merge"; readonly path: string };
    }
  | {
      readonly kind: "commit";
      readonly draftId?: string;
      readonly message?: string;
    }
  | {
      readonly kind: "project";
      readonly action:
        | "ls"
        | "create"
        | "switch"
        | "delete"
        | "restore"
        | "trash";
      readonly value?: string;
    }
  | {
      readonly kind: "space";
      readonly action:
        | "ls"
        | "create"
        | "switch"
        | "delete"
        | "restore"
        | "trash";
      readonly value?: string;
      readonly from?: string;
    }
  | { readonly kind: "init"; readonly injectSkill: boolean }
  | { readonly kind: "capture" }
  | {
      readonly kind: "inspect";
      readonly asset: string;
      readonly layer?: string;
    }
  | {
      readonly kind: "watch";
      readonly since?: string;
      readonly all: boolean;
      readonly timeoutSeconds: number;
    }
  | {
      readonly kind: "serve";
      readonly stop?: boolean;
      readonly host: string;
      readonly port: number;
    }
  | { readonly kind: "open"; readonly layer?: string }
  | { readonly kind: "connect"; readonly target: string }
  | { readonly kind: "sync"; readonly action: "pull" }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

export interface ParsedCli {
  readonly command: ParsedCommand;
  readonly global: GlobalOptions;
}

interface ExtractedGlobal {
  readonly args: string[];
  readonly global: GlobalOptions;
}

interface ParsedOptions {
  readonly positionals: string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function usage(message: string): HumanBoardError {
  return new HumanBoardError("E_USAGE", message);
}

function setOutputMode(
  current: OutputMode,
  next: Exclude<OutputMode, "auto">,
): OutputMode {
  if (current !== "auto" && current !== next) {
    throw usage("--json and --text are mutually exclusive");
  }
  return next;
}

function extractGlobal(argv: readonly string[]): ExtractedGlobal {
  const args: string[] = [];
  let output: OutputMode = "auto";
  let project: string | undefined;
  let space: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") {
      output = setOutputMode(output, "json");
      continue;
    }
    if (token === "--text") {
      output = setOutputMode(output, "text");
      continue;
    }

    const projectEquals = token.match(/^--project=(.*)$/);
    if (projectEquals) {
      if (projectEquals[1]!.length === 0) {
        throw usage("--project requires a value");
      }
      project = projectEquals[1]!;
      continue;
    }
    if (token === "--project") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usage("--project requires a value");
      }
      project = value;
      index += 1;
      continue;
    }

    const spaceEquals = token.match(/^--space=(.*)$/);
    if (spaceEquals) {
      if (spaceEquals[1]!.length === 0) {
        throw usage("--space requires a value");
      }
      space = spaceEquals[1]!;
      continue;
    }
    if (token === "--space") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usage("--space requires a value");
      }
      space = value;
      index += 1;
      continue;
    }

    args.push(token);
  }

  return {
    args,
    global: {
      output,
      ...(project === undefined ? {} : { project }),
      ...(space === undefined ? {} : { space }),
    },
  };
}

function parseOptions(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
  maxPositionals: number,
): ParsedOptions {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (token.startsWith("-") && token !== "-") {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token : token.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

      if (booleanFlags.has(name)) {
        if (inlineValue !== undefined) {
          throw usage(`${name} does not take a value`);
        }
        if (flags.has(name)) {
          throw usage(`${name} may only be provided once`);
        }
        flags.add(name);
        continue;
      }

      if (valueFlags.has(name)) {
        if (values.has(name)) {
          throw usage(`${name} may only be provided once`);
        }
        const value = inlineValue ?? args[index + 1];
        if (value === undefined || value.length === 0) {
          throw usage(`${name} requires a value`);
        }
        if (inlineValue === undefined) {
          if (value.startsWith("-") && value !== "-") {
            throw usage(`${name} requires a value`);
          }
          index += 1;
        }
        values.set(name, value);
        continue;
      }

      throw usage(`Unknown option: ${name}`);
    }

    positionals.push(token);
  }

  if (positionals.length > maxPositionals) {
    throw usage(`Too many positional arguments: ${positionals.join(" ")}`);
  }
  return { positionals, values, flags };
}

function requireValue(
  options: ParsedOptions,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = options.values.get(name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseStatus(args: readonly string[]): ParsedCommand {
  parseOptions(args, new Set(), new Set(), 0);
  return { kind: "status" };
}

function parseLayers(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(), new Set(["--all"]), 0);
  return { kind: "layers", all: options.flags.has("--all") };
}

function parseGet(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(["--format"]),
    new Set(["--with-strokes"]),
    1,
  );
  const format = options.values.get("--format") ?? "ast";
  if (
    format !== "ast" &&
    format !== "render" &&
    format !== "both" &&
    format !== "index"
  ) {
    throw usage("--format must be ast, render, both, or index");
  }
  return {
    kind: "get",
    ...(options.positionals[0] === undefined
      ? {}
      : { layer: options.positionals[0] }),
    format,
    withStrokes: options.flags.has("--with-strokes"),
  };
}

function parseDiff(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(),
    new Set(["--visual", "--no-visual"]),
    2,
  );
  if (options.flags.has("--visual") && options.flags.has("--no-visual"))
    throw usage("Choose --visual or --no-visual");
  return {
    kind: "diff",
    layers: options.positionals,
    ...(options.flags.has("--visual")
      ? { visual: true }
      : options.flags.has("--no-visual")
        ? { visual: false }
        : {}),
  };
}

function parseDraft(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(["--parent", "--file", "--merge"]),
    new Set(["--redo", "--transform", "--stdin", "--show", "--clear"]),
    0,
  );
  const show = options.flags.has("--show");
  const clear = options.flags.has("--clear");
  if (show && clear) {
    throw usage("--show and --clear are mutually exclusive");
  }
  const redo = options.flags.has("--redo");
  const transform = options.flags.has("--transform");
  if (redo && transform) {
    throw usage("--redo and --transform are mutually exclusive");
  }

  const inputKinds = [
    options.values.has("--file"),
    options.flags.has("--stdin"),
    options.values.has("--merge"),
  ].filter(Boolean).length;
  if (inputKinds > 1) {
    throw usage("--file, --stdin, and --merge are mutually exclusive");
  }
  if ((show || clear) && inputKinds > 0) {
    throw usage("--show/--clear cannot be combined with draft input");
  }
  if ((show || clear) && options.values.has("--parent")) {
    throw usage("--parent cannot be combined with --show/--clear");
  }
  if ((show || clear) && (redo || transform)) {
    throw usage("--redo/--transform cannot be combined with --show/--clear");
  }

  let input: Extract<ParsedCommand, { kind: "draft" }>["input"];
  if (options.values.has("--file")) {
    input = { kind: "file", path: options.values.get("--file")! };
  } else if (options.flags.has("--stdin")) {
    input = { kind: "stdin" };
  } else if (options.values.has("--merge")) {
    input = { kind: "merge", path: options.values.get("--merge")! };
  } else {
    input = { kind: "none" };
  }

  return {
    kind: "draft",
    action: show ? "show" : clear ? "clear" : "create",
    ...(options.values.has("--parent")
      ? { parent: options.values.get("--parent")! }
      : {}),
    redo,
    transform,
    input,
  };
}

function parseCommit(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(["-m", "--message"]),
    new Set(),
    1,
  );
  const message = requireValue(options, ["-m", "--message"]);
  if (options.values.has("-m") && options.values.has("--message")) {
    throw usage("-m and --message are mutually exclusive");
  }
  return {
    kind: "commit",
    ...(options.positionals[0] === undefined
      ? {}
      : { draftId: options.positionals[0] }),
    ...(message === undefined ? {} : { message }),
  };
}

function parseProject(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(), new Set(), 2);
  const action = options.positionals[0];
  if (action === "ls") {
    if (options.positionals.length !== 1) {
      throw usage("project ls does not take an argument");
    }
    return { kind: "project", action: "ls" };
  }
  if (action === "create" || action === "switch") {
    const value = options.positionals[1];
    if (value === undefined) {
      throw usage(`project ${action} requires a value`);
    }
    if (options.positionals.length !== 2) {
      throw usage(`project ${action} takes exactly one value`);
    }
    return { kind: "project", action, value };
  }
  throw usage("project expects ls, create <name>, or switch <id|name>");
}

function parseSpace(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(["--from"]), new Set(), 2);
  const action = options.positionals[0];
  if (action === "ls" || action === "trash") {
    if (options.positionals.length !== 1 || options.values.has("--from")) {
      throw usage("space ls does not take an argument or --from");
    }
    return { kind: "space", action };
  }
  if (action === "create") {
    const value = options.positionals[1];
    if (value === undefined || options.positionals.length !== 2) {
      throw usage("space create requires exactly one name");
    }
    return {
      kind: "space",
      action: "create",
      value,
      ...(options.values.has("--from")
        ? { from: options.values.get("--from")! }
        : {}),
    };
  }
  if (action === "switch" || action === "delete" || action === "restore") {
    const value = options.positionals[1];
    if (
      value === undefined ||
      options.positionals.length !== 2 ||
      options.values.has("--from")
    ) {
      throw usage("space switch requires exactly one id or name");
    }
    return { kind: "space", action, value };
  }
  throw usage(
    "space expects ls, trash, create <name>, switch/delete/restore <id|name>",
  );
}

function parseCapture(args: readonly string[]): ParsedCommand {
  parseOptions(args, new Set(), new Set(), 0);
  return { kind: "capture" };
}

function parseInspect(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(["--layer"]), new Set(), 1);
  const asset = options.positionals[0];
  if (asset === undefined) {
    throw usage("inspect requires an asset reference");
  }
  return {
    kind: "inspect",
    asset,
    ...(options.values.has("--layer")
      ? { layer: options.values.get("--layer")! }
      : {}),
  };
}

function parseWatch(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(["--since", "--timeout"]),
    new Set(["--all"]),
    0,
  );
  const timeoutValue = options.values.get("--timeout") ?? "300";
  const timeoutSeconds = Number(timeoutValue);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw usage("--timeout must be a non-negative number of seconds");
  }
  return {
    kind: "watch",
    ...(options.values.has("--since")
      ? { since: options.values.get("--since")! }
      : {}),
    all: options.flags.has("--all"),
    timeoutSeconds,
  };
}

function parseServe(args: readonly string[]): ParsedCommand {
  const options = parseOptions(
    args,
    new Set(["--host", "--port"]),
    new Set(["--stop"]),
    0,
  );
  const host = options.values.get("--host") ?? "127.0.0.1";
  const portValue = options.values.get("--port") ?? "4317";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw usage("--port must be an integer between 1 and 65535");
  }
  if (options.flags.has("--stop")) {
    if (options.values.size)
      throw usage("--stop cannot be combined with --host or --port");
    return { kind: "serve", host, port, stop: true };
  }
  return { kind: "serve", host, port };
}

function parseOpen(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(["--layer"]), new Set(), 1);
  const positional = options.positionals[0];
  const flag = options.values.get("--layer");
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw usage("open layer arguments conflict");
  }
  const layer = positional ?? flag;
  return {
    kind: "open",
    ...(layer === undefined ? {} : { layer }),
  };
}

function parseConnect(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(), new Set(), 1);
  const target = options.positionals[0];
  if (target === undefined) {
    throw usage("connect requires a URL or token");
  }
  return { kind: "connect", target };
}

function parseInit(args: readonly string[]): ParsedCommand {
  const options = parseOptions(args, new Set(), new Set(["--skill"]), 0);
  return {
    kind: "init",
    injectSkill: options.flags.has("--skill"),
  };
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const { args, global } = extractGlobal(argv);
  const commandName = args[0];
  const rest = args.slice(1);

  if (commandName === undefined) {
    return { command: { kind: "status" }, global };
  }
  if (
    commandName === "help" ||
    commandName === "--help" ||
    commandName === "-h"
  ) {
    if (rest.length > 0) {
      throw usage("help does not take arguments");
    }
    return { command: { kind: "help" }, global };
  }
  if (["--version", "version", "-v"].includes(commandName)) {
    if (rest.length) throw usage("version takes no arguments");
    return { command: { kind: "version" }, global };
  }
  if (commandName === "--connect") {
    return { command: parseConnect(rest), global };
  }

  switch (commandName) {
    case "sync":
      if (
        rest.length !== 1 ||
        rest[0] !== "pull" ||
        !global.project ||
        !global.space
      )
        throw usage("Use human sync pull --project <id> --space <id>");
      return { command: { kind: "sync", action: "pull" }, global };
    case "revision":
      if (rest.length) throw usage("revision reads a JSON request from stdin");
      return { command: { kind: "revision" }, global };
    case "status":
      return { command: parseStatus(rest), global };
    case "layers":
      return { command: parseLayers(rest), global };
    case "get":
      return { command: parseGet(rest), global };
    case "diff":
      return { command: parseDiff(rest), global };
    case "draft":
      return { command: parseDraft(rest), global };
    case "commit":
      return { command: parseCommit(rest), global };
    case "project":
      return { command: parseProject(rest), global };
    case "space":
      return { command: parseSpace(rest), global };
    case "capture":
      return { command: parseCapture(rest), global };
    case "inspect":
      return { command: parseInspect(rest), global };
    case "watch":
      return { command: parseWatch(rest), global };
    case "serve":
      return { command: parseServe(rest), global };
    case "open":
      return { command: parseOpen(rest), global };
    case "connect":
      return { command: parseConnect(rest), global };
    case "init":
      return { command: parseInit(rest), global };
    default:
      throw usage(`Unknown command: ${commandName}`);
  }
}

export function outputModeForCommand(
  parsed: ParsedCli,
): Exclude<OutputMode, "auto"> {
  if (parsed.global.output !== "auto") {
    return parsed.global.output;
  }
  return parsed.command.kind === "status" ||
    parsed.command.kind === "layers" ||
    (parsed.command.kind === "get" && parsed.command.format === "index") ||
    parsed.command.kind === "serve" ||
    parsed.command.kind === "help" ||
    parsed.command.kind === "version"
    ? "text"
    : "json";
}
