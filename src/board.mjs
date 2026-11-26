import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  BoardError,
  diff,
  identifier,
  invalid,
  mergeScenes,
  scene,
  shortText,
  starter,
} from "./scene.mjs";

const defaultDir = fileURLToPath(
  new URL("../.humanboard-open/", import.meta.url),
);

export class Board {
  constructor(directory = process.env.HUMANBOARD_DIR || defaultDir) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "board.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, author TEXT NOT NULL,
        created TEXT NOT NULL, parents TEXT NOT NULL, cards TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS branches (
        name TEXT PRIMARY KEY, head TEXT NOT NULL REFERENCES versions(id)
      );
    `);
    this.transaction("IMMEDIATE", () => {
      if (!this.db.prepare("SELECT 1 FROM branches LIMIT 1").get()) {
        const id = this.record([], scene(starter), "协作地图 · 初稿", "human");
        this.db.prepare("INSERT INTO branches VALUES (?, ?)").run("main", id);
      }
    });
  }

  close() {
    this.db.close();
  }

  transaction(mode, run) {
    this.db.exec("BEGIN " + mode);
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  record(parents, cards, message, author) {
    shortText(message, 140);
    if (!["agent", "human"].includes(author))
      invalid("作者须为 human 或 agent。");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        id,
        message.trim(),
        author,
        new Date().toISOString(),
        JSON.stringify(parents),
        JSON.stringify(cards),
      );
    return id;
  }

  head(branch) {
    const row = this.db
      .prepare("SELECT head FROM branches WHERE name = ?")
      .get(identifier(branch));
    if (!row) throw new BoardError(404, "BRANCH_NOT_FOUND", "找不到该分支。");
    return row.head;
  }

  expect(branch, base) {
    identifier(base);
    const head = this.head(branch);
    if (base !== head)
      throw new BoardError(
        409,
        "STALE_HEAD",
        "分支已有新版本。请审阅新版本，或从原版本另建分支以保留你的修改。",
        { branch, expected: base, actual: head },
      );
    return head;
  }

  version(id) {
    const row = this.db
      .prepare("SELECT * FROM versions WHERE id = ?")
      .get(identifier(id));
    if (!row) throw new BoardError(404, "VERSION_NOT_FOUND", "找不到该版本。");
    return {
      ...row,
      cards: JSON.parse(row.cards),
      parents: JSON.parse(row.parents),
    };
  }

  graph() {
    return this.db
      .prepare(
        "SELECT id, message, author, created, parents FROM versions ORDER BY rowid DESC",
      )
      .all()
      .map((row) => ({ ...row, parents: JSON.parse(row.parents) }));
  }

  state(branch = "main") {
    return this.transaction("DEFERRED", () => {
      const head = this.head(branch);
      return {
        branch,
        head,
        cards: this.version(head).cards,
        branches: this.db
          .prepare("SELECT name, head FROM branches ORDER BY name")
          .all(),
        history: this.graph(),
      };
    });
  }

  branch({ name, from }) {
    identifier(name);
    return this.transaction("IMMEDIATE", () => {
      this.version(from);
      if (this.db.prepare("SELECT 1 FROM branches WHERE name = ?").get(name)) {
        throw new BoardError(409, "BRANCH_EXISTS", "分支名已存在。");
      }
      this.db.prepare("INSERT INTO branches VALUES (?, ?)").run(name, from);
      return { branch: name, head: from };
    });
  }

  commit({ branch, base, cards, message, author = "agent" }) {
    const normalized = scene(cards);
    shortText(message, 140);
    return this.transaction("IMMEDIATE", () => {
      this.expect(branch, base);
      if (!diff(this.version(base).cards, normalized).length)
        return { branch, head: base, unchanged: true };
      const head = this.record([base], normalized, message, author);
      this.db
        .prepare("UPDATE branches SET head = ? WHERE name = ?")
        .run(head, branch);
      return { branch, head };
    });
  }

  compare(from, to) {
    return diff(this.version(from).cards, this.version(to).cards);
  }

  merge({
    target,
    source,
    targetHead,
    sourceHead,
    preview = false,
    resolutions = [],
    author = "agent",
  }) {
    if (target === source) invalid("请选择两个不同分支。");
    if (typeof preview !== "boolean") invalid("preview 须为布尔值。");
    return this.transaction(preview ? "DEFERRED" : "IMMEDIATE", () => {
      this.expect(target, targetHead);
      this.expect(source, sourceHead);
      const graph = new Map(this.graph().map((v) => [v.id, v.parents]));
      const sourceAncestors = ancestors(graph, sourceHead);
      const targetAncestors = ancestors(graph, targetHead);
      const common = [...sourceAncestors].filter((id) =>
        targetAncestors.has(id),
      );
      const dominated = new Set(common.flatMap((id) => graph.get(id)));
      const bases = common.filter((id) => !dominated.has(id));
      if (bases.length !== 1) {
        throw new BoardError(
          409,
          "AMBIGUOUS_BASE",
          "历史中存在多个最近共同祖先，请另建分支人工整理。",
          { bases },
        );
      }
      const base = bases[0];
      const ours = this.version(targetHead).cards;
      const theirs = this.version(sourceHead).cards;
      const { cards, conflicts } = mergeScenes(
        this.version(base).cards,
        ours,
        theirs,
        resolutions,
      );
      const changes = diff(ours, cards);
      const result = {
        base,
        target,
        source,
        targetHead,
        sourceHead,
        conflicts,
        changes,
      };
      if (preview) return result;
      if (conflicts.length)
        throw new BoardError(
          409,
          "MERGE_CONFLICT",
          "同一处发生了不同修改，请逐项选择。",
          result,
        );
      if (sourceHead === base)
        return { ...result, head: targetHead, unchanged: true };
      const head =
        targetHead === base
          ? sourceHead
          : this.record(
              [targetHead, sourceHead],
              cards,
              `合并 ${source} 到 ${target}`,
              author,
            );
      this.db
        .prepare("UPDATE branches SET head = ? WHERE name = ?")
        .run(head, target);
      return { ...result, head };
    });
  }
}

function ancestors(graph, start) {
  const seen = new Set();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...graph.get(id));
  }
  return seen;
}

export function publicError(error) {
  if (error instanceof BoardError)
    return {
      status: error.status,
      body: { code: error.code, message: error.message, ...error.details },
    };
  if (error.errcode === 5 || error.errcode === 6)
    return {
      status: 503,
      body: { code: "DB_BUSY", message: "画板正在写入，请稍后重试。" },
    };
  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "画板操作失败。" },
  };
}
