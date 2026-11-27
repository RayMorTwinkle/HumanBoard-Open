import { version } from "../package.json";
import type { CommandResult } from "./output";
export const HUMANBOARD_VERSION = version;
export function humanVersion(): CommandResult {
  return { data: { version }, text: `HumanBoard ${version}` };
}
export function humanHelp(): CommandResult {
  const text = [
    "Usage: human [--project <id|name>] [--space <id|name>] [--json|--text] <command>",
    "",
    "Commands:",
    "  status",
    "  layers [--all]  (always returns the full DAG; --all is accepted for compatibility)",
    "  get [<layer>] [--format index|ast|render|both] [--with-strokes]",
    "  diff [<layer>] [<layer>] [--visual|--no-visual]",
    "  draft [--parent <layer>] [--redo|--transform] [--file <path>|--stdin|--merge <path>]",
    "  draft --show | --clear",
    "  commit [<draft_id>] [-m <title>]",
    "  project ls | create <name> | switch <id|name>",
    "  space ls | trash | create <name> [--from <layer>] | switch/delete/restore <id|name>",
    "  capture",
    "  inspect <asset> [--layer <id>]",
    "  watch [--since <layer>] [--timeout <s>] [--all]",
    "  serve [--host 127.0.0.1] [--port 4317] | serve --stop",
    "  open [<layer>] [--layer <id>]",
    "  connect <url|token>  (alias: --connect <url|token>)",
    "  sync pull --project <id> --space <id>  (pull a local replica from the configured remote)",
    "  init",
    "",
    "capture reads the connected frontend live view, including unsaved edits; it does not save.",
  ].join("\n");
  return { data: { usage: text }, text };
}
