import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { AUTHOR_KINDS, LAYER_KINDS, TITLE_SOURCES } from "../../domain/types";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  root: text("root"),
  ownerId: text("owner_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    activeLayerId: text("active_layer_id"),
    ownerId: text("owner_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("spaces_project_id_idx").on(table.projectId)],
);

export const layers = sqliteTable(
  "layers",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    seq: integer("seq", { mode: "number" }).notNull(),
    seqOrigin: integer("seq_origin", { mode: "number" }),
    parentId: text("parent_id"),
    kind: text("kind", { enum: LAYER_KINDS }).notNull(),
    redoOf: text("redo_of"),
    title: text("title").notNull(),
    titleSource: text("title_source", { enum: TITLE_SOURCES }).notNull(),
    createdAt: text("created_at").notNull(),
    authorKind: text("author_kind", { enum: AUTHOR_KINDS }).notNull(),
    authorName: text("author_name"),
    schemaVersion: integer("schema_version", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    ownerId: text("owner_id").notNull(),
  },
  (table) => [
    uniqueIndex("layers_space_seq_uq").on(table.spaceId, table.seq),
    index("layers_space_id_idx").on(table.spaceId),
    index("layers_parent_id_idx").on(table.parentId),
    index("layers_content_hash_idx").on(table.contentHash),
  ],
);

export const layerScenes = sqliteTable("layer_scenes", {
  layerId: text("layer_id")
    .primaryKey()
    .references(() => layers.id, { onDelete: "cascade" }),
  sceneJson: text("scene_json").notNull(),
});

export const assets = sqliteTable(
  "assets",
  {
    assetId: text("asset_id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    displayNo: text("display_no").notNull(),
    type: text("type", { enum: ["image", "url"] }).notNull(),
    title: text("title").notNull(),
    titleSource: text("title_source", { enum: TITLE_SOURCES }),
    blobHash: text("blob_hash"),
    sourceUrl: text("source_url"),
    description: text("description"),
    ownerId: text("owner_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("assets_space_display_no_uq").on(
      table.spaceId,
      table.displayNo,
    ),
    index("assets_space_id_idx").on(table.spaceId),
  ],
);

export const metaFields = sqliteTable(
  "meta_fields",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    value: text("value").notNull(),
    lamport: integer("lamport", { mode: "number" }).notNull(),
    deviceId: text("device_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.field] }),
    index("meta_fields_space_id_idx").on(table.spaceId),
  ],
);

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_sessions_project_space_uq").on(
      table.projectId,
      table.spaceId,
    ),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    seq: integer("seq", { mode: "number" }).notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    toolTraceJson: text("tool_trace_json"),
    reasoningJson: text("reasoning_json"),
    baseLayerId: text("base_layer_id"),
    resultLayerId: text("result_layer_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("agent_messages_session_id_idx").on(table.sessionId, table.createdAt),
    uniqueIndex("agent_messages_session_seq_uq").on(table.sessionId, table.seq),
  ],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    parentId: text("parent_id"),
    kind: text("kind", { enum: LAYER_KINDS }).notNull(),
    redoOf: text("redo_of"),
    sceneJson: text("scene_json").notNull(),
    authorKind: text("author_kind", { enum: AUTHOR_KINDS }).notNull(),
    authorName: text("author_name"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    status: text("status", { enum: ["open", "consumed"] }).notNull(),
    committedLayerId: text("committed_layer_id"),
  },
  (table) => [
    uniqueIndex("drafts_session_id_uq").on(table.sessionId),
    index("drafts_space_id_idx").on(table.spaceId),
    index("drafts_project_id_idx").on(table.projectId),
    index("drafts_status_idx").on(table.status),
  ],
);

export const SQLITE_SCHEMA_VERSION = 8;

