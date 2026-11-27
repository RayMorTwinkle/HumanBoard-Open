import { prepareConnectedFiles } from "./file-transfer";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ERROR_EXIT_CODES,
  HumanBoardError,
  type HumanBoardErrorCode,
} from "@humanboard/core-engine";
import {
  runtimeInstanceId,
  connectedCliSessionId,
  resolveRuntimePaths,
  type Environment,
} from "./config";
import { configuredServer } from "./client-actions";
import { checkServerHealth } from "./server-health";
import type { ParsedCommand } from "./parser";
import type { CommandExecutionResult } from "@humanboard/server-self-hosted";

/** Route to the running service so CLI writes participate in watch and background jobs. */
export async function executeConnectedCommand(
  argv: readonly string[],
  command: ParsedCommand,
  cwd: string,
  env: Environment,
): Promise<CommandExecutionResult | null> {
  const connection = await configuredServer(env, resolveRuntimePaths(env, cwd));
  const explicit = connection.explicit;
  const url = new URL(connection.serverUrl);
  const token = connection.token;
  // A refused local socket should not cost fetch's retry/timeout on every offline CLI command.
  if (!explicit) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({
        host: "127.0.0.1",
        port: Number(url.port || 80),
      });
      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(75, () => finish(false));
    });
    if (!listening) return null;
  }

  const health = await checkServerHealth(url, { token, timeoutMs: 500 });
  if (
    !explicit &&
    health.instanceId !== runtimeInstanceId(resolveRuntimePaths(env, cwd))
  )
    return null;
  if (!health.healthy) {
    if (!explicit) return null;
    throw new HumanBoardError(
      health.reason === "auth" ? "E_AUTH" : "E_CONNECT",
      "Configured HumanBoard server is unavailable",
      { server_url: url.href, reason: health.reason },
    );
  }
  let args = [...argv],
    stdin: string | undefined;
  if (
    command.kind === "draft" &&
    command.action === "create" &&
    command.input
  ) {
    const input = command.input;
    if (
      input.kind === "stdin" ||
      (input.kind === "merge" && input.path === "-")
    )
      stdin = await Bun.stdin.text();
    else if (input.kind === "file" || input.kind === "merge") {
      stdin = await readFile(resolve(cwd, input.path), "utf8");
      const index = args.indexOf(input.kind === "file" ? "--file" : "--merge");
      if (input.kind === "file") args.splice(index, 2, "--stdin");
      else args.splice(index, 2, "--merge", "-");
    }
  }
  if (command.kind === "revision") stdin = await Bun.stdin.text();
  let fileBlobs: Record<string, string> | undefined;
  if (
    command.kind === "draft" &&
    command.action === "create" &&
    command.input?.kind === "merge" &&
    stdin !== undefined
  ) {
    const prepared = await prepareConnectedFiles(
      stdin,
      cwd,
      async (hash, data) => {
        let response: Response;
        try {
          response = await fetch(
            new URL(`/api/uploads/${encodeURIComponent(hash)}`, url),
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "X-HumanBoard-Client": "1",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: new Uint8Array(data),
              signal: AbortSignal.timeout(120_000),
            },
          );
        } catch {
          throw new HumanBoardError(
            "E_CONNECT",
            "Client asset upload was interrupted; draft was not sent",
          );
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
          } | null;
          const code = payload?.error?.code;
          throw new HumanBoardError(
            response.status !== 404 &&
            response.status !== 503 &&
            code &&
            Object.hasOwn(ERROR_EXIT_CODES, code)
              ? (code as HumanBoardErrorCode)
              : "E_CONNECT",
            response.status === 404
              ? "Server does not support client file uploads; update the server"
              : payload?.error?.message ||
                `File upload returned HTTP ${response.status}`,
          );
        }
        const uploaded = (await response.json().catch(() => null)) as {
          blob_hash?: string;
        } | null;
        if (!uploaded)
          throw new HumanBoardError(
            "E_CONNECT",
            "Server returned an invalid upload response; draft was not sent",
          );
        if (uploaded.blob_hash !== hash)
          throw new HumanBoardError(
            "E_HASH_MISMATCH",
            "Uploaded file hash does not match the client file",
          );
      },
    );
    stdin = prepared.stdin;
    fileBlobs = prepared.fileBlobs;
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/command", url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        argv: args,
        cli_session_id: connectedCliSessionId(env, cwd),
        ...(explicit ? {} : { cwd }),
        ...(stdin === undefined ? {} : { stdin }),
        ...(fileBlobs === undefined ? {} : { file_blobs: fileBlobs }),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new HumanBoardError(
      "E_CONNECT",
      "Command response was interrupted; check status before retrying a write",
      { cause: String(e) },
    );
  }
  const payload = (await response.json()) as CommandExecutionResult;
  if (!response.ok || payload.exitCode !== 0) {
    const code = payload.error?.code;
    throw new HumanBoardError(
      code && Object.hasOwn(ERROR_EXIT_CODES, code)
        ? (code as HumanBoardErrorCode)
        : "E_CONNECT",
      payload.error?.message || `HTTP ${response.status}`,
      payload.error?.details,
    );
  }
  return payload;
}
