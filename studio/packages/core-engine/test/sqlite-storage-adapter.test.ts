import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { sceneContentHash, type Scene } from "@humanboard/schema";

import { HumanBoardError } from "../src/domain/errors";
import type {
  Asset,
  Draft,
  NewLayerRecord,
  Project,
  Space,
} from "../src/domain/types";
import { OWNER_ID } from "../src/domain/types";
import { SqliteStorageAdapter } from "../src/storage/sqlite/sqlite-storage-adapter";
import { FakeClock, SequenceIds, TEST_AUTHOR, sceneWithNode } from "./helpers";

interface SqliteFixture {
  readonly adapter: SqliteStorageAdapter;
  readonly ids: SequenceIds;
  readonly clock: FakeClock;
  readonly project: Project;
  readonly space: Space;
}

async function createFixture(
  adapter = new SqliteStorageAdapter(),
): Promise<SqliteFixture> {
  const ids = new SequenceIds();
  const clock = new FakeClock();
  const project: Project = {
    id: ids.next(),
    name: "sqlite-project",
    root: "/tmp/sqlite-project",
    owner_id: OWNER_ID,
    created_at: clock.now().toISOString(),
  };
  await adapter.createProject(project);
  const space: Space = {
    id: ids.next(),
    project_id: project.id,
    name: "main",
    active_layer_id: null,
    owner_id: OWNER_ID,
    created_at: clock.now().toISOString(),
  };
  await adapter.createSpace(space);
  return { adapter, ids, clock, project, space };
}

function newLayer(
  fixture: SqliteFixture,
  scene: Scene,
  options: {
    parentId?: string | null;
    kind?: NewLayerRecord["kind"];
  } = {},
): NewLayerRecord {
  return {
    id: fixture.ids.next(),
    space_id: fixture.space.id,
    seq_origin: null,
    parent_id: options.parentId ?? null,
    kind: options.kind ?? (options.parentId ? "derive" : "root"),
    redo_of: null,
    title: "",
    title_source: "pending",
    created_at: fixture.clock.now().toISOString(),
    author: TEST_AUTHOR,
    schema_version: 1,
    content_hash: sceneContentHash(scene) as `sha256:${string}`,
    owner_id: OWNER_ID,
  };
}

function newDraft(
  fixture: SqliteFixture,
  scene: Scene,
  options: {
    id?: string;
    sessionId?: string;
    parentId?: string | null;
    kind?: Draft["kind"];
  } = {},
): Draft {
  const now = fixture.clock.now().toISOString();
  return {
    id: options.id ?? fixture.ids.next(),
    session_id: options.sessionId ?? "session-1",
    project_id: fixture.project.id,
    space_id: fixture.space.id,
    parent_id: options.parentId ?? null,
    kind: options.kind ?? "root",
    redo_of: null,
    scene,
    author: TEST_AUTHOR,
    created_at: now,
    updated_at: now,
    expires_at: new Date(
      fixture.clock.now().getTime() + 30 * 60 * 1000,
    ).toISOString(),
    status: "open",
    committed_layer_id: null,
  };
}

function newAsset(fixture: SqliteFixture, displayNo = "001"): Asset {
  return {
    asset_id: fixture.ids.next(),
    space_id: fixture.space.id,
    display_no: displayNo,
    type: "image",
    title: "screenshot",
    title_source: "pending",
    blob_hash: `sha256:${"a".repeat(64)}`,
    source_url: null,
    owner_id: OWNER_ID,
    created_at: fixture.clock.now().toISOString(),
  };
}

type LegacySchemaVersion = 1 | 2 | 3;

const LEGACY_NOW = "2026-10-22T00:00:00.000Z";
const LEGACY_SCENE = sceneWithNode("legacy-node", "legacy scene");
const LEGACY_SCENE_JSON = JSON.stringify(LEGACY_SCENE);
const LEGACY_LAYER_HASH = sceneContentHash(LEGACY_SCENE);

