import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";

import {
  HumanBoardError,
  OWNER_ID,
  SCHEMA_VERSION,
  SqliteStorageAdapter,
  type Asset,
} from "@humanboard/core-engine";
import { sceneContentHash, type Scene } from "@humanboard/schema";

import { LocalAppService } from "../src/local-app-service";
import { parseCliArgs } from "../src/parser";
import { watchLocalServer } from "../src/server-runtime";

const CLI_PATH = resolve(import.meta.dir, "../src/main.ts");
const temporaryDirectories: string[] = [];

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-cli-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  temporaryDirectories.push(root);
  const home = join(root, "home");
  return {
    root,
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HUMANBOARD_HOME: home,
      HUMANBOARD_DB: join(home, "humanboard.sqlite"),
      HUMANBOARD_BLOBS: join(home, "blobs"),
      HUMANBOARD_CACHE: join(home, "cache"),
      HUMANBOARD_SESSION: "cli-integration-session",
      HUMANBOARD_NO_AUTO_START: "1",
    },
  };
}

async function run(
  fixtureValue: Fixture,
  args: readonly string[],
  cwd = fixtureValue.cwd,
  envOverride: Readonly<Record<string, string>> = {},
): Promise<CliRun> {
  const processHandle = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { ...fixtureValue.env, ...envOverride },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runJson<T>(
  fixtureValue: Fixture,
  args: readonly string[],
  cwd = fixtureValue.cwd,
  envOverride: Readonly<Record<string, string>> = {},
): Promise<T> {
  const result = await run(fixtureValue, args, cwd, envOverride);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

function filePathFromUrl(url: string): string {
  expect(url.startsWith("file://")).toBe(true);
  return fileURLToPath(url);
}

async function fixtureAssets(fx: Fixture): Promise<Asset[]> {
  const storage = new SqliteStorageAdapter({
    databasePath: fx.env.HUMANBOARD_DB!,
  });
  try {
    const binding = JSON.parse(
      await readFile(join(fx.cwd, ".humanboard"), "utf8"),
    ) as { space_id: string };
    return await storage.listAssets(binding.space_id);
  } finally {
    storage.close();
  }
}

async function seedStatusLayers(fx: Fixture): Promise<{
  readonly mainIds: readonly string[];
  readonly branchHeadId: string;
  readonly branchMiddleId: string;
  readonly branchTailId: string;
}> {
  const storage = new SqliteStorageAdapter({
    databasePath: fx.env.HUMANBOARD_DB!,
  });
  try {
    const binding = JSON.parse(
      await readFile(join(fx.cwd, ".humanboard"), "utf8"),
    ) as { space_id: string };
    const space = await storage.getSpace(binding.space_id);
    if (!space) {
      throw new Error("Fixture Space is missing");
    }
    const scene: Scene = { nodes: [], edges: [], strokes: [], assets: [] };
    const contentHash = sceneContentHash(scene) as `sha256:${string}`;
    const existing = await storage.listLayers(space.id);
    const mainIds = [existing[0]!.id];
    let parentId = existing[0]!.id;

    const append = async (parent: string, title: string): Promise<string> => {
      const layer = await storage.appendLayer({
        layer: {
          id: ulid(),
          space_id: space.id,
          seq_origin: null,
          parent_id: parent,
          kind: "derive",
          redo_of: null,
          title,
          title_source: "agent",
          created_at: new Date().toISOString(),
          author: { kind: "cli", name: "test" },
          schema_version: SCHEMA_VERSION,
          content_hash: contentHash,
          owner_id: OWNER_ID,
        },
        scene,
      });
      return layer.id;
    };

    for (let index = 2; index <= 52; index += 1) {
      parentId = await append(parentId, `main ${index}`);
      mainIds.push(parentId);
    }

    let branchParentId = mainIds[9]!;
    const branchIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      branchParentId = await append(branchParentId, `branch ${index}`);
      branchIds.push(branchParentId);
    }
    await storage.setSpaceActiveLayer(space.id, mainIds.at(-1)!);
    return {
      mainIds,
      branchHeadId: branchIds[0]!,
      branchMiddleId: branchIds[1]!,
      branchTailId: branchIds[2]!,
    };
  } finally {
    storage.close();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("human CLI integration", () => {
  test("runs init -> project -> space -> draft -> commit -> get -> diff", async () => {
    const fx = await fixture();
    const initialized = await runJson<{
      project_id: string;
      space_id: string;
      config: string;
      created: boolean;
    }>(fx, ["init", "--json"]);
    expect(initialized.created).toBe(true);
    expect(existsSync(initialized.config)).toBe(true);
    expect(initialized.config.endsWith("/.humanboard")).toBe(true);

    const project = await runJson<{
      project_id: string;
      name: string;
      current_space_id: string;
    }>(fx, ["project", "create", "demo", "--json"]);
    expect(project.name).toBe("demo");
    expect(project.project_id).not.toBe(initialized.project_id);

    const space = await runJson<{
      space_id: string;
      name: string;
      layer_count: number;
      switched: boolean;
    }>(fx, ["space", "create", "flow", "--json"]);
    expect(space.name).toBe("flow");
    expect(space.layer_count).toBe(1);
    expect(space.switched).toBe(true);

    const binding = JSON.parse(
      await readFile(join(fx.cwd, ".humanboard"), "utf8"),
    ) as { project_id: string; space_id: string };
    expect(binding.project_id).toBe(project.project_id);
    expect(binding.space_id).toBe(space.space_id);

    const scenePath = join(fx.cwd, "scene.json");
    await writeFile(
      scenePath,
      JSON.stringify({
        nodes: [
          {
            id: "n1",
            kind: "service",
            title: "API",
            rect: { x: 100, y: 100, w: 180, h: 80 },
          },
        ],
        edges: [],
        strokes: [
          {
            id: "s1",
            tool: "pen",
            color: "#ff0000",
            width: 2,
            points: [
              [90, 90],
              [310, 210],
            ],
          },
        ],
        assets: [],
      }),
      "utf8",
    );

    const draft = await runJson<{
      draft_id: string;
      kind: string;
      parent_id: string;
      warnings: unknown[];
    }>(fx, ["draft", "--file", "scene.json", "--json"]);
    expect(draft.kind).toBe("derive");
    expect(draft.warnings).toEqual([]);

    const commit = await runJson<{
      layer_id: string;
      short_id: string;
      parent_id: string;
      content_hash: string;
      warnings: unknown[];
    }>(fx, ["commit", "-m", "新增 API 服务", "--json"]);
    expect(commit.short_id).toBe("L2");
    expect(commit.parent_id).toBe(draft.parent_id);
    expect(commit.content_hash.startsWith("sha256:")).toBe(true);
    expect(commit.warnings).toEqual([]);

    const get = await runJson<{
      layer: { id: string; short_id: string };
      render: { url: string; bounds: unknown };
      warnings: unknown[];
    }>(fx, ["get", "L1", "--format", "both", "--json"]);
    expect(get.layer.short_id).toBe("L1");
    const getPath = filePathFromUrl(get.render.url);
    expect(existsSync(getPath)).toBe(true);
    expect(get.warnings).toEqual([]);

    const diff = await runJson<{
      mode: string;
      visual: {
        bounds: unknown;
        before: { url: string; bounds: unknown };
        after: { url: string; bounds: unknown };
        highlight: { url: string; bounds: unknown };
        boxes: unknown[];
      };
      warnings: unknown[];
    }>(fx, ["diff", "L1", "L2", "--json"]);
    expect(diff.mode).toBe("transform");
    expect(diff.warnings).toEqual([]);
    expect(diff.visual.before.bounds).toEqual(diff.visual.bounds);
    expect(diff.visual.after.bounds).toEqual(diff.visual.bounds);
    expect(diff.visual.highlight.bounds).toEqual(diff.visual.bounds);
    expect(diff.visual.boxes.length).toBeGreaterThanOrEqual(2);
    for (const url of [
      diff.visual.before.url,
      diff.visual.after.url,
      diff.visual.highlight.url,
    ]) {
      expect(existsSync(filePathFromUrl(url))).toBe(true);
    }
  });

  test("injects an open-ended SKILL.md without overwriting an existing file", async () => {
    const fx = await fixture();
    const initialized = await runJson<{
      skill: { path: string; injected: boolean };
    }>(fx, ["init", "--skill", "--json"]);
    expect(initialized.skill.injected).toBe(true);
    expect(initialized.skill.path.endsWith("/SKILL.md")).toBe(true);
    const content = await readFile(initialized.skill.path, "utf8");
    expect(content).toContain("These are examples, not mandatory triggers.");
    expect(content).toContain("human capture");

    await writeFile(initialized.skill.path, "# custom\n", "utf8");
    const second = await runJson<{
      skill: { path: string; injected: boolean };
    }>(fx, ["init", "--skill", "--json"]);
    expect(second.skill.injected).toBe(false);
    expect(await readFile(initialized.skill.path, "utf8")).toBe("# custom\n");
  });

  test("status truncates large DAGs to main branch plus other branch heads and tails", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const seeded = await seedStatusLayers(fx);

    const status = await runJson<{
      layers: Array<{ id: string; seq: number }>;
      layers_truncated: boolean;
      total_layers: number;
      active_layer: string | null;
      warnings: Array<{ code: string }>;
    }>(fx, ["status", "--json"]);
    expect(status.total_layers).toBe(55);
    expect(status.layers_truncated).toBe(true);
    expect(status.layers).toHaveLength(54);
    expect(status.warnings.map((warning) => warning.code)).toContain(
      "W_SPACE_TRUNCATED",
    );
    expect(
      status.layers.some((layer) => layer.id === seeded.branchHeadId),
    ).toBe(true);
    expect(
      status.layers.some((layer) => layer.id === seeded.branchMiddleId),
    ).toBe(false);
    expect(
      status.layers.some((layer) => layer.id === seeded.branchTailId),
    ).toBe(true);
    expect(
      seeded.mainIds.every((id) =>
        status.layers.some((layer) => layer.id === id),
      ),
    ).toBe(true);

    const statusText = await run(fx, ["status"]);
    expect(statusText.exitCode).toBe(0);
    expect(statusText.stdout).toContain(
      "… 另有 1 层，使用 human layers --all 查看",
    );

    const binding = JSON.parse(
      await readFile(join(fx.cwd, ".humanboard"), "utf8"),
    ) as { space_id: string };
    const database = new Database(fx.env.HUMANBOARD_DB!);
    database
      .query("UPDATE spaces SET active_layer_id = NULL WHERE id = ?")
      .run(binding.space_id);
    database.close();
    const withoutActive = await runJson<{
      layers: Array<{ id: string }>;
      active_layer: string | null;
    }>(fx, ["status", "--json"]);
    expect(withoutActive.active_layer).toBeNull();
    expect(
      withoutActive.layers.some((layer) => layer.id === seeded.branchMiddleId),
    ).toBe(true);

    const layers = await runJson<{ layers: Array<{ id: string }> }>(fx, [
      "layers",
      "--json",
    ]);
    const layersAll = await runJson<{ layers: Array<{ id: string }> }>(fx, [
      "layers",
      "--all",
      "--json",
    ]);
    expect(layers.layers).toHaveLength(55);
    expect(layersAll.layers).toHaveLength(55);

    const help = await run(fx, ["help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(
      "always returns the full DAG; --all is accepted for compatibility",
    );
  });

  test("status reports registered assets that no Layer references", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    await writeFile(
      join(fx.cwd, "orphan.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const patchPath = join(fx.cwd, "orphan.json");
    await writeFile(
      patchPath,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "file", path: "orphan.png" },
            rect: { x: 0, y: 0, w: 1, h: 1 },
            z: 1,
          },
        ],
      }),
      "utf8",
    );
    await runJson(fx, ["draft", "--merge", patchPath, "--json"]);

    const status = await runJson<{
      warnings: Array<{ code: string; asset_id?: string }>;
    }>(fx, ["status", "--json"]);
    const warning = status.warnings.find(
      (item) => item.code === "W_ASSET_UNREFERENCED",
    );
    expect(typeof warning?.asset_id).toBe("string");
  });

  test("returns protocol errors and never writes partial stdout", async () => {
    const fx = await fixture();
    const missingProject = await run(fx, ["status", "--json"]);
    expect(missingProject.exitCode).toBe(3);
    expect(missingProject.stdout).toBe("");
    expect(JSON.parse(missingProject.stderr)).toEqual({
      error: {
        code: "E_PROJECT_REQUIRED",
        message: "No Project is selected and no .humanboard binding was found",
        details: {},
      },
    });

    const mutuallyExclusive = await run(fx, ["--json", "--text", "status"]);
    expect(mutuallyExclusive.exitCode).toBe(2);
    expect(mutuallyExclusive.stdout).toBe("");
    expect(JSON.parse(mutuallyExclusive.stderr).error.code).toBe("E_USAGE");

    const capture = await run(fx, ["capture", "--json"], fx.cwd, {
      HUMANBOARD_SERVER_URL: "http://127.0.0.1:59999",
      HUMANBOARD_NO_AUTO_START: "1",
    });
    expect(capture.exitCode).toBe(6);
    expect(capture.stdout).toBe("");
    expect(JSON.parse(capture.stderr).error.code).toBe("E_CONNECT");

    const watchWithoutServer = await run(
      fx,
      ["watch", "--timeout", "0.1", "--json"],
      fx.cwd,
      {
        HUMANBOARD_SERVER_URL: "http://127.0.0.1:59999",
        HUMANBOARD_NO_AUTO_START: "1",
      },
    );
    expect(watchWithoutServer.exitCode).toBe(6);
    expect(watchWithoutServer.stdout).toBe("");
    expect(JSON.parse(watchWithoutServer.stderr).error.code).toBe("E_CONNECT");

    const open = await run(fx, ["open", "--json"], fx.cwd, {
      HUMANBOARD_SERVER_URL: "http://127.0.0.1:59999",
    });
    expect(open.exitCode).toBe(6);
    expect(JSON.parse(open.stderr).error.code).toBe("E_CONNECT");

    const connect = await run(
      fx,
      ["connect", "http://127.0.0.1:59999", "--json"],
      fx.cwd,
      { HUMANBOARD_SERVER_URL: "http://127.0.0.1:59999" },
    );
    expect(connect.exitCode).toBe(6);
    expect(JSON.parse(connect.stderr).error.code).toBe("E_CONNECT");

    const invalidServe = await run(fx, [
      "serve",
      "--host",
      "0.0.0.0",
      "--json",
    ]);
    expect(invalidServe.exitCode).toBe(2);
    expect(JSON.parse(invalidServe.stderr).error.details.feature).toBe("serve");

    await runJson(fx, ["init", "--json"]);
    const missingDraftFile = await run(fx, [
      "draft",
      "--file",
      "missing.json",
      "--json",
    ]);
    expect(missingDraftFile.exitCode).toBe(2);
    expect(missingDraftFile.stdout).toBe("");
    expect(JSON.parse(missingDraftFile.stderr).error.code).toBe("E_USAGE");
  });

  test("resolves layer short IDs within the selected Space", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    await runJson(fx, ["space", "create", "second", "--json"]);

    const crossSpace = await run(fx, [
      "get",
      "L2",
      "--space",
      "main",
      "--json",
    ]);
    expect(crossSpace.exitCode).toBe(3);
    expect(crossSpace.stdout).toBe("");
    expect(JSON.parse(crossSpace.stderr).error.code).toBe("E_LAYER_NOT_FOUND");
  });

  test("finds .humanboard upward and persists project/space switches", async () => {
    const fx = await fixture();
    const initial = await runJson<{ project_id: string; space_id: string }>(
      fx,
      ["init", "--json"],
    );
    const other = await runJson<{ project_id: string }>(fx, [
      "project",
      "create",
      "other",
      "--json",
    ]);
    await runJson(fx, ["space", "create", "secondary", "--json"]);

    const projects = await runJson<{
      projects: Array<{ id: string; active: boolean }>;
    }>(fx, ["project", "ls", "--json"]);
    expect(
      projects.projects.find((project) => project.id === other.project_id)
        ?.active,
    ).toBe(true);

    const switchedProject = await runJson<{
      project_id: string;
      current_space_id: string;
    }>(fx, ["project", "switch", initial.project_id, "--json"]);
    expect(switchedProject.project_id).toBe(initial.project_id);

    const spaces = await runJson<{
      spaces: Array<{ id: string; active: boolean }>;
    }>(fx, ["space", "ls", "--json"]);
    expect(
      spaces.spaces.find(
        (space) => space.id === switchedProject.current_space_id,
      )?.active,
    ).toBe(true);

    const switchedSpace = await runJson<{ name: string; switched: boolean }>(
      fx,
      ["space", "switch", "main", "--json"],
    );
    expect(switchedSpace.name).toBe("main");
    expect(switchedSpace.switched).toBe(true);

    const nested = join(fx.cwd, "nested", "deeper");
    await mkdir(nested, { recursive: true });
    const fromNested = await runJson<{
      project: { id: string };
    }>(fx, ["status", "--json"], nested);
    expect(fromNested.project.id).toBe(initial.project_id);
  });

  test("accepts #001, 001, and ULID asset references in merge patches", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    await writeFile(
      join(fx.cwd, "asset.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const firstPatch = join(fx.cwd, "asset-source.json");
    await writeFile(
      firstPatch,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "file", path: "asset.png" },
            rect: { x: 10, y: 10, w: 100, h: 100 },
            z: 1,
          },
        ],
      }),
      "utf8",
    );
    const registered = await runJson<{
      registered_assets: Array<{
        asset_id: string;
        display_no: string;
        blob_hash: string | null;
      }>;
    }>(fx, ["draft", "--merge", firstPatch, "--json"]);
    expect(registered.registered_assets).toHaveLength(1);
    expect(registered.registered_assets[0]!.display_no).toBe("001");
    expect(registered.registered_assets[0]!.blob_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    const assetId = registered.registered_assets[0]!.asset_id;

    const inspectExisting = await runJson<{
      layer: null;
      content: { url: string; width: number; height: number };
      warnings: Array<{ code: string }>;
    }>(fx, ["inspect", "#001", "--json"]);
    expect(inspectExisting.layer).toBeNull();
    expect(inspectExisting.content.width).toBe(1);
    expect(inspectExisting.content.height).toBe(1);
    expect(existsSync(filePathFromUrl(inspectExisting.content.url))).toBe(true);
    expect(inspectExisting.warnings[0]!.code).toBe("W_ASSET_NOT_IN_LAYER");

    const inspectMissing = await run(fx, ["inspect", "#999", "--json"]);
    expect(inspectMissing.exitCode).toBe(3);
    expect(JSON.parse(inspectMissing.stderr).error.code).toBe(
      "E_ASSET_NOT_FOUND",
    );

    for (const reference of ["#001", "001", assetId]) {
      const patchPath = join(
        fx.cwd,
        `asset-${reference.replace("#", "hash")}.json`,
      );
      await writeFile(
        patchPath,
        JSON.stringify({
          upsert_assets: [
            {
              asset_id: reference,
              rect: { x: 20, y: 20, w: 100, h: 100 },
              z: 1,
            },
          ],
        }),
        "utf8",
      );
      const updated = await runJson<{ draft_id: string }>(fx, [
        "draft",
        "--merge",
        patchPath,
        "--json",
      ]);
      expect(updated.draft_id.length).toBe(26);
    }

    const committed = await runJson<{ short_id: string }>(fx, [
      "commit",
      "-m",
      "asset layer",
      "--json",
    ]);
    expect(committed.short_id).toBe("L2");

    const copied = await runJson<{
      space_id: string;
      created_from: string;
    }>(fx, ["space", "create", "copied", "--from", "L2", "--json"]);
    expect(copied.created_from.length).toBe(26);

    const copiedLayer = await runJson<{
      assets: Array<{
        asset_id: string;
        display_no: string;
        blob_hash: string | null;
      }>;
    }>(fx, ["get", "L1", "--format", "both", "--json"]);
    expect(copiedLayer.assets).toHaveLength(1);
    expect(copiedLayer.assets[0]!.display_no).toBe("001");
    expect(copiedLayer.assets[0]!.asset_id).not.toBe(assetId);
    expect(copiedLayer.assets[0]!.blob_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("supports transform, redo, draft show, and draft clear", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const scenePath = join(fx.cwd, "transform.json");
    await writeFile(
      scenePath,
      JSON.stringify({
        nodes: [
          {
            id: "n1",
            kind: "state",
            title: "Ready",
            rect: { x: 20, y: 20, w: 120, h: 60 },
          },
        ],
        edges: [],
        strokes: [],
        assets: [],
      }),
      "utf8",
    );

    const transform = await runJson<{ kind: string; parent_id: string }>(fx, [
      "draft",
      "--transform",
      "--file",
      "transform.json",
      "--json",
    ]);
    expect(transform.kind).toBe("transform");
    const transformed = await runJson<{ short_id: string }>(fx, [
      "commit",
      "-m",
      "first structure",
      "--json",
    ]);
    expect(transformed.short_id).toBe("L2");

    const redo = await runJson<{
      kind: string;
      parent_id: string;
      redo_of: string;
    }>(fx, [
      "draft",
      "--parent",
      "L2",
      "--redo",
      "--file",
      "transform.json",
      "--json",
    ]);
    expect(redo.kind).toBe("redo");
    expect(redo.parent_id).toBe(transform.parent_id);
    expect(redo.redo_of.length).toBe(26);

    const shown = await runJson<{ id: string; preview_url: string }>(fx, [
      "draft",
      "--show",
      "--json",
    ]);
    expect(shown.id.length).toBe(26);
    expect(existsSync(filePathFromUrl(shown.preview_url))).toBe(true);

    const cleared = await runJson<{ cleared: boolean }>(fx, [
      "draft",
      "--clear",
      "--json",
    ]);
    expect(cleared.cleared).toBe(true);

    const missingDraft = await run(fx, ["commit", "--json"]);
    expect(missingDraft.exitCode).toBe(4);
    expect(JSON.parse(missingDraft.stderr).error.code).toBe("E_NO_DRAFT");
  });

  test("human watch auto-starts a local server when health is unavailable", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);

    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("probe");
      },
    });
    const port = probe.port;
    await probe.stop(true);

    const children: Bun.Subprocess[] = [];
    let stdout = "";
    let stderr = "";
    try {
      const exitCode = await watchLocalServer({
        env: {
          ...fx.env,
          HUMANBOARD_PORT: String(port),
          HUMANBOARD_NO_AUTO_START: "",
        },
        cwd: fx.cwd,
        all: true,
        timeoutSeconds: 0.3,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
        autoStart: true,
        cliEntry: CLI_PATH,
        onAutoStart: (started) => {
          children.push(started);
        },
      });
      expect(exitCode).toBe(124);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr).error.code).toBe("E_WATCH_TIMEOUT");
      expect(children).toHaveLength(1);
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
    }
  });

  test("inspect composites an image and falls back to the latest referencing layer", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(fx.cwd, "pixel.png"), png);
    const patchPath = join(fx.cwd, "inspect-image.json");
    await writeFile(
      patchPath,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "file", path: "pixel.png" },
            rect: { x: 0, y: 0, w: 1, h: 1 },
            z: 1,
          },
        ],
        add_strokes: [
          {
            id: "s1",
            tool: "pen",
            color: "#ff0000",
            width: 1,
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      }),
      "utf8",
    );
    await runJson(fx, ["draft", "--merge", patchPath, "--json"]);
    await runJson(fx, ["commit", "-m", "image annotation", "--json"]);

    const inspected = await runJson<{
      asset: { display_no: string; source: { width: number; height: number } };
      layer: { short_id: string };
      content: {
        url: string;
        width: number;
        height: number;
        overlaid_strokes: string[];
      };
      warnings: Array<{ code: string }>;
    }>(fx, ["inspect", "#001", "--json"]);
    expect(inspected.asset.display_no).toBe("001");
    expect(inspected.asset.source).toMatchObject({ width: 1, height: 1 });
    expect(inspected.layer.short_id).toBe("L2");
    expect(inspected.content.width).toBe(1);
    expect(inspected.content.height).toBe(1);
    expect(inspected.content.overlaid_strokes).toEqual(["s1"]);
    expect(inspected.warnings[0]!.code).toBe("W_ASSET_NOT_IN_LAYER");
    expect(existsSync(filePathFromUrl(inspected.content.url))).toBe(true);
  });

  test("inspect composites a JPEG asset into a PNG", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const jpeg = await readFile(
      resolve(import.meta.dir, "../testdata/minimal.jpg"),
    );
    await writeFile(join(fx.cwd, "pixel.jpg"), jpeg);
    const patchPath = join(fx.cwd, "inspect-jpeg.json");
    await writeFile(
      patchPath,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "file", path: "pixel.jpg" },
            rect: { x: 0, y: 0, w: 3, h: 2 },
            z: 1,
          },
        ],
        add_strokes: [
          {
            id: "s-jpeg",
            tool: "pen",
            color: "#ff0000",
            width: 1,
            points: [
              [0, 0],
              [3, 2],
            ],
          },
        ],
      }),
      "utf8",
    );
    await runJson(fx, ["draft", "--merge", patchPath, "--json"]);
    await runJson(fx, ["commit", "-m", "jpeg annotation", "--json"]);

    const inspected = await runJson<{
      asset: { source: { width: number; height: number } };
      content: {
        url: string;
        width: number;
        height: number;
        overlaid_strokes: string[];
      };
      warnings: Array<{ code: string }>;
    }>(fx, ["inspect", "#001", "--json"]);
    expect(inspected.asset.source).toMatchObject({ width: 3, height: 2 });
    expect(inspected.content.width).toBe(3);
    expect(inspected.content.height).toBe(2);
    expect(inspected.content.overlaid_strokes).toEqual(["s-jpeg"]);
    expect(inspected.warnings[0]!.code).toBe("W_ASSET_NOT_IN_LAYER");

    const output = await readFile(filePathFromUrl(inspected.content.url));
    expect(Array.from(output.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  test("draft rejects SSRF and malformed URL sources before registration", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const blockedUrls = [
      "http://127.0.0.1:4317/private",
      "http://192.0.2.7/private",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "not a url",
    ];

    for (const [index, url] of blockedUrls.entries()) {
      const patchPath = join(fx.cwd, `blocked-url-${index}.json`);
      await writeFile(
        patchPath,
        JSON.stringify({
          upsert_assets: [
            {
              source: { kind: "url", url },
              rect: { x: 0, y: 0, w: 100, h: 100 },
              z: 1,
            },
          ],
        }),
        "utf8",
      );
      const blocked = await run(fx, ["draft", "--merge", patchPath, "--json"]);
      expect(blocked.exitCode).toBe(3);
      expect(JSON.parse(blocked.stderr).error.code).toBe("E_URL_BLOCKED");
    }

    const missingDraft = await run(fx, ["draft", "--show", "--json"]);
    expect(missingDraft.exitCode).toBe(4);
    expect(JSON.parse(missingDraft.stderr).error.code).toBe("E_NO_DRAFT");
    expect(await fixtureAssets(fx)).toEqual([]);
  });

  test("missing file sources do not leave a Draft or Asset", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const patchPath = join(fx.cwd, "missing-file.json");
    await writeFile(
      patchPath,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "file", path: "does-not-exist.png" },
            rect: { x: 0, y: 0, w: 100, h: 100 },
            z: 1,
          },
        ],
      }),
      "utf8",
    );

    const failed = await run(fx, ["draft", "--merge", patchPath, "--json"]);
    expect(failed.exitCode).toBe(2);
    expect(JSON.parse(failed.stderr).error.code).toBe("E_USAGE");
    const missingDraft = await run(fx, ["draft", "--show", "--json"]);
    expect(JSON.parse(missingDraft.stderr).error.code).toBe("E_NO_DRAFT");
    expect(await fixtureAssets(fx)).toEqual([]);
  });

  test("Space covers resolve read-only without changing the binding or active views", async () => {
    const fx = await fixture();
    const initial = await runJson<{ project_id: string; space_id: string }>(
      fx,
      ["init", "--json"],
    );
    const other = await runJson<{ space_id: string }>(fx, [
      "space",
      "create",
      "cover target",
      "--json",
    ]);
    const bindingBefore = await readFile(join(fx.cwd, ".humanboard"), "utf8");
    const storage = new SqliteStorageAdapter({
      databasePath: fx.env.HUMANBOARD_DB!,
    });
    const before = await storage.listSpaces(initial.project_id);
    const service = await LocalAppService.create({ cwd: fx.cwd, env: fx.env });
    try {
      const result = await service.execute(
        { kind: "status" },
        {
          project: initial.project_id,
          space: initial.space_id,
          output: "json",
        },
      );
      const summaries = (
        result.data as {
          spaces: {
            id: string;
            cover_layer_id: string | null;
            layer_count: number;
          }[];
        }
      ).spaces;
      expect(summaries).toHaveLength(2);
      const cover = summaries.find((s) => s.id === other.space_id)!;
      expect(cover.cover_layer_id).toBeTruthy();
      expect(cover.layer_count).toBe(1);
      const preview = await service.execute(
        {
          kind: "get",
          layer: cover.cover_layer_id!,
          format: "render",
          withStrokes: false,
        },
        { project: initial.project_id, space: other.space_id, output: "json" },
      );
      expect(
        (preview.data as { render: { url: string } }).render.url,
      ).toEndWith(".png");
      expect(await readFile(join(fx.cwd, ".humanboard"), "utf8")).toBe(
        bindingBefore,
      );
      expect(await storage.listSpaces(initial.project_id)).toEqual(before);
    } finally {
      service.close();
      storage.close();
    }
  });

  test("applies a fetched URL title and degrades to W_TITLE_PENDING", async () => {
    const fx = await fixture();
    await runJson(fx, ["init", "--json"]);
    const patchPath = join(fx.cwd, "url-title.json");
    await writeFile(
      patchPath,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "url", url: "https://1.1.1.1/docs" },
            rect: { x: 0, y: 0, w: 100, h: 100 },
            z: 1,
          },
        ],
      }),
      "utf8",
    );

    const service = await LocalAppService.create({
      cwd: fx.cwd,
      env: fx.env,
      urlSourceValidator: async () => undefined,
      urlSourceInspector: async () => ({
        title: "Fetched page title",
        description: "A readable summary of the reference.",
      }),
    });
    try {
      const parsed = parseCliArgs(["draft", "--merge", patchPath, "--json"]);
      const result = await service.execute(parsed.command, parsed.global);
      const data = result.data as {
        registered_assets: Array<{
          asset_id: string;
          title: string;
          title_source: string;
        }>;
        warnings: Array<{ code: string }>;
      };
      expect(data.registered_assets[0]).toMatchObject({
        title: "Fetched page title",
        title_source: "pending",
        description: "A readable summary of the reference.",
      });
      expect(data.warnings).toEqual([]);
      expect(
        (await service.getAsset(data.registered_assets[0]!.asset_id))?.title,
      ).toBe("Fetched page title");
      expect(
        (await service.getAsset(data.registered_assets[0]!.asset_id))
          ?.description,
      ).toBe("A readable summary of the reference.");
    } finally {
      service.close();
    }

    const failureFixture = await fixture();
    await runJson(failureFixture, ["init", "--json"]);
    const failurePatch = join(failureFixture.cwd, "url-title-failure.json");
    await writeFile(
      failurePatch,
      JSON.stringify({
        upsert_assets: [
          {
            source: { kind: "url", url: "https://1.1.1.1/missing" },
            rect: { x: 0, y: 0, w: 100, h: 100 },
            z: 1,
          },
          {
            source: { kind: "url", url: "https://1.1.1.1/wrong-type" },
            rect: { x: 120, y: 0, w: 100, h: 100 },
            z: 2,
          },
        ],
      }),
      "utf8",
    );
    const failureService = await LocalAppService.create({
      cwd: failureFixture.cwd,
      env: failureFixture.env,
      urlSourceValidator: async () => undefined,
      urlSourceInspector: async (url) => {
        if (url.endsWith("/wrong-type")) {
          throw new HumanBoardError(
            "E_URL_BLOCKED",
            "URL response Content-Type is not text/html or text/plain",
            { reason: "fetch_failed" },
          );
        }
        throw new HumanBoardError("E_NOT_FOUND", "URL returned HTTP 404");
      },
    });
    try {
      const parsed = parseCliArgs(["draft", "--merge", failurePatch, "--json"]);
      const result = await failureService.execute(
        parsed.command,
        parsed.global,
      );
      const data = result.data as {
        registered_assets: Array<{
          asset_id: string;
          title: string;
          title_source: string;
        }>;
        warnings: Array<{
          code: string;
          message: string;
          asset_id?: string;
        }>;
      };
      expect(data.registered_assets[0]).toMatchObject({
        title: "",
        title_source: "pending",
      });
      expect(data.registered_assets[1]).toMatchObject({
        title: "",
        title_source: "pending",
      });
      expect(data.warnings).toEqual(
        data.registered_assets.map((asset) => ({
          code: "W_TITLE_PENDING",
          message:
            "URL title could not be fetched; the Asset keeps a pending title",
          asset_id: asset.asset_id,
        })),
      );
    } finally {
      failureService.close();
    }
  });
});