// Historical v1 shape. Keep this frozen; later migrations add newer columns.
export const SQLITE_V1_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  root TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_layer_id TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS layers (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'derive', 'redo', 'transform')),
  redo_of TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('agent', 'human', 'builtin', 'pending')),
  created_at TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'cli', 'builtin')),
  author_name TEXT,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS layer_scenes (
  layer_id TEXT PRIMARY KEY NOT NULL,
  scene_json TEXT NOT NULL,
  FOREIGN KEY (layer_id) REFERENCES layers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  display_no TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'url')),
  title TEXT NOT NULL,
  title_source TEXT CHECK (title_source IN ('agent', 'human', 'builtin', 'pending')),
  blob_hash TEXT,
  source_url TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  base_layer_id TEXT,
  result_layer_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'derive', 'redo', 'transform')),
  redo_of TEXT,
  scene_json TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'cli', 'builtin')),
  author_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'consumed')),
  committed_layer_id TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS layers_space_seq_uq ON layers(space_id, seq);
CREATE INDEX IF NOT EXISTS layers_space_id_idx ON layers(space_id);
CREATE INDEX IF NOT EXISTS layers_parent_id_idx ON layers(parent_id);
CREATE INDEX IF NOT EXISTS layers_content_hash_idx ON layers(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS assets_space_display_no_uq ON assets(space_id, display_no);
CREATE INDEX IF NOT EXISTS assets_space_id_idx ON assets(space_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_project_space_uq ON agent_sessions(project_id, space_id);
CREATE INDEX IF NOT EXISTS agent_messages_session_id_idx ON agent_messages(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_session_id_uq ON drafts(session_id);
CREATE INDEX IF NOT EXISTS drafts_space_id_idx ON drafts(space_id);
CREATE INDEX IF NOT EXISTS drafts_project_id_idx ON drafts(project_id);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts(status);
CREATE INDEX IF NOT EXISTS spaces_project_id_idx ON spaces(project_id);
`;

export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  root TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_layer_id TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS layers (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  seq_origin INTEGER,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'derive', 'redo', 'transform')),
  redo_of TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('agent', 'human', 'builtin', 'pending')),
  created_at TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'cli', 'builtin')),
  author_name TEXT,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS layer_scenes (
  layer_id TEXT PRIMARY KEY NOT NULL,
  scene_json TEXT NOT NULL,
  FOREIGN KEY (layer_id) REFERENCES layers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  display_no TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'url')),
  title TEXT NOT NULL,
  title_source TEXT CHECK (title_source IN ('agent', 'human', 'builtin', 'pending')),
  blob_hash TEXT,
  source_url TEXT,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS meta_fields (
  space_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  lamport INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (space_id, field),
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  base_layer_id TEXT,
  result_layer_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('root', 'derive', 'redo', 'transform')),
  redo_of TEXT,
  scene_json TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'cli', 'builtin')),
  author_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'consumed')),
  committed_layer_id TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (space_id) REFERENCES spaces(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS layers_space_seq_uq ON layers(space_id, seq);
CREATE INDEX IF NOT EXISTS layers_space_id_idx ON layers(space_id);
CREATE INDEX IF NOT EXISTS layers_parent_id_idx ON layers(parent_id);
CREATE INDEX IF NOT EXISTS layers_content_hash_idx ON layers(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS assets_space_display_no_uq ON assets(space_id, display_no);
CREATE INDEX IF NOT EXISTS assets_space_id_idx ON assets(space_id);
CREATE INDEX IF NOT EXISTS meta_fields_space_id_idx ON meta_fields(space_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_project_space_uq ON agent_sessions(project_id, space_id);
CREATE INDEX IF NOT EXISTS agent_messages_session_id_idx ON agent_messages(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_session_id_uq ON drafts(session_id);
CREATE INDEX IF NOT EXISTS drafts_space_id_idx ON drafts(space_id);
CREATE INDEX IF NOT EXISTS drafts_project_id_idx ON drafts(project_id);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts(status);
CREATE INDEX IF NOT EXISTS spaces_project_id_idx ON spaces(project_id);
`;
