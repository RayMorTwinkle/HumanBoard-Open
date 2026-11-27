import { Database } from "bun:sqlite";

import {
  canonicalJson,
  SceneSchema,
  sceneContentHash,
  type Scene,
} from "@humanboard/schema";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ulid } from "ulid";

import { HumanBoardError } from "../../domain/errors";
import type {
  AgentMessage,
  AgentSession,
  Asset,
  AssetUpdate,
  Author,
  Draft,
  Layer,
  LayerKind,
  MetaField,
  MetaFieldInput,
  MetaMergeResult,
  NewAgentMessage,
  NewLayerRecord,
  Project,
  Space,
  TitleSource,
  ULID,
} from "../../domain/types";
import { AUTHOR_KINDS, LAYER_KINDS, TITLE_SOURCES } from "../../domain/types";
import type {
  AppendLayerInput,
  CommitDraftStorageInput,
} from "../storage-adapter";
import type {
  RevisionPublication,
  RevisionStorage,
} from "../../revisions/storage";
import { frozenClone } from "../value";
import * as schema from "./schema";
import { SQLITE_DDL, SQLITE_SCHEMA_VERSION, SQLITE_V1_DDL } from "./schema";

type ProjectRow = typeof schema.projects.$inferSelect;
type SpaceRow = typeof schema.spaces.$inferSelect;
type LayerRow = typeof schema.layers.$inferSelect;
type AssetRow = typeof schema.assets.$inferSelect;
type MetaFieldRow = typeof schema.metaFields.$inferSelect;
type AgentSessionRow = typeof schema.agentSessions.$inferSelect;
type AgentMessageRow = typeof schema.agentMessages.$inferSelect;
type DraftRow = typeof schema.drafts.$inferSelect;
type SqliteTransaction = Parameters<
  Parameters<BunSQLiteDatabase<typeof schema>["transaction"]>[0]
>[0];

export interface SqliteStorageAdapterOptions {
  readonly databasePath?: string;
  readonly database?: Database;
}

function corrupt(
  table: string,
  field: string,
  value: unknown,
): HumanBoardError {
  return new HumanBoardError(
    "E_INTERNAL",
    `Corrupt SQLite row in ${table}.${field}`,
    { table, field, value },
  );
}

function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  table: string,
  field: string,
): T {
  if (!allowed.includes(value as T)) {
    throw corrupt(table, field, value);
  }
  return value as T;
}

function parseTimestamp(value: string, table: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw corrupt(table, field, value);
  }
  return value;
}

function parseContentHash(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw corrupt("layers", "content_hash", value);
  }
  return value as `sha256:${string}`;
}

function parseNullableBlobHash(
  value: string | null,
): `sha256:${string}` | null {
  if (value === null) {
    return null;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw corrupt("assets", "blob_hash", value);
  }
  return value as `sha256:${string}`;
}

