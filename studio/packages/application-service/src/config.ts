import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ulid } from "ulid";

import { HumanBoardError } from "@humanboard/core-engine";

export interface RuntimePaths {
  readonly home: string;
  readonly database: string;
  readonly blobs: string;
  readonly cache: string;
  readonly sessionFile: string;
  readonly configFile: string;
  readonly bindingFile?: string;
}

export interface ProjectBinding {
  readonly project_id: string;
  readonly space_id: string;
  readonly path: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** Stable across CLI invocations; explicit IDs separate agents sharing a terminal. */
export function connectedCliSessionId(env: Environment, cwd: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        runtimeInstanceId(resolveRuntimePaths(env, cwd)),
        realpathSync(resolve(cwd)),
        env.HUMANBOARD_SESSION?.trim() ||
          env.TERM_SESSION_ID ||
          env.WT_SESSION ||
          env.TMUX_PANE ||
          "default",
      ]),
    )
    .digest("hex");
}

function expandHome(value: string, home: string): string {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return value;
}

function absolutePath(value: string, cwd: string, home: string): string {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function resolveRuntimePaths(
  env: Environment,
  cwd: string,
): RuntimePaths {
  const userHome = homedir();
  const configuredHome = env.HUMANBOARD_HOME;
  const home =
    configuredHome === undefined || configuredHome.length === 0
      ? join(userHome, ".humanboard")
      : absolutePath(configuredHome, cwd, userHome);
  const configuredDb = env.HUMANBOARD_DB;
  const configuredBlobs = env.HUMANBOARD_BLOBS;
  const configuredCache = env.HUMANBOARD_CACHE;
  const sessionId = env.HUMANBOARD_SESSION?.trim();
  const bindingFile =
    env.HUMANBOARD_SESSION_BINDING === "1" &&
    sessionId !== undefined &&
    sessionId.length > 0
      ? join(
          home,
          "sessions",
          createHash("sha256").update(sessionId).digest("hex"),
          "binding.json",
        )
      : undefined;

  return {
    home,
    database:
      configuredDb === undefined || configuredDb.length === 0
        ? join(home, "humanboard.sqlite")
        : absolutePath(configuredDb, cwd, userHome),
    blobs:
      configuredBlobs === undefined || configuredBlobs.length === 0
        ? join(home, "blobs")
        : absolutePath(configuredBlobs, cwd, userHome),
    cache:
      configuredCache === undefined || configuredCache.length === 0
        ? join(home, "cache")
        : absolutePath(configuredCache, cwd, userHome),
    sessionFile: join(home, "session"),
    configFile: join(home, "config.json"),
    ...(bindingFile === undefined ? {} : { bindingFile }),
  };
}

export async function ensureRuntimeDirectories(
  paths: RuntimePaths,
): Promise<void> {
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(dirname(paths.database), { recursive: true }),
    mkdir(paths.blobs, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    ...(paths.bindingFile === undefined
      ? []
      : [mkdir(dirname(paths.bindingFile), { recursive: true })]),
  ]);
}

function parseBinding(content: string, path: string): ProjectBinding {
  let projectId: string | undefined;
  let spaceId: string | undefined;

  try {
    const parsed: unknown = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      projectId =
        typeof record.project_id === "string" ? record.project_id : undefined;
      spaceId =
        typeof record.space_id === "string" ? record.space_id : undefined;
    }
  } catch {
    for (const line of content.split(/\r?\n/)) {
      const match = /^(project_id|space_id)=(.*)$/.exec(line.trim());
      if (match?.[1] === "project_id") {
        projectId = match[2];
      } else if (match?.[1] === "space_id") {
        spaceId = match[2];
      }
    }
  }

  if (!projectId || !spaceId) {
    throw new HumanBoardError(
      "E_USAGE",
      `Invalid .humanboard binding at ${path}`,
      { path },
    );
  }
  return { project_id: projectId, space_id: spaceId, path };
}

export async function findProjectBinding(
  startDirectory: string,
): Promise<ProjectBinding | null> {
  let directory = resolve(startDirectory);

  while (true) {
    const path = join(directory, ".humanboard");
    try {
      const content = await readFile(path, "utf8");
      return parseBinding(content, path);
    } catch (error) {
      if (error instanceof HumanBoardError) {
        throw error;
      }
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "EISDIR") {
        throw new HumanBoardError("E_USAGE", `Cannot read ${path}`, {
          path,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export async function findProjectBindingFile(
  path: string,
): Promise<ProjectBinding | null> {
  try {
    const content = await readFile(path, "utf8");
    return parseBinding(content, path);
  } catch (error) {
    if (error instanceof HumanBoardError) {
      throw error;
    }
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw new HumanBoardError("E_USAGE", `Cannot read ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function writeProjectBindingFile(
  path: string,
  projectId: string,
  spaceId: string,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        project_id: projectId,
        space_id: spaceId,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

export async function writeProjectBinding(
  binding: ProjectBinding | null,
  cwd: string,
  projectId: string,
  spaceId: string,
): Promise<string> {
  const path = binding?.path ?? join(cwd, ".humanboard");
  return writeProjectBindingFile(path, projectId, spaceId);
}

export async function resolveSessionId(
  env: Environment,
  paths: RuntimePaths,
): Promise<string> {
  const configured = env.HUMANBOARD_SESSION;
  if (configured !== undefined && configured.trim().length > 0) {
    return configured.trim();
  }

  try {
    const stored = (await readFile(paths.sessionFile, "utf8")).trim();
    if (stored.length > 0) {
      return stored;
    }
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Cannot read session file ${paths.sessionFile}`,
        {
          path: paths.sessionFile,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  const sessionId = ulid();
  await writeFile(paths.sessionFile, `${sessionId}\n`, "utf8");
  return sessionId;
}

export function defaultProjectName(cwd: string): string {
  const name = basename(resolve(cwd));
  return name.length > 0 ? name : "humanboard";
}

export function runtimeInstanceId(paths: RuntimePaths): string {
  let existing = resolve(paths.database);
  const missing: string[] = [];
  // Canonicalize the nearest existing ancestor, including before SQLite creates its file.
  for (;;) {
    try {
      const canonical = join(realpathSync(existing), ...missing.reverse());
      return createHash("sha256").update(canonical).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}
