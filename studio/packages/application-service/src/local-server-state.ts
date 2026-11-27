import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeInstanceId, type RuntimePaths } from "./config";
export interface LocalServerState {
  readonly version: 1;
  readonly url: string;
  readonly pid: number;
  readonly instance_id: string;
}
const file = (paths: RuntimePaths) => join(paths.home, "server-runtime.json");
export async function readLocalServerState(
  paths: RuntimePaths,
): Promise<LocalServerState | null> {
  try {
    const value = JSON.parse(
      await readFile(file(paths), "utf8"),
    ) as LocalServerState;
    if (
      value.version !== 1 ||
      value.instance_id !== runtimeInstanceId(paths) ||
      !Number.isInteger(value.pid) ||
      value.pid < 1
    )
      return null;
    const url = new URL(value.url);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port ||
      Number(url.port) < 1 ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
    return null;
  }
}
export async function writeLocalServerState(
  paths: RuntimePaths,
  url: string,
  pid: number,
): Promise<void> {
  const endpoint = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.port === "0"
  )
    return;
  await mkdir(paths.home, { recursive: true });
  const temporary = file(paths) + "." + crypto.randomUUID() + ".tmp";
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        url: endpoint.href,
        pid,
        instance_id: runtimeInstanceId(paths),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, file(paths));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function clearLocalServerState(
  paths: RuntimePaths,
  url: string,
  pid: number,
): Promise<void> {
  const current = await readLocalServerState(paths);
  if (current?.pid === pid && current.url === new URL(url).href)
    await rm(file(paths), { force: true });
}
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
