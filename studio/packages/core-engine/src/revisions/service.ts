import { ulid } from "ulid";
import {
  compileDiagram,
  sceneContentHash,
  type Scene,
} from "@humanboard/schema";
import { HumanBoardError } from "../domain/errors";
import type { Author, Layer } from "../domain/types";
import type { RevisionStorage } from "./storage";
import { listVisibleLayers } from "../services/layer-visibility";
import { isSpaceDeleted } from "../services/space-visibility";
import { validateSceneAssetRefs } from "../services/scene-assets";
import { RevisionRequest } from "@humanboard/schema/revisions";
import { mergeBases, mergeScenes, equal } from "./merge";

function fail(message: string): never {
  throw new HumanBoardError("E_REVISION_CONFLICT", message);
}
function changes(a: Scene, b: Scene) {
  function items<T, K extends string>(
    kind: K,
    before: T[],
    after: T[],
    id: (e: T) => string,
    label: (e: T) => string,
  ) {
    const left = new Map(before.map((v) => [id(v), v])),
      right = new Map(after.map((v) => [id(v), v]));
    return [...new Set([...left.keys(), ...right.keys()])].flatMap((key) => {
      const old = left.get(key),
        next = right.get(key);
      return equal(old, next)
        ? []
        : [
            {
              id: key,
              entity: kind,
              label: label((next ?? old)!),
              kind: !old ? "added" : !next ? "removed" : "modified",
              before: old ?? null,
              after: next ?? null,
            },
          ];
    });
  }
  return [
    ...items(
      "节点",
      a.nodes,
      b.nodes,
      (n) => n.id,
      (n) => n.title,
    ),
    ...items(
      "连线",
      a.edges,
      b.edges,
      (e) => e.id,
      (e) => e.label || e.id,
    ),
    ...items(
      "笔迹",
      a.strokes,
      b.strokes,
      (s) => s.id,
      (s) => s.tool,
    ),
    ...items(
      "资产",
      a.assets,
      b.assets,
      (r) => r.asset_id,
      (r) => r.display_no,
    ),
    ...(equal(a.diagram, b.diagram)
      ? []
      : [
          {
            id: "diagram",
            entity: "结构图" as const,
            label: "排版定义",
            kind: "modified",
            before: a.diagram ?? null,
            after: b.diagram ?? null,
          },
        ]),
  ];
}

