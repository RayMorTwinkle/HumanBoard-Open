import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { sceneContentHash, type Scene } from "@humanboard/schema";
import { SqliteStorageAdapter } from "../../../packages/core-engine/src/storage/sqlite/sqlite-storage-adapter";
import { RevisionService } from "../../../packages/core-engine/src/revisions/service";
import { ulid } from "ulid";

function starter(): Scene {
  const nodes = [
    ["brief", "state", "研究问题", "收集现场观察", 40, 170, "teal"],
    ["evidence", "database", "证据库", "整理原始材料", 340, 50, "blue"],
    ["map", "job", "结构草图", "连接关键判断", 340, 280, "purple"],
    ["review", "gateway", "联合审阅", "核对版本差异", 640, 170, "amber"],
    ["release", "service", "发布结论", "保留决策记录", 940, 170, "teal"],
  ] as const;
  return {
    nodes: nodes.map(([id, kind, title, sub, x, y, color]) => ({
      id,
      kind,
      title,
      sub,
      rect: { x, y, w: 204, h: 104 },
      style: { color },
    })),
    edges: [
      ["brief", "evidence"],
      ["brief", "map"],
      ["evidence", "review"],
      ["map", "review"],
      ["review", "release"],
    ].map(([a, b]) => ({
      id: a + "-" + b,
      from: { node_id: a!, side: "right", offset: 0.5 },
      to: { node_id: b!, side: "left", offset: 0.5 },
      style: { curve: true },
    })),
    strokes: [],
    assets: [],
  };
}
export async function openWorkspace(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(join(directory, "studio.sqlite"));
  const storage = new SqliteStorageAdapter({ database: db });
  // Hold the installation lock across all three bootstrap records, including across processes.
  db.exec("BEGIN IMMEDIATE");
  try {
    let project = (await storage.listProjects())[0];
    if (!project) {
      const created_at = new Date().toISOString();
      project = await storage.createProject({
        id: ulid(),
        name: "本地工作区",
        root: null,
        owner_id: "local",
        created_at,
      });
      const space = await storage.createSpace({
        id: ulid(),
        name: "协作地图",
        project_id: project.id,
        active_layer_id: null,
        owner_id: "local",
        created_at,
      });
      const scene = starter(),
        id = ulid();
      await storage.appendLayer({
        scene,
        layer: {
          id,
          parent_id: null,
          kind: "root",
          redo_of: null,
          title: "研究流程初稿",
          title_source: "human",
          author: { kind: "human" },
          schema_version: 1,
          created_at,
          owner_id: "local",
          space_id: space.id,
          content_hash: sceneContentHash(scene),
        },
      });
      await storage.setSpaceActiveLayer(space.id, id);
    }
    const [space] = await storage.listSpaces(project.id);
    db.exec("COMMIT");
    return {
      service: new RevisionService(storage),
      projectId: project.id,
      spaceId: space!.id,
      close: () => db.close(),
    };
  } catch (e) {
    db.exec("ROLLBACK");
    db.close();
    throw e;
  }
}
