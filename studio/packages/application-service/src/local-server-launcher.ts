import { closeSync, openSync, fchmodSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { HumanBoardError } from "@humanboard/core-engine";
import { configuredServer } from "./client-actions";
import {
  resolveRuntimePaths,
  runtimeInstanceId,
  type Environment,
} from "./config";
import {
  clearLocalServerState,
  processIsAlive,
  readLocalServerState,
  writeLocalServerState,
} from "./local-server-state";
import { checkServerHealth } from "./server-health";
export interface LocalServerLaunchOptions {
  readonly env: Environment;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly onAutoStart?: (child: Bun.Subprocess) => void;
}
async function availablePort(
  preferred: number,
  strict: boolean,
): Promise<number> {
  const probe = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const selected =
          address && typeof address === "object" ? address.port : 0;
        server.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
  try {
    return await probe(preferred);
  } catch (error) {
    if (strict)
      throw new HumanBoardError(
        "E_CONNECT",
        "Requested local port is already occupied; choose another HUMANBOARD_PORT",
        { port: preferred },
      );
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return probe(0);
  }
}
export async function ensureManagedLocalServer(
  options: LocalServerLaunchOptions,
): Promise<URL> {
  const paths = resolveRuntimePaths(options.env, options.cwd),
    expected = runtimeInstanceId(paths);
  const initial = await configuredServer(options.env, paths);
  const healthy = async (url: string) =>
    checkServerHealth(new URL(url), { token: initial.token, timeoutMs: 500 });
  if (initial.explicit) {
    const status = await healthy(initial.serverUrl);
    if (!status.healthy)
      throw new HumanBoardError(
        status.reason === "auth" ? "E_AUTH" : "E_CONNECT",
        "Configured HumanBoard server is unavailable",
        { reason: status.reason },
      );
    return new URL(initial.serverUrl);
  }
  const first = await healthy(initial.serverUrl);
  if (first.healthy && first.instanceId === expected)
    return new URL(initial.serverUrl);
  if (options.env.HUMANBOARD_NO_AUTO_START === "1")
    throw new HumanBoardError(
      "E_CONNECT",
      "Local HumanBoard server is not running",
      { reason: "auto_start_disabled" },
    );
  await mkdir(paths.home, { recursive: true });
  const lockPath = join(paths.home, "server-start.lock"),
    deadline = Date.now() + 15_000;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  while (!lock) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      lock = handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const value = JSON.parse(await readFile(lockPath, "utf8"));
        if (Number.isInteger(value.pid) && !processIsAlive(value.pid)) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > 15_000) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch {}
      }
      if (Date.now() > deadline)
        throw new HumanBoardError(
          "E_CONNECT",
          "Another CLI is still starting this data directory's server",
          { lock_path: lockPath },
        );
      await Bun.sleep(100);
    }
  }
  try {
    const connection = await configuredServer(options.env, paths),
      status = await healthy(connection.serverUrl);
    if (status.healthy && status.instanceId === expected)
      return new URL(connection.serverUrl);
    const pending = await readLocalServerState(paths);
    if (pending && processIsAlive(pending.pid)) {
      if (status.reason === "auth")
        throw new HumanBoardError(
          "E_AUTH",
          "Local server authentication failed",
        );
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        const result = await healthy(pending.url);
        if (result.healthy && result.instanceId === expected)
          return new URL(pending.url);
        if (!processIsAlive(pending.pid)) break;
        await Bun.sleep(100);
      }
      if (processIsAlive(pending.pid))
        throw new HumanBoardError(
          "E_CONNECT",
          "The existing server process is not ready; inspect server.log before retrying",
          { pid: pending.pid, log_path: join(paths.home, "server.log") },
        );
    }
    const requested = Number(options.env.HUMANBOARD_PORT || 4317);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535)
      throw new HumanBoardError(
        "E_USAGE",
        "HUMANBOARD_PORT must be between 1 and 65535",
      );
    const port = await availablePort(requested, !!options.env.HUMANBOARD_PORT),
      url = new URL(`http://127.0.0.1:${port}`);
    const logPath = join(paths.home, "server.log"),
      fd = openSync(logPath, "a", 0o600);
    fchmodSync(fd, 0o600);
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn(
        [
          ...options.command,
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: options.cwd,
          env: Object.fromEntries(
            Object.entries(options.env).filter(
              (v): v is [string, string] => v[1] !== undefined,
            ),
          ),
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
          detached: true,
        },
      );
    } catch (error) {
      throw new HumanBoardError(
        "E_CONNECT",
        "Cannot start the local HumanBoard server",
        {
          cause: error instanceof Error ? error.message : String(error),
          log_path: logPath,
        },
      );
    } finally {
      closeSync(fd);
    }
    child.unref();
    await writeLocalServerState(paths, url.href, child.pid);
    try {
      options.onAutoStart?.(child);
    } catch {}
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const result = await healthy(url.href);
      if (result.healthy && result.instanceId === expected) return url;
      if (child.exitCode !== null)
        throw new HumanBoardError(
          "E_CONNECT",
          "Local server exited before becoming ready",
          { exit_code: child.exitCode, log_path: logPath },
        );
      await Bun.sleep(100);
    }
    throw new HumanBoardError(
      "E_CONNECT",
      "Local server is still starting; inspect server.log before retrying",
      { pid: child.pid, log_path: logPath },
    );
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Stop only the verified local process recorded for this data directory. */
export async function stopManagedLocalServer(options: {
  env: Environment;
  cwd: string;
}): Promise<{
  stopped: boolean;
  stopping?: boolean;
  pid?: number;
  url?: string;
}> {
  const paths = resolveRuntimePaths(options.env, options.cwd),
    state = await readLocalServerState(paths);
  if (!state) return { stopped: false };
  if (!processIsAlive(state.pid)) {
    await clearLocalServerState(paths, state.url, state.pid);
    return { stopped: false };
  }
  const health = await checkServerHealth(new URL(state.url), {
    token: options.env.HUMAN_AUTH_TOKEN,
    timeoutMs: 1000,
  });
  if (!health.healthy || health.instanceId !== runtimeInstanceId(paths))
    throw new HumanBoardError(
      health.reason === "auth" ? "E_AUTH" : "E_CONNECT",
      "Cannot verify the local server identity; no process was signalled",
      { pid: state.pid, url: state.url, reason: health.reason },
    );
  if (state.pid === process.pid)
    throw new HumanBoardError(
      "E_USAGE",
      "Use runtime.stop() when the server runs inside this process",
    );
  try {
    process.kill(state.pid, "SIGINT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      throw new HumanBoardError(
        "E_AUTH",
        "Operating system denied stopping the local process",
        { pid: state.pid },
      );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(state.pid))
    await Bun.sleep(50);
  if (processIsAlive(state.pid))
    return { stopped: false, stopping: true, pid: state.pid, url: state.url };
  await clearLocalServerState(paths, state.url, state.pid);
  return { stopped: true, pid: state.pid, url: state.url };
}