export class RevisionService {
  constructor(
    private storage: RevisionStorage,
    private onCommitted?: (id: string) => Promise<void>,
  ) {}
  async execute(
    spaceId: string,
    input: unknown,
    author: Author = { kind: "human" },
  ) {
    const parsed = RevisionRequest.safeParse(input);
    if (!parsed.success)
      throw new HumanBoardError("E_USAGE", "版本请求参数无效", {
        issues: parsed.error.issues,
      });
    const req = parsed.data;
    const space = await this.storage.getSpace(spaceId);
    if (!space || (await isSpaceDeleted(this.storage, spaceId)))
      throw new HumanBoardError("E_SPACE_NOT_FOUND", "空间不可用");
    let refs = this.storage.revisionRefs(spaceId);
    if (!refs.length) {
      const visible = await listVisibleLayers(this.storage, spaceId);
      const initial =
        visible.find((l) => l.id === space.active_layer_id)?.id ??
        visible.at(-1)?.id;
      if (!initial)
        throw new HumanBoardError("E_LAYER_NOT_FOUND", "请先创建初始画板");
      try {
        this.storage.publishRevision({
          spaceId,
          branch: "main",
          expected: null,
          from: initial,
        });
      } catch (e) {
        if (!(e instanceof HumanBoardError && e.code === "E_REVISION_CONFLICT"))
          throw e;
      }
      refs = this.storage.revisionRefs(spaceId);
    }
    const history = await listVisibleLayers(this.storage, spaceId);
    const byId = new Map(history.map((l) => [l.id, l]));
    const layer = (id: string): Layer => {
      const l = byId.get(id);
      if (!l)
        throw new HumanBoardError("E_LAYER_NOT_FOUND", "当前空间中没有此版本");
      return l;
    };
    const snapshot = async (id: string) => {
      layer(id);
      const s = await this.storage.getLayerScene(id);
      if (!s) throw new HumanBoardError("E_LAYER_NOT_FOUND", "缺少快照");
      return s;
    };
    if (req.action === "fork") {
      layer(req.from);
      return {
        head: this.storage.publishRevision({
          spaceId,
          branch: req.branch,
          from: req.from,
          expected: null,
        }),
      };
    }
    const head = refs.find((b) => b.name === req.branch)?.head;
    if (!head) throw new HumanBoardError("E_NOT_FOUND", "分支不存在");
    const current = await snapshot(head);
    const seconds = new Map(
      this.storage
        .mergeParents(spaceId)
        .map((row) => [row.layer_id, row.source_id]),
    );
    if (req.action === "state")
      return {
        space: space.name,
        branch: req.branch,
        head,
        refs,
        scene: current,
        history: history
          .map((l) => ({
            id: l.id,
            seq: l.seq,
            title: l.title,
            author: l.author,
            created: l.created_at,
            parent: l.parent_id,
            merged: seconds.get(l.id) ?? null,
          }))
          .reverse(),
      };
    if (req.head !== head) fail("当前分支已有新提交，请刷新版本。");
    const append = async (
      scene: Scene,
      title: string,
      options: {
        fork?: string;
        merge?: string;
        source?: { name: string; head: string };
        actor?: Author;
      } = {},
    ) => {
      if (scene.diagram) {
        try {
          compileDiagram(scene.diagram);
        } catch (e) {
          throw new HumanBoardError(
            "E_PATCH_INVALID",
            e instanceof Error ? e.message : "结构图无效",
          );
        }
      }
      const ids = new Set(scene.nodes.map((n) => n.id));
      if (
        ids.size !== scene.nodes.length ||
        [scene.edges, scene.strokes].some(
          (list) => new Set(list.map((e) => e.id)).size !== list.length,
        ) ||
        new Set(scene.assets.map((a) => a.asset_id)).size !==
          scene.assets.length ||
        scene.edges.some(
          (e) => !ids.has(e.from.node_id) || !ids.has(e.to.node_id),
        )
      )
        throw new HumanBoardError(
          "E_PATCH_INVALID",
          "图中存在重复标识或悬空连线。",
        );
      await validateSceneAssetRefs(this.storage, scene, spaceId);
      const id = ulid(),
        branch = options.fork ?? req.branch,
        actor = options.actor ?? author;
      this.storage.publishRevision({
        spaceId,
        branch,
        expected: options.fork ? null : head,
        from: head,
        mergeParent: options.merge,
        source: options.source,
        append: {
          scene,
          layer: {
            id,
            space_id: spaceId,
            parent_id: head,
            kind: "derive",
            redo_of: null,
            title,
            title_source: actor.kind === "human" ? "human" : "agent",
            author: actor,
            owner_id: space.owner_id,
            created_at: new Date().toISOString(),
            content_hash: sceneContentHash(scene),
            schema_version: 1,
          },
        },
      });
      // Observers run after publication; a failed notification cannot undo the snapshot.
      if (this.onCommitted) {
        try {
          await this.onCommitted(id);
        } catch {
          /* Watch clients can replay persisted layers. */
        }
      }
      return { head: id, branch };
    };
    if (req.action === "save") return append(req.scene, req.title);
    if (req.action === "revert") {
      const parent = layer(head).parent_id;
      if (!parent) fail("初始版本没有可回滚的修改。");
      return append(await snapshot(parent), "回滚 · " + layer(head).title);
    }
    if (req.action === "replay") {
      const id = ulid(),
        branch = "agent-" + id.slice(-8).toLowerCase();
      const n = current.nodes.at(-1);
      const scene = structuredClone(current);
      if (scene.diagram) {
        scene.diagram.nodes.push({
          id,
          title: "验收提案",
          role: "step",
          ...(scene.diagram.mode === "mindmap" && n ? { parent: n.id } : {}),
        });
        Object.assign(scene, compileDiagram(scene.diagram, scene.nodes), {
          strokes: current.strokes,
          assets: current.assets,
          diagram: scene.diagram,
        });
      } else {
        scene.nodes.push({
          id,
          kind: "job",
          title: "验收提案",
          sub: "复核变更并合入当前分支",
          rect: {
            x: n ? n.rect.x + n.rect.w + 80 : 80,
            y: n?.rect.y ?? 80,
            w: 200,
            h: 92,
          },
        });
        if (n)
          scene.edges.push({
            id: ulid(),
            from: { node_id: n.id, side: "right", offset: 0.5 },
            to: { node_id: id, side: "left", offset: 0.5 },
            label: "审阅",
          });
      }
      return append(scene, "添加验收步骤", {
        fork: branch,
        source: { name: req.branch, head },
        actor: { kind: "builtin", name: "本地回放" },
      });
    }
    layer(req.source);
    const source = req.sourceBranch
      ? { name: req.sourceBranch, head: req.source }
      : undefined;
    if (
      source &&
      refs.find((r) => r.name === source.name)?.head !== source.head
    )
      fail("来源分支已有新提交。");
    const parents = new Map(
      history.map((l) => [
        l.id,
        [l.parent_id, seconds.get(l.id)].filter(
          (id): id is string => !!id && byId.has(id),
        ),
      ]),
    );
    const bases = mergeBases(parents, head, req.source);
    if (bases.length !== 1) fail("没有唯一的共同祖先，无法自动合并。");
    const incoming = await snapshot(req.source);
    if (bases[0] === req.source) {
      if (req.action === "accept") return { head, branch: req.branch };
      const parent = layer(req.source).parent_id;
      const before = parent
        ? await snapshot(parent)
        : { nodes: [], edges: [], strokes: [], assets: [] };
      return {
        base: bases[0]!,
        head,
        source: req.source,
        preview: incoming,
        conflicts: [],
        changes: changes(before, incoming),
        alreadyMerged: true,
        comparedTo: parent,
      };
    }
    const base = await snapshot(bases[0]!);
    const result = mergeScenes(base, current, incoming);
    if (req.action === "review")
      return {
        base: bases[0]!,
        head,
        source: req.source,
        conflicts: result.conflicts,
        changes: changes(current, result.scene),
        alreadyMerged: false,
        comparedTo: head,
        preview: result.scene,
      };
    if (result.conflicts.length)
      throw new HumanBoardError(
        "E_REVISION_CONFLICT",
        "存在冲突，请在来源分支修改后重新审阅。",
        { conflicts: result.conflicts },
      );
    return append(result.scene, "合入 · " + layer(req.source).title, {
      merge: req.source,
      source,
    });
  }
}
export type RevisionResult = Awaited<ReturnType<RevisionService["execute"]>>;
export type StudioState = Extract<RevisionResult, { scene: Scene }>;
export type Review = Extract<RevisionResult, { alreadyMerged: boolean }>;