function parseSceneJson(value: string, table: string, field: string): Scene {
  try {
    return SceneSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new HumanBoardError(
      "E_INTERNAL",
      `Invalid Scene JSON in ${table}.${field}`,
      {
        table,
        field,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function serializeScene(scene: Scene): string {
  try {
    return canonicalJson(SceneSchema.parse(scene));
  } catch (error) {
    throw new HumanBoardError("E_INTERNAL", "Cannot serialize Scene", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function authorFromRow(
  kind: string,
  name: string | null,
  table: string,
): Author {
  const author: Author = {
    kind: assertEnum(kind, AUTHOR_KINDS, table, "author_kind"),
    ...(name === null ? {} : { name }),
  };
  return author;
}

function projectFromRow(row: ProjectRow): Project {
  return frozenClone({
    id: row.id,
    name: row.name,
    root: row.root,
    owner_id: row.ownerId,
    created_at: parseTimestamp(row.createdAt, "projects", "created_at"),
  });
}

function spaceFromRow(row: SpaceRow): Space {
  return frozenClone({
    id: row.id,
    project_id: row.projectId,
    name: row.name,
    active_layer_id: row.activeLayerId,
    owner_id: row.ownerId,
    created_at: parseTimestamp(row.createdAt, "spaces", "created_at"),
  });
}

function layerFromRow(row: LayerRow): Layer {
  if (!Number.isInteger(row.seq) || row.seq < 1) {
    throw corrupt("layers", "seq", row.seq);
  }
  if (!Number.isInteger(row.schemaVersion) || row.schemaVersion < 1) {
    throw corrupt("layers", "schema_version", row.schemaVersion);
  }

  return frozenClone({
    id: row.id,
    space_id: row.spaceId,
    seq: row.seq,
    seq_origin: row.seqOrigin,
    parent_id: row.parentId,
    kind: assertEnum(row.kind, LAYER_KINDS, "layers", "kind"),
    redo_of: row.redoOf,
    title: row.title,
    title_source: assertEnum(
      row.titleSource,
      TITLE_SOURCES,
      "layers",
      "title_source",
    ),
    created_at: parseTimestamp(row.createdAt, "layers", "created_at"),
    author: authorFromRow(row.authorKind, row.authorName, "layers"),
    schema_version: row.schemaVersion,
    content_hash: parseContentHash(row.contentHash),
    owner_id: row.ownerId,
  });
}

function assetFromRow(row: AssetRow): Asset {
  if (!/^\d{3,}$/.test(row.displayNo)) {
    throw corrupt("assets", "display_no", row.displayNo);
  }

  return frozenClone({
    asset_id: row.assetId,
    space_id: row.spaceId,
    display_no: row.displayNo,
    type: assertEnum(row.type, ["image", "url"] as const, "assets", "type"),
    title: row.title,
    title_source:
      row.titleSource === null
        ? null
        : assertEnum(row.titleSource, TITLE_SOURCES, "assets", "title_source"),
    blob_hash: parseNullableBlobHash(row.blobHash),
    source_url: row.sourceUrl,
    ...(row.description === null ? {} : { description: row.description }),
    owner_id: row.ownerId,
    created_at: parseTimestamp(row.createdAt, "assets", "created_at"),
  });
}

function metaFieldFromRow(row: MetaFieldRow): MetaField {
  if (
    row.field.length === 0 ||
    !Number.isSafeInteger(row.lamport) ||
    row.lamport < 1 ||
    row.deviceId.length === 0
  ) {
    throw corrupt("meta_fields", "register", row);
  }
  return frozenClone({
    space_id: row.spaceId,
    field: row.field,
    value: row.value,
    lamport: row.lamport,
    device_id: row.deviceId,
  });
}

function metaFieldInput(field: MetaField): MetaFieldInput {
  return {
    field: field.field,
    value: field.value,
    lamport: field.lamport,
    device_id: field.device_id,
  };
}

function compareMeta(
  left: Pick<MetaFieldInput, "lamport" | "device_id">,
  right: Pick<MetaFieldInput, "lamport" | "device_id">,
): number {
  if (left.lamport !== right.lamport) {
    return left.lamport - right.lamport;
  }
  if (left.device_id === right.device_id) {
    return 0;
  }
  return left.device_id < right.device_id ? -1 : 1;
}

function agentSessionFromRow(row: AgentSessionRow): AgentSession {
  return frozenClone({
    id: row.id,
    project_id: row.projectId,
    space_id: row.spaceId,
    created_at: parseTimestamp(row.createdAt, "agent_sessions", "created_at"),
    updated_at: parseTimestamp(row.updatedAt, "agent_sessions", "updated_at"),
  });
}

function agentMessageFromRow(row: AgentMessageRow): AgentMessage {
  if (!Number.isInteger(row.seq) || row.seq < 1) {
    throw corrupt("agent_messages", "seq", row.seq);
  }
  return frozenClone({
    id: row.id,
    session_id: row.sessionId,
    seq: row.seq,
    role: assertEnum(
      row.role,
      ["user", "assistant"] as const,
      "agent_messages",
      "role",
    ),
    content: row.content,
    ...(row.toolTraceJson ? { tool_trace: JSON.parse(row.toolTraceJson) } : {}),
    ...(row.reasoningJson
      ? { reasoning_steps: JSON.parse(row.reasoningJson) }
      : {}),
    base_layer_id: row.baseLayerId,
    result_layer_id: row.resultLayerId,
    created_at: parseTimestamp(row.createdAt, "agent_messages", "created_at"),
  });
}

function draftFromRow(row: DraftRow): Draft {
  return frozenClone({
    id: row.id,
    session_id: row.sessionId,
    project_id: row.projectId,
    space_id: row.spaceId,
    parent_id: row.parentId,
    kind: assertEnum(row.kind, LAYER_KINDS, "drafts", "kind"),
    redo_of: row.redoOf,
    scene: parseSceneJson(row.sceneJson, "drafts", "scene_json"),
    author: authorFromRow(row.authorKind, row.authorName, "drafts"),
    created_at: parseTimestamp(row.createdAt, "drafts", "created_at"),
    updated_at: parseTimestamp(row.updatedAt, "drafts", "updated_at"),
    expires_at: parseTimestamp(row.expiresAt, "drafts", "expires_at"),
    status: assertEnum(
      row.status,
      ["open", "consumed"] as const,
      "drafts",
      "status",
    ),
    committed_layer_id: row.committedLayerId,
  });
}

function layerInsertValues(
  layer: NewLayerRecord,
  seq: number,
): typeof schema.layers.$inferInsert {
  return {
    id: layer.id,
    spaceId: layer.space_id,
    seq,
    seqOrigin: layer.seq_origin ?? null,
    parentId: layer.parent_id,
    kind: layer.kind,
    redoOf: layer.redo_of,
    title: layer.title,
    titleSource: layer.title_source,
    createdAt: layer.created_at,
    authorKind: layer.author.kind,
    authorName: layer.author.name ?? null,
    schemaVersion: layer.schema_version,
    contentHash: layer.content_hash,
    ownerId: layer.owner_id,
  };
}

function draftInsertValues(draft: Draft): typeof schema.drafts.$inferInsert {
  return {
    id: draft.id,
    sessionId: draft.session_id,
    projectId: draft.project_id,
    spaceId: draft.space_id,
    parentId: draft.parent_id,
    kind: draft.kind,
    redoOf: draft.redo_of,
    sceneJson: serializeScene(draft.scene),
    authorKind: draft.author.kind,
    authorName: draft.author.name ?? null,
    createdAt: draft.created_at,
    updatedAt: draft.updated_at,
    expiresAt: draft.expires_at,
    status: draft.status,
    committedLayerId: draft.committed_layer_id,
  };
}

function assertLayerHash(layer: NewLayerRecord, scene: Scene): void {
  const actual = sceneContentHash(scene);
  if (actual !== layer.content_hash) {
    throw new HumanBoardError(
      "E_HASH_MISMATCH",
      `Layer ${layer.id} content_hash does not match its Scene`,
      { expected: layer.content_hash, actual },
    );
  }
}

export class SqliteStorageAdapter implements RevisionStorage {
  private readonly sqlite: Database;
  private readonly db: BunSQLiteDatabase<typeof schema>;
  private readonly ownsDatabase: boolean;
  private readonly deviceId: string;
  private closed = false;

  constructor(options: SqliteStorageAdapterOptions = {}) {
    this.sqlite =
      options.database ?? new Database(options.databasePath ?? ":memory:");
    this.ownsDatabase = options.database === undefined;
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec("PRAGMA busy_timeout = 5000;");
    this.deviceId = this.migrate();
    this.db = drizzle(this.sqlite, { schema });
  }

  private migrate(): string {
    this.sqlite.exec("BEGIN IMMEDIATE;");
    try {
      const fromVersion = this.readSchemaVersion();
      if (fromVersion > SQLITE_SCHEMA_VERSION) {
        throw new HumanBoardError(
          "E_INTERNAL",
          `SQLite schema version ${fromVersion} is newer than supported version ${SQLITE_SCHEMA_VERSION}`,
          {
            fromVersion,
            supportedVersion: SQLITE_SCHEMA_VERSION,
          },
        );
      }

      for (
        let version = fromVersion + 1;
        version <= SQLITE_SCHEMA_VERSION;
        version += 1
      ) {
        this.applyMigration(version);
      }

      // The previous constructor could stamp an incomplete database as v4.
      // Every migration is idempotent, so reconcile the full shape before
      // writing the final version.
      this.reconcileCurrentSchema();

      const deviceId = this.ensureDeviceIdentity();
      this.backfillMetaFields(deviceId);
      this.sqlite.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`);
      this.sqlite.exec("COMMIT;");
      return deviceId;
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK;");
      } catch {
        // Preserve the migration error if SQLite already rolled back.
      }
      throw error;
    }
  }

  private readSchemaVersion(): number {
    const row = this.sqlite.query("PRAGMA user_version").get() as {
      user_version: number;
    } | null;
    return row?.user_version ?? 0;
  }

  private applyMigration(version: number): void {
    switch (version) {
      case 1:
        this.sqlite.exec(SQLITE_V1_DDL);
        return;
      case 2:
        this.addColumnIfMissing("layers", "seq_origin", "INTEGER");
        return;
      case 3:
        this.migrateAgentMessageSequence();
        return;
      case 4:
        this.sqlite.exec(SQLITE_DDL);
        return;
      case 8:
        this.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS revision_refs (
            space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL,
            head TEXT NOT NULL REFERENCES layers(id), PRIMARY KEY(space_id,name)
          );
          CREATE TABLE IF NOT EXISTS merge_parents (
            layer_id TEXT PRIMARY KEY REFERENCES layers(id), source_id TEXT NOT NULL REFERENCES layers(id)
          );
        `);
        return;
      case 7:
        this.addColumnIfMissing("agent_messages", "reasoning_json", "TEXT");
        return;
      case 6:
        this.addColumnIfMissing("assets", "description", "TEXT");
        return;
      case 5:
        this.addColumnIfMissing("agent_messages", "tool_trace_json", "TEXT");
        return;
      default:
        throw new HumanBoardError(
          "E_INTERNAL",
          `Unknown SQLite schema migration version ${version}`,
          { version },
        );
    }
  }

  private reconcileCurrentSchema(): void {
    for (let version = 1; version <= SQLITE_SCHEMA_VERSION; version += 1) {
      this.applyMigration(version);
    }
  }

  private addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): void {
    if (!this.hasColumn(table, column)) {
      this.sqlite.exec(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`,
      );
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.sqlite
      .query(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return columns.some((candidate) => candidate.name === column);
  }

  private migrateAgentMessageSequence(): void {
    if (!this.hasColumn("agent_messages", "seq")) {
      this.sqlite.exec(
        "ALTER TABLE agent_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;",
      );
      const rows = this.sqlite
        .query(
          "SELECT id, session_id FROM agent_messages ORDER BY session_id, rowid",
        )
        .all() as Array<{ id: string; session_id: string }>;
      const nextBySession = new Map<string, number>();
      const update = this.sqlite.prepare(
        "UPDATE agent_messages SET seq = ? WHERE id = ?",
      );
      for (const row of rows) {
        const seq = (nextBySession.get(row.session_id) ?? 0) + 1;
        nextBySession.set(row.session_id, seq);
        update.run(seq, row.id);
      }
    }
    this.sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_session_seq_uq ON agent_messages(session_id, seq);",
    );
  }

  private ensureDeviceIdentity(): string {
    const row = this.sqlite
      .query("SELECT value FROM sync_state WHERE key = 'device_id'")
      .get() as { value: string } | null;
    if (row !== null && row.value.trim().length > 0) {
      return row.value;
    }
    const deviceId = ulid();
    this.sqlite
      .query(
        "INSERT INTO sync_state (key, value) VALUES ('device_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(deviceId);
    return deviceId;
  }

  private backfillMetaFields(deviceId: string): void {
    this.sqlite
      .query(
        `INSERT OR IGNORE INTO meta_fields (space_id, field, value, lamport, device_id)
         SELECT id, 'space.name', name, 1, ? FROM spaces WHERE length(name) > 0`,
      )
      .run(deviceId);
    this.sqlite
      .query(
        `INSERT OR IGNORE INTO meta_fields (space_id, field, value, lamport, device_id)
         SELECT space_id, 'layer.' || id || '.title', title, 1, ?
         FROM layers WHERE length(title) > 0`,
      )
      .run(deviceId);
    this.sqlite
      .query(
        `INSERT OR IGNORE INTO meta_fields (space_id, field, value, lamport, device_id)
         SELECT space_id, 'asset.' || asset_id || '.title', title, 1, ?
         FROM assets WHERE length(title) > 0`,
      )
      .run(deviceId);
  }

  close(): void {
    if (this.ownsDatabase && !this.closed) {
      this.sqlite.close();
      this.closed = true;
    }
  }

  async getProject(projectId: ULID): Promise<Project | null> {
    const row = this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    return row ? projectFromRow(row) : null;
  }

  async createProject(project: Project): Promise<Project> {
    if (await this.getProject(project.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Project ${project.id} already exists`,
      );
    }
    return this.write("Cannot create Project", () => {
      this.db
        .insert(schema.projects)
        .values({
          id: project.id,
          name: project.name,
          root: project.root,
          ownerId: project.owner_id,
          createdAt: project.created_at,
        })
        .run();
      return projectFromRow(
        this.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, project.id))
          .get()!,
      );
    });
  }

  async listProjects(): Promise<Project[]> {
    return this.db
      .select()
      .from(schema.projects)
      .orderBy(schema.projects.createdAt, schema.projects.id)
      .all()
      .map(projectFromRow);
  }

  async getSpace(spaceId: ULID): Promise<Space | null> {
    const row = this.db
      .select()
      .from(schema.spaces)
      .where(eq(schema.spaces.id, spaceId))
      .get();
    return row ? spaceFromRow(row) : null;
  }

  async listSpaces(projectId: ULID): Promise<Space[]> {
    return this.db
      .select()
      .from(schema.spaces)
      .where(eq(schema.spaces.projectId, projectId))
      .orderBy(schema.spaces.createdAt, schema.spaces.id)
      .all()
      .map(spaceFromRow);
  }

  async createSpace(space: Space): Promise<Space> {
    if (!(await this.getProject(space.project_id))) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${space.project_id} does not exist`,
      );
    }
    if (await this.getSpace(space.id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Space ${space.id} already exists`,
      );
    }

    return this.write("Cannot create Space", () =>
      this.db.transaction((tx) => {
        tx.insert(schema.spaces)
          .values({
            id: space.id,
            projectId: space.project_id,
            name: space.name,
            activeLayerId: space.active_layer_id,
            ownerId: space.owner_id,
            createdAt: space.created_at,
          })
          .run();
        this.writeMetaFieldInTransaction(
          tx,
          space.id,
          "space.name",
          space.name,
        );
        return spaceFromRow(
          tx
            .select()
            .from(schema.spaces)
            .where(eq(schema.spaces.id, space.id))
            .get()!,
        );
      }),
    );
  }

  async setSpaceActiveLayer(spaceId: ULID, layerId: ULID): Promise<Space> {
    if (!(await this.getSpace(spaceId))) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }
    const layer = await this.getLayer(layerId);
    if (!layer || layer.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_LAYER_NOT_FOUND",
        `Layer ${layerId} does not exist in Space ${spaceId}`,
      );
    }

    return this.write("Cannot update active Layer", () => {
      this.db
        .update(schema.spaces)
        .set({ activeLayerId: layerId })
        .where(eq(schema.spaces.id, spaceId))
        .run();
      return spaceFromRow(
        this.db
          .select()
          .from(schema.spaces)
          .where(eq(schema.spaces.id, spaceId))
          .get()!,
      );
    });
  }

  async getLayer(layerId: ULID): Promise<Layer | null> {
    const row = this.db
      .select()
      .from(schema.layers)
      .where(eq(schema.layers.id, layerId))
      .get();
    return row ? layerFromRow(row) : null;
  }

  async getLayerScene(layerId: ULID): Promise<Scene | null> {
    const row = this.db
      .select()
      .from(schema.layerScenes)
      .where(eq(schema.layerScenes.layerId, layerId))
      .get();
    return row
      ? frozenClone(parseSceneJson(row.sceneJson, "layer_scenes", "scene_json"))
      : null;
  }

  async listLayers(spaceId: ULID): Promise<Layer[]> {
    return this.db
      .select()
      .from(schema.layers)
      .where(eq(schema.layers.spaceId, spaceId))
      .orderBy(schema.layers.seq)
      .all()
      .map(layerFromRow);
  }

  async appendLayer(input: AppendLayerInput): Promise<Layer> {
    assertLayerHash(input.layer, input.scene);
    return this.write("Cannot append Layer", () =>
      this.db.transaction((tx) => this.appendLayerInTransaction(tx, input)),
    );
  }

  revisionRefs(spaceId: string) {
    return this.sqlite
      .query<
        { name: string; head: string },
        [string]
      >("SELECT name,head FROM revision_refs WHERE space_id=? ORDER BY name")
      .all(spaceId);
  }

  mergeParents(spaceId: string) {
    return this.sqlite
      .query<
        { layer_id: string; source_id: string },
        [string]
      >("SELECT layer_id,source_id FROM merge_parents JOIN layers ON layers.id=layer_id WHERE space_id=?")
      .all(spaceId);
  }

  /** Compare refs and publish the snapshot, both parents and ref in one writer transaction. */
  publishRevision(input: RevisionPublication) {
    if (input.append) assertLayerHash(input.append.layer, input.append.scene);
    return this.db.transaction(
      (tx) => {
        const { spaceId, branch, expected, from, append, mergeParent, source } =
          input;
        const conflict = (message: string) => {
          throw new HumanBoardError("E_REVISION_CONFLICT", message);
        };
        const ref = (name: string) =>
          this.sqlite
            .query<
              { head: string },
              [string, string]
            >("SELECT head FROM revision_refs WHERE space_id=? AND name=?")
            .get(spaceId, name)?.head ?? null;
        if (ref(branch) !== expected) conflict("分支已更新，请重新审阅。");
        if (source && ref(source.name) !== source.head)
          conflict("来源分支已更新，请重新审阅。");
        const visible = this.sqlite.query(`
        SELECT id FROM layers WHERE space_id=? AND id=? AND NOT EXISTS
        (SELECT 1 FROM meta_fields WHERE space_id=layers.space_id AND value='1'
         AND field IN ('space.deleted','layer.' || layers.id || '.deleted'))
      `);
        for (const id of new Set(
          [from, expected, mergeParent].filter((v): v is string => !!v),
        ))
          if (!visible.get(spaceId, id))
            throw new HumanBoardError(
              "E_LAYER_NOT_FOUND",
              "版本已移除或不属于此空间。",
            );
        if (
          append &&
          (append.layer.space_id !== spaceId || append.layer.parent_id !== from)
        )
          throw new HumanBoardError("E_USAGE", "快照与分支来源不匹配。");
        const head = append
          ? this.appendLayerInTransaction(tx, append).id
          : from;
        if (mergeParent && append)
          this.sqlite
            .query("INSERT INTO merge_parents VALUES (?,?)")
            .run(head, mergeParent);
        this.sqlite
          .query(
            "INSERT INTO revision_refs VALUES (?,?,?) ON CONFLICT(space_id,name) DO UPDATE SET head=excluded.head",
          )
          .run(spaceId, branch, head);
        return head;
      },
      { behavior: "immediate" },
    );
  }

  async appendLayerAtSeq(input: AppendLayerInput, seq: number): Promise<Layer> {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new HumanBoardError(
        "E_USAGE",
        `Layer sequence must be a positive integer: ${seq}`,
      );
    }
    assertLayerHash(input.layer, input.scene);
    return this.write("Cannot append Layer at sequence", () =>
      this.db.transaction((tx) =>
        this.appendLayerInTransaction(tx, input, seq),
      ),
    );
  }

  async getAsset(assetId: ULID): Promise<Asset | null> {
    const row = this.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.assetId, assetId))
      .get();
    return row ? assetFromRow(row) : null;
  }

  async getAssetByDisplayNo(
    spaceId: ULID,
    displayNo: string,
  ): Promise<Asset | null> {
    const row = this.db
      .select()
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.spaceId, spaceId),
          eq(schema.assets.displayNo, displayNo),
        ),
      )
      .get();
    return row ? assetFromRow(row) : null;
  }

  async listAssets(spaceId: ULID): Promise<Asset[]> {
    return this.db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.spaceId, spaceId))
      .orderBy(schema.assets.displayNo)
      .all()
      .map(assetFromRow);
  }

  async nextAssetDisplayNo(spaceId: ULID): Promise<string> {
    if (!(await this.getSpace(spaceId))) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }

    const row = this.db
      .select({
        maximum: sql<number>`coalesce(max(cast(${schema.assets.displayNo} as integer)), 0)`,
      })
      .from(schema.assets)
      .where(eq(schema.assets.spaceId, spaceId))
      .get();
    return String((row?.maximum ?? 0) + 1).padStart(3, "0");
  }

  async createAsset(asset: Asset): Promise<Asset> {
    if (!(await this.getSpace(asset.space_id))) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${asset.space_id} does not exist`,
      );
    }
    if (await this.getAsset(asset.asset_id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Asset ${asset.asset_id} already exists`,
      );
    }
    if (await this.getAssetByDisplayNo(asset.space_id, asset.display_no)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Asset display number ${asset.display_no} already exists`,
      );
    }

    return this.write("Cannot create Asset", () =>
      this.db.transaction((tx) => {
        tx.insert(schema.assets)
          .values({
            assetId: asset.asset_id,
            spaceId: asset.space_id,
            displayNo: asset.display_no,
            type: asset.type,
            title: asset.title,
            titleSource: asset.title_source,
            blobHash: asset.blob_hash,
            sourceUrl: asset.source_url,
            description: asset.description ?? null,
            ownerId: asset.owner_id,
            createdAt: asset.created_at,
          })
          .run();
        if (asset.description)
          this.writeMetaFieldInTransaction(
            tx,
            asset.space_id,
            `asset.${asset.asset_id}.description`,
            asset.description,
          );
        if (asset.title.length > 0) {
          this.writeMetaFieldInTransaction(
            tx,
            asset.space_id,
            `asset.${asset.asset_id}.title`,
            asset.title,
          );
        }
        return assetFromRow(
          tx
            .select()
            .from(schema.assets)
            .where(eq(schema.assets.assetId, asset.asset_id))
            .get()!,
        );
      }),
    );
  }

  async updateAsset(assetId: ULID, update: AssetUpdate): Promise<Asset> {
    const existing = await this.getAsset(assetId);
    if (!existing) {
      throw new HumanBoardError(
        "E_ASSET_NOT_FOUND",
        `Asset ${assetId} does not exist`,
      );
    }

    return this.write("Cannot update Asset", () =>
      this.db.transaction((tx) => {
        const values: Partial<typeof schema.assets.$inferInsert> = {};
        if (update.description !== undefined)
          values.description = update.description;
        if (update.title !== undefined) {
          values.title = update.title;
        }
        if (update.title_source !== undefined) {
          values.titleSource = update.title_source;
        }
        if (update.blob_hash !== undefined) {
          values.blobHash = update.blob_hash;
        }
        if (Object.keys(values).length > 0) {
          tx.update(schema.assets)
            .set(values)
            .where(eq(schema.assets.assetId, assetId))
            .run();
        }
        if (
          update.description !== undefined &&
          update.description !== existing.description
        )
          this.writeMetaFieldInTransaction(
            tx,
            existing.space_id,
            `asset.${assetId}.description`,
            update.description,
          );
        if (
          update.title !== undefined &&
          update.title !== existing.title &&
          update.title.length > 0
        ) {
          this.writeMetaFieldInTransaction(
            tx,
            existing.space_id,
            `asset.${assetId}.title`,
            update.title,
          );
        }
        return assetFromRow(
          tx
            .select()
            .from(schema.assets)
            .where(eq(schema.assets.assetId, assetId))
            .get()!,
        );
      }),
    );
  }

  async getMetaField(spaceId: ULID, field: string): Promise<MetaField | null> {
    const row = this.db
      .select()
      .from(schema.metaFields)
      .where(
        and(
          eq(schema.metaFields.spaceId, spaceId),
          eq(schema.metaFields.field, field),
        ),
      )
      .get();
    return row ? metaFieldFromRow(row) : null;
  }

  async listMetaFields(spaceId: ULID): Promise<MetaField[]> {
    return this.db
      .select()
      .from(schema.metaFields)
      .where(eq(schema.metaFields.spaceId, spaceId))
      .orderBy(schema.metaFields.field)
      .all()
      .map(metaFieldFromRow);
  }

  async writeMetaField(
    spaceId: ULID,
    field: string,
    value: string,
  ): Promise<MetaField> {
    if (!(await this.getSpace(spaceId))) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }
    return this.write("Cannot write meta register", () =>
      this.db.transaction((tx) =>
        this.writeMetaFieldInTransaction(tx, spaceId, field, value),
      ),
    );
  }

  async mergeMetaFields(
    spaceId: ULID,
    fields: readonly MetaFieldInput[],
  ): Promise<MetaMergeResult> {
    if (!(await this.getSpace(spaceId))) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${spaceId} does not exist`,
      );
    }
    return this.write("Cannot merge meta registers", () =>
      this.db.transaction((tx) => {
        const incomingByField = new Map<string, MetaFieldInput>();
        for (const incoming of fields) {
          this.assertMetaInput(incoming);
          const previous = incomingByField.get(incoming.field);
          if (previous === undefined || compareMeta(incoming, previous) > 0) {
            incomingByField.set(incoming.field, incoming);
          }
        }

        const merged: MetaField[] = [];
        const conflicts: MetaMergeResult["conflicts"][number][] = [];
        for (const incoming of [...incomingByField.values()].sort(
          (left, right) => left.field.localeCompare(right.field),
        )) {
          const current = tx
            .select()
            .from(schema.metaFields)
            .where(
              and(
                eq(schema.metaFields.spaceId, spaceId),
                eq(schema.metaFields.field, incoming.field),
              ),
            )
            .get();
          const currentMeta = current ? metaFieldFromRow(current) : null;
          const winner =
            currentMeta === null || compareMeta(incoming, currentMeta) > 0
              ? "incoming"
              : "current";
          if (currentMeta !== null && currentMeta.value !== incoming.value) {
            conflicts.push({
              field: incoming.field,
              incoming: { ...incoming },
              current: metaFieldInput(currentMeta),
              winner,
            });
          }
          if (winner === "current") {
            continue;
          }
          const stored = this.storeMetaFieldInTransaction(
            tx,
            spaceId,
            incoming,
          );
          merged.push(stored);
        }
        return { merged, conflicts };
      }),
    );
  }

  async getAgentSession(
    projectId: ULID,
    spaceId: ULID,
  ): Promise<AgentSession | null> {
    const row = this.db
      .select()
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.projectId, projectId),
          eq(schema.agentSessions.spaceId, spaceId),
        ),
      )
      .get();
    return row ? agentSessionFromRow(row) : null;
  }

  async createAgentSession(session: AgentSession): Promise<AgentSession> {
    if (!(await this.getProject(session.project_id))) {
      throw new HumanBoardError(
        "E_PROJECT_NOT_FOUND",
        `Project ${session.project_id} does not exist`,
      );
    }
    const space = await this.getSpace(session.space_id);
    if (!space || space.project_id !== session.project_id) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${session.space_id} does not exist in Project ${session.project_id}`,
      );
    }
    if (await this.getAgentSession(session.project_id, session.space_id)) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Agent session already exists for Project ${session.project_id} and Space ${session.space_id}`,
      );
    }

    return this.write("Cannot create Agent session", () => {
      this.db
        .insert(schema.agentSessions)
        .values({
          id: session.id,
          projectId: session.project_id,
          spaceId: session.space_id,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
        })
        .run();
      return agentSessionFromRow(
        this.db
          .select()
          .from(schema.agentSessions)
          .where(eq(schema.agentSessions.id, session.id))
          .get()!,
      );
    });
  }

  async listAgentMessages(sessionId: ULID): Promise<AgentMessage[]> {
    return this.db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, sessionId))
      .orderBy(
        schema.agentMessages.seq,
        schema.agentMessages.createdAt,
        schema.agentMessages.id,
      )
      .all()
      .map(agentMessageFromRow);
  }

  async appendAgentMessage(message: NewAgentMessage): Promise<AgentMessage> {
    const session = this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, message.session_id))
      .get();
    if (!session) {
      throw new HumanBoardError(
        "E_NOT_FOUND",
        `Agent session ${message.session_id} does not exist`,
      );
    }

    return this.write("Cannot append Agent message", () =>
      this.db.transaction((tx) => {
        const sequence = tx
          .select({
            maximum: sql<number>`coalesce(max(${schema.agentMessages.seq}), 0)`,
          })
          .from(schema.agentMessages)
          .where(eq(schema.agentMessages.sessionId, message.session_id))
          .get();
        tx.insert(schema.agentMessages)
          .values({
            id: message.id,
            sessionId: message.session_id,
            seq: (sequence?.maximum ?? 0) + 1,
            role: message.role,
            content: message.content,
            reasoningJson: message.reasoning_steps?.length
              ? JSON.stringify(message.reasoning_steps)
              : null,
            toolTraceJson: message.tool_trace
              ? JSON.stringify(message.tool_trace)
              : null,
            baseLayerId: message.base_layer_id,
            resultLayerId: message.result_layer_id,
            createdAt: message.created_at,
          })
          .run();
        tx.update(schema.agentSessions)
          .set({ updatedAt: message.created_at })
          .where(eq(schema.agentSessions.id, message.session_id))
          .run();
        return agentMessageFromRow(
          tx
            .select()
            .from(schema.agentMessages)
            .where(eq(schema.agentMessages.id, message.id))
            .get()!,
        );
      }),
    );
  }

  async updateLayerTitleIfPending(
    layerId: ULID,
    title: string,
    titleSource: Exclude<TitleSource, "pending">,
  ): Promise<Layer | null> {
    return this.write("Cannot update pending Layer title", () =>
      this.db.transaction((tx) => {
        tx.update(schema.layers)
          .set({ title, titleSource })
          .where(
            and(
              eq(schema.layers.id, layerId),
              eq(schema.layers.title, ""),
              eq(schema.layers.titleSource, "pending"),
            ),
          )
          .run();
        const row = tx
          .select()
          .from(schema.layers)
          .where(eq(schema.layers.id, layerId))
          .get();
        if (!row || row.title !== title || row.titleSource !== titleSource) {
          return null;
        }
        this.writeMetaFieldInTransaction(
          tx,
          row.spaceId,
          `layer.${row.id}.title`,
          title,
        );
        return layerFromRow(row);
      }),
    );
  }

  async updateAssetTitleIfPending(
    assetId: ULID,
    title: string,
    titleSource: Exclude<TitleSource, "pending">,
  ): Promise<Asset | null> {
    return this.write("Cannot update pending Asset title", () =>
      this.db.transaction((tx) => {
        tx.update(schema.assets)
          .set({ title, titleSource })
          .where(
            and(
              eq(schema.assets.assetId, assetId),
              eq(schema.assets.title, ""),
              eq(schema.assets.titleSource, "pending"),
            ),
          )
          .run();
        const row = tx
          .select()
          .from(schema.assets)
          .where(eq(schema.assets.assetId, assetId))
          .get();
        if (!row || row.title !== title || row.titleSource !== titleSource) {
          return null;
        }
        this.writeMetaFieldInTransaction(
          tx,
          row.spaceId,
          `asset.${row.assetId}.title`,
          title,
        );
        return assetFromRow(row);
      }),
    );
  }

  async getDraftBySession(sessionId: string): Promise<Draft | null> {
    const row = this.db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.sessionId, sessionId))
      .get();
    return row ? draftFromRow(row) : null;
  }

  async getDraftById(draftId: ULID): Promise<Draft | null> {
    const row = this.db
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.id, draftId))
      .get();
    return row ? draftFromRow(row) : null;
  }

  async saveDraft(draft: Draft): Promise<Draft> {
    return this.write("Cannot save Draft", () =>
      this.db.transaction((tx) => {
        const existingBySession = tx
          .select()
          .from(schema.drafts)
          .where(eq(schema.drafts.sessionId, draft.session_id))
          .get();
        if (existingBySession && existingBySession.id !== draft.id) {
          tx.delete(schema.drafts)
            .where(eq(schema.drafts.id, existingBySession.id))
            .run();
        }

        const existingById = tx
          .select()
          .from(schema.drafts)
          .where(eq(schema.drafts.id, draft.id))
          .get();
        if (existingById && existingById.sessionId !== draft.session_id) {
          throw new HumanBoardError(
            "E_INTERNAL",
            `Draft ${draft.id} belongs to another session`,
          );
        }

        const values = draftInsertValues(draft);
        tx.insert(schema.drafts)
          .values(values)
          .onConflictDoUpdate({
            target: schema.drafts.id,
            set: values,
          })
          .run();
        return draftFromRow(
          tx
            .select()
            .from(schema.drafts)
            .where(eq(schema.drafts.id, draft.id))
            .get()!,
        );
      }),
    );
  }

  async deleteDraft(draftId: ULID): Promise<void> {
    this.write("Cannot delete Draft", () => {
      this.db.delete(schema.drafts).where(eq(schema.drafts.id, draftId)).run();
    });
  }

  async commitDraft(input: CommitDraftStorageInput): Promise<Layer> {
    assertLayerHash(input.layer, input.scene);
    return this.write("Cannot commit Draft", () =>
      this.db.transaction((tx) => {
        const draft = tx
          .select()
          .from(schema.drafts)
          .where(eq(schema.drafts.id, input.draft_id))
          .get();
        if (!draft) {
          throw new HumanBoardError(
            "E_NO_DRAFT",
            `Draft ${input.draft_id} does not exist`,
          );
        }
        if (draft.status === "consumed") {
          throw new HumanBoardError(
            "E_DRAFT_CONSUMED",
            `Draft ${input.draft_id} has already been committed`,
          );
        }
        if (draft.spaceId !== input.layer.space_id) {
          throw new HumanBoardError(
            "E_INTERNAL",
            `Draft ${draft.id} and Layer ${input.layer.id} belong to different Spaces`,
          );
        }

        const layer = this.appendLayerInTransaction(tx, input);
        this.afterCommitDraftLayerInsert(draft.id);
        tx.update(schema.drafts)
          .set({
            status: "consumed",
            committedLayerId: layer.id,
          })
          .where(eq(schema.drafts.id, draft.id))
          .run();
        const consumed = tx
          .select()
          .from(schema.drafts)
          .where(eq(schema.drafts.id, draft.id))
          .get();
        if (consumed?.status !== "consumed") {
          throw new HumanBoardError(
            "E_INTERNAL",
            `Draft ${draft.id} was not consumed`,
          );
        }
        return layer;
      }),
    );
  }

  protected afterCommitDraftLayerInsert(_draftId: ULID): void {
    // Test hook for transaction rollback verification.
  }

  private appendLayerInTransaction(
    tx: Parameters<
      Parameters<BunSQLiteDatabase<typeof schema>["transaction"]>[0]
    >[0],
    input: AppendLayerInput,
    requestedSeq?: number,
  ): Layer {
    const space = tx
      .select()
      .from(schema.spaces)
      .where(eq(schema.spaces.id, input.layer.space_id))
      .get();
    if (!space) {
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        `Space ${input.layer.space_id} does not exist`,
      );
    }

    const duplicate = tx
      .select({ id: schema.layers.id })
      .from(schema.layers)
      .where(eq(schema.layers.id, input.layer.id))
      .get();
    if (duplicate) {
      throw new HumanBoardError(
        "E_INTERNAL",
        `Layer ${input.layer.id} already exists`,
      );
    }

    if (input.layer.parent_id !== null) {
      const parent = tx
        .select()
        .from(schema.layers)
        .where(eq(schema.layers.id, input.layer.parent_id))
        .get();
      if (!parent || parent.spaceId !== input.layer.space_id) {
        throw new HumanBoardError(
          "E_LAYER_NOT_FOUND",
          `Parent Layer ${input.layer.parent_id} does not exist in this Space`,
        );
      }
    }

    const seq =
      requestedSeq ??
      tx
        .select({
          seq: sql<number>`coalesce(max(${schema.layers.seq}), 0) + 1`,
        })
        .from(schema.layers)
        .where(eq(schema.layers.spaceId, input.layer.space_id))
        .get()?.seq ??
      1;

    tx.insert(schema.layers).values(layerInsertValues(input.layer, seq)).run();
    tx.insert(schema.layerScenes)
      .values({
        layerId: input.layer.id,
        sceneJson: serializeScene(input.scene),
      })
      .run();
    if (input.layer.title.length > 0) {
      this.writeMetaFieldInTransaction(
        tx,
        input.layer.space_id,
        `layer.${input.layer.id}.title`,
        input.layer.title,
      );
    }

    return layerFromRow(
      tx
        .select()
        .from(schema.layers)
        .where(eq(schema.layers.id, input.layer.id))
        .get()!,
    );
  }

  private assertMetaInput(input: MetaFieldInput): void {
    if (
      typeof input.field !== "string" ||
      input.field.length === 0 ||
      typeof input.value !== "string" ||
      !Number.isSafeInteger(input.lamport) ||
      input.lamport < 1 ||
      typeof input.device_id !== "string" ||
      input.device_id.length === 0
    ) {
      throw new HumanBoardError("E_USAGE", "Invalid meta register");
    }
  }

  private writeMetaFieldInTransaction(
    tx: SqliteTransaction,
    spaceId: ULID,
    field: string,
    value: string,
  ): MetaField {
    const current = tx
      .select()
      .from(schema.metaFields)
      .where(
        and(
          eq(schema.metaFields.spaceId, spaceId),
          eq(schema.metaFields.field, field),
        ),
      )
      .get();
    return this.storeMetaFieldInTransaction(tx, spaceId, {
      field,
      value,
      lamport: (current?.lamport ?? 0) + 1,
      device_id: this.deviceId,
    });
  }

  private storeMetaFieldInTransaction(
    tx: SqliteTransaction,
    spaceId: ULID,
    input: MetaFieldInput,
  ): MetaField {
    this.assertMetaInput(input);
    tx.insert(schema.metaFields)
      .values({
        spaceId,
        field: input.field,
        value: input.value,
        lamport: input.lamport,
        deviceId: input.device_id,
      })
      .onConflictDoUpdate({
        target: [schema.metaFields.spaceId, schema.metaFields.field],
        set: {
          value: input.value,
          lamport: input.lamport,
          deviceId: input.device_id,
        },
      })
      .run();
    const stored = metaFieldFromRow(
      tx
        .select()
        .from(schema.metaFields)
        .where(
          and(
            eq(schema.metaFields.spaceId, spaceId),
            eq(schema.metaFields.field, input.field),
          ),
        )
        .get()!,
    );
    this.applyMetaValueInTransaction(tx, stored);
    return stored;
  }

  private applyMetaValueInTransaction(
    tx: SqliteTransaction,
    meta: MetaField,
  ): void {
    if (meta.field === "space.name") {
      tx.update(schema.spaces)
        .set({ name: meta.value })
        .where(eq(schema.spaces.id, meta.space_id))
        .run();
      return;
    }

    const deleted = /^layer\.([^.]+)\.deleted$/.exec(meta.field);
    if (deleted && meta.value === "1") {
      // Classic board deletion and synced tombstones use this same transaction.
      // A named branch follows its nearest surviving first parent.
      this.sqlite
        .query(
          `
        WITH RECURSIVE lineage(id,parent_id,seq) AS (
          SELECT id,parent_id,seq FROM layers WHERE space_id=?1 AND id=?2
          UNION
          SELECT l.id,l.parent_id,l.seq FROM layers l JOIN lineage ON l.id=lineage.parent_id WHERE l.space_id=?1
        ), survivor AS (
          SELECT id FROM lineage WHERE NOT EXISTS (
            SELECT 1 FROM meta_fields WHERE space_id=?1 AND field='layer.'||lineage.id||'.deleted' AND value='1'
          ) ORDER BY seq DESC LIMIT 1
        )
        UPDATE revision_refs SET head=(SELECT id FROM survivor)
        WHERE space_id=?1 AND head=?2 AND EXISTS (SELECT 1 FROM survivor)
      `,
        )
        .run(meta.space_id, deleted[1]!);
      return;
    }

    const layerMatch = /^layer\.([^.]+)\.title$/.exec(meta.field);
    if (layerMatch?.[1] !== undefined) {
      tx.update(schema.layers)
        .set({ title: meta.value })
        .where(
          and(
            eq(schema.layers.id, layerMatch[1]),
            eq(schema.layers.spaceId, meta.space_id),
          ),
        )
        .run();
      return;
    }

    const assetMatch = /^asset\.([^.]+)\.(title|description)$/.exec(meta.field);
    if (assetMatch?.[1] !== undefined) {
      tx.update(schema.assets)
        .set(
          assetMatch[2] === "description"
            ? { description: meta.value }
            : { title: meta.value },
        )
        .where(
          and(
            eq(schema.assets.assetId, assetMatch[1]),
            eq(schema.assets.spaceId, meta.space_id),
          ),
        )
        .run();
    }
  }

  private write<T>(context: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof HumanBoardError) {
        throw error;
      }
      throw new HumanBoardError("E_INTERNAL", context, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