const LEGACY_V1_DDL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  root TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE spaces (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_layer_id TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE layers (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  redo_of TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_name TEXT,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL
);
CREATE TABLE layer_scenes (
  layer_id TEXT PRIMARY KEY NOT NULL,
  scene_json TEXT NOT NULL
);
CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  display_no TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  title_source TEXT,
  blob_hash TEXT,
  source_url TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  base_layer_id TEXT,
  result_layer_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  redo_of TEXT,
  scene_json TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  committed_layer_id TEXT
);
CREATE UNIQUE INDEX layers_space_seq_uq ON layers(space_id, seq);
CREATE INDEX layers_space_id_idx ON layers(space_id);
CREATE INDEX layers_parent_id_idx ON layers(parent_id);
CREATE INDEX layers_content_hash_idx ON layers(content_hash);
CREATE UNIQUE INDEX assets_space_display_no_uq ON assets(space_id, display_no);
CREATE INDEX assets_space_id_idx ON assets(space_id);
CREATE UNIQUE INDEX agent_sessions_project_space_uq ON agent_sessions(project_id, space_id);
CREATE INDEX agent_messages_session_id_idx ON agent_messages(session_id, created_at);
CREATE UNIQUE INDEX drafts_session_id_uq ON drafts(session_id);
CREATE INDEX drafts_space_id_idx ON drafts(space_id);
CREATE INDEX drafts_project_id_idx ON drafts(project_id);
CREATE INDEX drafts_status_idx ON drafts(status);
CREATE INDEX spaces_project_id_idx ON spaces(project_id);
`;

function createLegacyDatabase(
  database: Database,
  schemaVersion: LegacySchemaVersion,
  stampedVersion: number = schemaVersion,
): Database {
  database.exec(LEGACY_V1_DDL);
  database
    .query(
      "INSERT INTO projects (id, name, root, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("project-legacy", "legacy project", null, OWNER_ID, LEGACY_NOW);
  database
    .query(
      "INSERT INTO spaces (id, project_id, name, active_layer_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "space-legacy",
      "project-legacy",
      "legacy space",
      null,
      OWNER_ID,
      LEGACY_NOW,
    );
  database
    .query(
      `INSERT INTO layers (
        id, space_id, seq, parent_id, kind, redo_of, title, title_source,
        created_at, author_kind, author_name, schema_version, content_hash, owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "layer-legacy",
      "space-legacy",
      1,
      null,
      "root",
      null,
      "Legacy layer",
      "human",
      LEGACY_NOW,
      "cli",
      "legacy-agent",
      1,
      LEGACY_LAYER_HASH,
      OWNER_ID,
    );
  database
    .query("INSERT INTO layer_scenes (layer_id, scene_json) VALUES (?, ?)")
    .run("layer-legacy", LEGACY_SCENE_JSON);
  database
    .query(
      `INSERT INTO assets (
        asset_id, space_id, display_no, type, title, title_source, blob_hash,
        source_url, owner_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "asset-legacy",
      "space-legacy",
      "001",
      "image",
      "Legacy asset",
      "pending",
      `sha256:${"a".repeat(64)}`,
      null,
      OWNER_ID,
      LEGACY_NOW,
    );
  database
    .query(
      `INSERT INTO agent_sessions (
        id, project_id, space_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "session-legacy",
      "project-legacy",
      "space-legacy",
      LEGACY_NOW,
      LEGACY_NOW,
    );
  const insertMessage = database.query(
    `INSERT INTO agent_messages (
      id, session_id, role, content, base_layer_id, result_layer_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMessage.run(
    "zzzz-message",
    "session-legacy",
    "user",
    "legacy question",
    null,
    null,
    LEGACY_NOW,
  );
  insertMessage.run(
    "aaaa-message",
    "session-legacy",
    "assistant",
    "legacy answer",
    null,
    null,
    LEGACY_NOW,
  );
  database
    .query(
      `INSERT INTO drafts (
        id, session_id, project_id, space_id, parent_id, kind, redo_of,
        scene_json, author_kind, author_name, created_at, updated_at,
        expires_at, status, committed_layer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "draft-legacy",
      "draft-session",
      "project-legacy",
      "space-legacy",
      null,
      "root",
      null,
      LEGACY_SCENE_JSON,
      "cli",
      "legacy-agent",
      LEGACY_NOW,
      LEGACY_NOW,
      "2026-10-22T00:30:00.000Z",
      "open",
      null,
    );

  if (schemaVersion >= 2) {
    database.exec("ALTER TABLE layers ADD COLUMN seq_origin INTEGER;");
    database
      .query("UPDATE layers SET seq_origin = ? WHERE id = ?")
      .run(7, "layer-legacy");
  }
  if (schemaVersion >= 3) {
    database.exec(
      "ALTER TABLE agent_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;",
    );
    database
      .query("UPDATE agent_messages SET seq = ? WHERE id = ?")
      .run(10, "zzzz-message");
    database
      .query("UPDATE agent_messages SET seq = ? WHERE id = ?")
      .run(11, "aaaa-message");
    database.exec(
      "CREATE UNIQUE INDEX agent_messages_session_seq_uq ON agent_messages(session_id, seq);",
    );
  }

  database.exec(`PRAGMA user_version = ${stampedVersion};`);
  return database;
}

function tableColumns(database: Database, table: string): string[] {
  return (
    database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function tableNames(database: Database): string[] {
  return (
    database
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((table) => table.name);
}

function indexNames(database: Database): string[] {
  return (
    database
      .query("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((index) => index.name);
}

function schemaVersion(database: Database): number {
  return (
    database.query("PRAGMA user_version").get() as {
      user_version: number;
    }
  ).user_version;
}

async function expectError(
  action: () => Promise<unknown>,
  code: HumanBoardError["code"],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(HumanBoardError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HumanBoardError ${code}`);
}

describe("SqliteStorageAdapter CRUD", () => {
  test("migrates legacy Agent messages to stable per-session sequence order", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        root TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        active_layer_id TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        space_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        base_layer_id TEXT,
        result_layer_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const now = "2026-10-22T00:00:00.000Z";
    database
      .query(
        "INSERT INTO projects (id, name, root, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("project-1", "project", null, OWNER_ID, now);
    database
      .query(
        "INSERT INTO spaces (id, project_id, name, active_layer_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("space-1", "project-1", "main", null, OWNER_ID, now);
    database
      .query(
        "INSERT INTO agent_sessions (id, project_id, space_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("session-1", "project-1", "space-1", now, now);
    const insert = database.query(
      "INSERT INTO agent_messages (id, session_id, role, content, base_layer_id, result_layer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("zzzz", "session-1", "user", "question", null, null, now);
    insert.run("aaaa", "session-1", "assistant", "answer", null, null, now);

    const adapter = new SqliteStorageAdapter({ database });
    const messages = await adapter.listAgentMessages("session-1");
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    adapter.close();
    database.close();
  });

  test("round-trips project, space, layer, scene, asset, and draft records", async () => {
    const fixture = await createFixture();
    try {
      const scene = sceneWithNode("n1", "decomposed e\u0301");
      const layer = newLayer(fixture, scene);
      const appended = await fixture.adapter.appendLayer({ layer, scene });

      expect(await fixture.adapter.getProject(fixture.project.id)).toEqual(
        fixture.project,
      );
      expect(await fixture.adapter.listSpaces(fixture.project.id)).toEqual([
        fixture.space,
      ]);
      expect(appended).toMatchObject({ seq: 1, parent_id: null, kind: "root" });
      expect(await fixture.adapter.getLayer(appended.id)).toEqual(appended);
      expect(await fixture.adapter.getLayerScene(appended.id)).toEqual(
        sceneWithNode("n1", "decomposed \u00E9"),
      );

      const active = await fixture.adapter.setSpaceActiveLayer(
        fixture.space.id,
        appended.id,
      );
      expect(active.active_layer_id).toBe(appended.id);

      const asset = newAsset(fixture);
      expect(await fixture.adapter.createAsset(asset)).toEqual(asset);
      expect(await fixture.adapter.getAsset(asset.asset_id)).toEqual(asset);
      expect(
        await fixture.adapter.getAssetByDisplayNo(fixture.space.id, "001"),
      ).toEqual(asset);
      expect(await fixture.adapter.listAssets(fixture.space.id)).toEqual([
        asset,
      ]);
      expect(await fixture.adapter.nextAssetDisplayNo(fixture.space.id)).toBe(
        "002",
      );
      const updatedAsset = await fixture.adapter.updateAsset(asset.asset_id, {
        title: "updated",
        blob_hash: null,
      });
      expect(updatedAsset).toMatchObject({
        asset_id: asset.asset_id,
        title: "updated",
        blob_hash: null,
      });
      expect(await fixture.adapter.getAsset(asset.asset_id)).toEqual(
        updatedAsset,
      );

      const draft = newDraft(fixture, scene);
      const normalizedDraft: Draft = {
        ...draft,
        scene: sceneWithNode("n1", "decomposed \u00E9"),
      };
      expect(await fixture.adapter.saveDraft(draft)).toEqual(normalizedDraft);
      expect(await fixture.adapter.getDraftBySession("session-1")).toEqual(
        normalizedDraft,
      );
      expect(await fixture.adapter.getDraftById(draft.id)).toEqual(
        normalizedDraft,
      );

      await fixture.adapter.deleteDraft(draft.id);
      expect(await fixture.adapter.getDraftBySession("session-1")).toBeNull();
      expect(Object.isFrozen(appended)).toBe(true);
    } finally {
      fixture.adapter.close();
    }
  });

  test("assigns per-Space seq values and enforces the unique index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-sqlite-"));
    const databasePath = join(directory, "humanboard.sqlite");
    const sqlite = new Database(databasePath);
    const adapter = new SqliteStorageAdapter({ database: sqlite });

    try {
      const fixture = await createFixture(adapter);
      const rootScene = sceneWithNode("n1");
      const rootLayer = newLayer(fixture, rootScene);
      await adapter.appendLayer({ layer: rootLayer, scene: rootScene });

      const deriveScene = sceneWithNode("n2");
      const deriveLayer = newLayer(fixture, deriveScene, {
        parentId: rootLayer.id,
      });
      const derive = await adapter.appendLayer({
        layer: deriveLayer,
        scene: deriveScene,
      });

      expect((await adapter.getLayer(rootLayer.id))?.seq).toBe(1);
      expect(derive.seq).toBe(2);

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO layers (
              id, space_id, seq, seq_origin, parent_id, kind, redo_of, title,
              title_source, created_at, author_kind, author_name,
              schema_version, content_hash, owner_id
            ) VALUES (?, ?, ?, NULL, NULL, 'root', NULL, '', 'pending', ?, 'cli', NULL, 1, ?, 'local')`,
          )
          .run(
            "01ARZ3NDEK9999999999999999",
            fixture.space.id,
            1,
            fixture.clock.now().toISOString(),
            sceneContentHash(rootScene),
          ),
      ).toThrow();
    } finally {
      adapter.close();
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("SqliteStorageAdapter migrations", () => {
  const cases = [
    {
      schemaVersion: 1 as const,
      expectedSeqOrigin: null,
      expectedMessageSeq: [1, 2],
    },
    {
      schemaVersion: 2 as const,
      expectedSeqOrigin: 7,
      expectedMessageSeq: [1, 2],
    },
    {
      schemaVersion: 3 as const,
      expectedSeqOrigin: 7,
      expectedMessageSeq: [10, 11],
    },
  ];

  for (const fixture of cases) {
    test(`upgrades a real v${fixture.schemaVersion} database to v4`, async () => {
      const database = createLegacyDatabase(
        new Database(":memory:"),
        fixture.schemaVersion,
      );
      const adapter = new SqliteStorageAdapter({ database });

      try {
        expect(schemaVersion(database)).toBe(8);
        expect(tableColumns(database, "layers")).toContain("seq_origin");
        expect(tableColumns(database, "agent_messages")).toContain("seq");
        expect(tableNames(database)).toContain("meta_fields");
        expect(tableNames(database)).toContain("sync_state");
        expect(indexNames(database)).toContain("agent_messages_session_seq_uq");

        const layer = await adapter.getLayer("layer-legacy");
        expect(layer).toMatchObject({
          id: "layer-legacy",
          seq: 1,
          seq_origin: fixture.expectedSeqOrigin,
          title: "Legacy layer",
        });
        expect(await adapter.getLayerScene("layer-legacy")).toEqual(
          LEGACY_SCENE,
        );
        expect((await adapter.getAsset("asset-legacy"))?.title).toBe(
          "Legacy asset",
        );
        expect((await adapter.getDraftBySession("draft-session"))?.id).toBe(
          "draft-legacy",
        );

        const messages = await adapter.listAgentMessages("session-legacy");
        expect(messages.map((message) => message.seq)).toEqual(
          fixture.expectedMessageSeq,
        );
        expect(messages.map((message) => message.content)).toEqual([
          "legacy question",
          "legacy answer",
        ]);

        expect(
          await adapter.getMetaField("space-legacy", "space.name"),
        ).toMatchObject({
          field: "space.name",
          value: "legacy space",
        });
        expect(
          await adapter.getMetaField(
            "space-legacy",
            "layer.layer-legacy.title",
          ),
        ).toMatchObject({
          value: "Legacy layer",
        });
      } finally {
        adapter.close();
        database.close();
      }
    });
  }

  test("repairs a schema falsely stamped as v4 without inventing seq_origin", async () => {
    const database = createLegacyDatabase(new Database(":memory:"), 1, 4);
    const adapter = new SqliteStorageAdapter({ database });

    try {
      expect(schemaVersion(database)).toBe(8);
      expect(tableColumns(database, "layers")).toContain("seq_origin");
      expect(tableColumns(database, "agent_messages")).toContain("seq");
      expect(tableNames(database)).toContain("meta_fields");
      expect(tableNames(database)).toContain("sync_state");

      const layer = await adapter.getLayer("layer-legacy");
      expect(layer?.seq_origin).toBeNull();
      const messages = await adapter.listAgentMessages("session-legacy");
      expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    } finally {
      adapter.close();
      database.close();
    }
  });

  test("is idempotent when an upgraded database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-migration-"));
    const databasePath = join(directory, "legacy.sqlite");
    const legacy = createLegacyDatabase(new Database(databasePath), 1);
    legacy.close();

    const first = new SqliteStorageAdapter({ databasePath });
    let deviceId: string | undefined;
    try {
      deviceId = (await first.getMetaField("space-legacy", "space.name"))
        ?.device_id;
      expect(deviceId).toBeString();
    } finally {
      first.close();
    }

    const second = new SqliteStorageAdapter({ databasePath });
    try {
      expect(await second.getLayer("layer-legacy")).toMatchObject({
        seq: 1,
        seq_origin: null,
      });
      expect(
        await second.getMetaField("space-legacy", "space.name"),
      ).toMatchObject({
        value: "legacy space",
        device_id: deviceId!,
      });
      expect(
        (await second.listAgentMessages("session-legacy")).map(
          (message) => message.seq,
        ),
      ).toEqual([1, 2]);
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rolls back every migration change when backfill fails", () => {
    const database = createLegacyDatabase(new Database(":memory:"), 1);
    database.exec("ALTER TABLE layers DROP COLUMN title;");

    try {
      expect(() => new SqliteStorageAdapter({ database })).toThrow();
      expect(schemaVersion(database)).toBe(1);
      expect(tableColumns(database, "layers")).not.toContain("seq_origin");
      expect(tableColumns(database, "agent_messages")).not.toContain("seq");
      expect(tableNames(database)).not.toContain("meta_fields");
      expect(tableNames(database)).not.toContain("sync_state");
    } finally {
      database.close();
    }
  });
});

describe("SqliteStorageAdapter draft persistence", () => {
  test("overwrites a session draft and keeps one row per session", async () => {
    const fixture = await createFixture();
    try {
      const first = newDraft(fixture, sceneWithNode("first"));
      await fixture.adapter.saveDraft(first);

      const second = newDraft(fixture, sceneWithNode("second"), {
        id: fixture.ids.next(),
        sessionId: first.session_id,
      });
      await fixture.adapter.saveDraft(second);

      expect(await fixture.adapter.getDraftById(first.id)).toBeNull();
      expect(await fixture.adapter.getDraftBySession(first.session_id)).toEqual(
        second,
      );
    } finally {
      fixture.adapter.close();
    }
  });

  test("commits Layer + Scene + draft consumption atomically", async () => {
    const fixture = await createFixture();
    try {
      const scene = sceneWithNode("n1");
      const draft = newDraft(fixture, scene);
      await fixture.adapter.saveDraft(draft);
      const layer = newLayer(fixture, scene);

      const committed = await fixture.adapter.commitDraft({
        draft_id: draft.id,
        layer,
        scene,
      });

      expect(committed).toMatchObject({ id: layer.id, seq: 1 });
      expect(await fixture.adapter.getLayerScene(layer.id)).toEqual(scene);
      expect(await fixture.adapter.getDraftById(draft.id)).toMatchObject({
        status: "consumed",
        committed_layer_id: layer.id,
      });
    } finally {
      fixture.adapter.close();
    }
  });

  test("rolls back Layer, Scene, and draft state when commit injection fails", async () => {
    class FailingAdapter extends SqliteStorageAdapter {
      protected override afterCommitDraftLayerInsert(): void {
        throw new Error("injected failure");
      }
    }

    const adapter = new FailingAdapter();
    const fixture = await createFixture(adapter);
    try {
      const scene = sceneWithNode("n1");
      const draft = newDraft(fixture, scene);
      await adapter.saveDraft(draft);
      const layer = newLayer(fixture, scene);

      await expectError(
        () =>
          adapter.commitDraft({
            draft_id: draft.id,
            layer,
            scene,
          }),
        "E_INTERNAL",
      );

      expect(await adapter.getLayer(layer.id)).toBeNull();
      expect(await adapter.listLayers(fixture.space.id)).toEqual([]);
      expect(await adapter.getDraftById(draft.id)).toMatchObject({
        status: "open",
        committed_layer_id: null,
      });
    } finally {
      adapter.close();
    }
  });

  test("rejects a Layer whose content_hash does not match its Scene", async () => {
    const fixture = await createFixture();
    try {
      const scene = sceneWithNode("n1");
      const layer = {
        ...newLayer(fixture, scene),
        content_hash: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      };

      await expectError(
        () => fixture.adapter.appendLayer({ layer, scene }),
        "E_HASH_MISMATCH",
      );
      expect(await fixture.adapter.listLayers(fixture.space.id)).toEqual([]);
    } finally {
      fixture.adapter.close();
    }
  });
});

describe("SqliteStorageAdapter persistence", () => {
  test("restores pure conversations and tool traces after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-agent-sqlite-"));
    const databasePath = join(directory, "humanboard.sqlite");
    const first = new SqliteStorageAdapter({ databasePath });
    const fixture = await createFixture(first);
    const sessionId = fixture.ids.next();
    const now = fixture.clock.now().toISOString();
    const trace = [
      {
        id: "call-inspect",
        tool: "humanboard_inspect",
        step: 2,
        status: "completed" as const,
        summary: "读取 #001",
        started_at: now,
        finished_at: now,
      },
    ];
    try {
      await first.createAgentSession({
        id: sessionId,
        project_id: fixture.project.id,
        space_id: fixture.space.id,
        created_at: now,
        updated_at: now,
      });
      await first.appendAgentMessage({
        id: fixture.ids.next(),
        session_id: sessionId,
        role: "user",
        content: "只解释图片",
        base_layer_id: null,
        result_layer_id: null,
        created_at: now,
      });
      await first.appendAgentMessage({
        id: fixture.ids.next(),
        session_id: sessionId,
        role: "assistant",
        content: "图片说明",
        reasoning_steps: [{ step: 1, content: "先读取图片，再解释。" }],
        tool_trace: trace,
        base_layer_id: null,
        result_layer_id: null,
        created_at: now,
      });
    } finally {
      first.close();
    }
    const second = new SqliteStorageAdapter({ databasePath });
    try {
      const messages = await second.listAgentMessages(sessionId);
      expect(messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(messages[0]!.tool_trace).toBeUndefined();
      expect(messages[1]!.tool_trace).toEqual(trace);
      expect(messages[1]!.reasoning_steps).toEqual([
        { step: 1, content: "先读取图片，再解释。" },
      ]);
      expect(messages[1]!.result_layer_id).toBeNull();
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reopens a file database and restores canonical records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-sqlite-"));
    const databasePath = join(directory, "humanboard.sqlite");
    const first = new SqliteStorageAdapter({ databasePath });
    let fixture: SqliteFixture;

    try {
      fixture = await createFixture(first);
      const scene = sceneWithNode("n1", "e\u0301");
      const layer = newLayer(fixture, scene);
      await first.appendLayer({ layer, scene });
      const asset = { ...newAsset(fixture), description: "可恢复的网页摘要" };
      await first.createAsset(asset);
      const draft = newDraft(fixture, scene);
      await first.saveDraft(draft);
    } finally {
      first.close();
    }

    const second = new SqliteStorageAdapter({ databasePath });
    try {
      expect(await second.getProject(fixture!.project.id)).toEqual(
        fixture!.project,
      );
      const layers = await second.listLayers(fixture!.space.id);
      expect(layers).toHaveLength(1);
      const scene = await second.getLayerScene(layers[0]!.id);
      expect(scene?.nodes[0]?.title).toBe("\u00E9");
      expect(await second.listAssets(fixture!.space.id)).toHaveLength(1);
      expect((await second.listAssets(fixture!.space.id))[0]!.description).toBe(
        "可恢复的网页摘要",
      );
      expect(await second.getDraftBySession("session-1")).not.toBeNull();
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
