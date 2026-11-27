import {
  HumanBoardError,
  type HumanBoardErrorDetails,
} from "@humanboard/core-engine";

import type { OutputMode } from "./parser";

export interface CommandResult {
  readonly data: unknown;
  readonly text: string;
}

export interface ErrorOutput {
  readonly code: string;
  readonly message: string;
  readonly details: HumanBoardErrorDetails;
  readonly exitCode: number;
}

function errorObject(error: unknown): ErrorOutput {
  if (error instanceof HumanBoardError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      exitCode: error.exitCode,
    };
  }
  return {
    code: "E_INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    details: {},
    exitCode: 1,
  };
}

export function renderError(error: unknown, mode: OutputMode): string {
  const normalized = errorObject(error);
  if (mode === "text") {
    return `Error [${normalized.code}]: ${normalized.message}\n`;
  }
  return `${JSON.stringify(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    },
    null,
    2,
  )}\n`;
}

export function exitCodeFor(error: unknown): number {
  return errorObject(error).exitCode;
}

/** `pretty` is for people at a terminal; piped output (agents, scripts) stays compact. */
export function renderResult(
  result: CommandResult,
  mode: Exclude<OutputMode, "auto">,
  pretty = true,
): string {
  if (mode === "text") {
    return result.text.endsWith("\n") ? result.text : `${result.text}\n`;
  }
  return `${JSON.stringify(result.data, null, pretty ? 2 : undefined)}\n`;
}
