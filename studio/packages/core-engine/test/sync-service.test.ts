import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DraftService,
  LocalBlobAdapter,
  SceneDiffService,
  SqliteStorageAdapter,
  SyncService,
  OWNER_ID,
  type Asset,
  type Layer,
} from "../src";
import { sceneContentHash, type Scene } from "@humanboard/schema";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ASSET_A_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ASSET_B_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const CREATED_AT = "2026-10-22T00:00:00.000Z";

test("chat-only sync preserves message IDs and order across different local sessions, then resumes on the peer", async () => {
  const a = await createInstance(),
    b = await createInstance();
  const sessionA = "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    sessionB = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const ids = [
    "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  ];
  try {
    for (const [instance, id] of [
      [a, sessionA],
      [b, sessionB],
    ] as const)
      await instance.storage.createAgentSession({
        id,
        project_id: PROJECT_ID,
        space_id: SPACE_ID,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      });
    await a.storage.appendAgentMessage({
      id: ids[0]!,
      session_id: sessionA,
      role: "user",
      content: "先讨论重试次数，不改图。",
      base_layer_id: null,
      result_layer_id: null,
      created_at: CREATED_AT,
    });
    await a.storage.appendAgentMessage({
      id: ids[1]!,
      session_id: sessionA,
      role: "assistant",
      content: "我们先比较3次和5次。",
      reasoning_steps: [{ step: 1, content: "先比较不同次数的取舍。" }],
      base_layer_id: null,
      result_layer_id: null,
      created_at: CREATED_AT,
      tool_trace: [],
    });
    const exported = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);
    await b.sync.applyPush(PROJECT_ID, SPACE_ID, exported);
    const copied = await b.storage.listAgentMessages(sessionB);
    expect(copied[1]!.reasoning_steps).toEqual([
      { step: 1, content: "先比较不同次数的取舍。" },
    ]);
    expect(copied.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(copied.map((m) => m.seq)).toEqual([1, 2]);
    expect(copied.every((m) => m.session_id === sessionB)).toBe(true);
    await b.sync.applyPush(PROJECT_ID, SPACE_ID, exported);
    expect(await b.storage.listAgentMessages(sessionB)).toHaveLength(2);
    await expect(
      b.sync.applyPush(PROJECT_ID, SPACE_ID, {
        ...exported,
        chat: {
          ...exported.chat!,
          messages: exported.chat!.messages.map((m, i) =>
            i === 0 ? { ...m, content: "same ID with changed content" } : m,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "E_HASH_MISMATCH" });
    expect((await b.storage.listAgentMessages(sessionB))[0]!.content).toBe(
      "先讨论重试次数，不改图。",
    );
    await expect(
      b.sync.applyPush(PROJECT_ID, SPACE_ID, {
        ...exported,
        chat: {
          ...exported.chat!,
          session: { ...exported.chat!.session, project_id: SPACE_ID },
        },
      }),
    ).rejects.toMatchObject({ code: "E_USAGE" });
    await b.storage.appendAgentMessage({
      id: ids[2]!,
      session_id: sessionB,
      role: "user",
      content: "接着上次讨论，选5次。",
      base_layer_id: null,
      result_layer_id: null,
      created_at: CREATED_AT,
    });
    await b.storage.appendAgentMessage({
      id: ids[3]!,
      session_id: sessionB,
      role: "assistant",
      content: "沿用上次上下文，选择5次。",
      base_layer_id: null,
      result_layer_id: null,
      created_at: CREATED_AT,
    });
    const back = await b.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);
    await a.sync.applyPush(PROJECT_ID, SPACE_ID, back);
    expect(
      (await a.storage.listAgentMessages(sessionA)).map((m) => m.id),
    ).toEqual(ids);
    expect(await a.storage.listLayers(SPACE_ID)).toEqual([]);
    expect(await b.storage.listLayers(SPACE_ID)).toEqual([]);
  } finally {
    a.storage.close();
    b.storage.close();
  }
});

interface Instance {
  readonly storage: SqliteStorageAdapter;
  readonly blobs: LocalBlobAdapter;
  readonly drafts: DraftService;
  readonly diffs: SceneDiffService;
  readonly sync: SyncService;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createInstance(): Promise<Instance> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-sync-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "blobs"), { recursive: true });
  const storage = new SqliteStorageAdapter({
    databasePath: join(root, "humanboard.sqlite"),
  });
  const blobs = new LocalBlobAdapter({ rootDir: join(root, "blobs") });
  await storage.createProject({
    id: PROJECT_ID,
    name: "sync-project",
    root: null,
    owner_id: OWNER_ID,
    created_at: CREATED_AT,
  });
  await storage.createSpace({
    id: SPACE_ID,
    project_id: PROJECT_ID,
    name: "main",
    active_layer_id: null,
    owner_id: OWNER_ID,
    created_at: CREATED_AT,
  });
  return {
    storage,
    blobs,
    drafts: new DraftService({ storage }),
    diffs: new SceneDiffService(storage),
    sync: new SyncService({ storage, blobs }),
  };
}

async function commitLayer(
  instance: Instance,
  sessionId: string,
  parentId: string | undefined,
  scene: Scene,
  title: string,
): Promise<Layer> {
  const draft = await instance.drafts.createDraft({
    sessionId,
    projectId: PROJECT_ID,
    spaceId: SPACE_ID,
    kind: parentId === undefined ? "root" : "derive",
    ...(parentId === undefined ? {} : { parentId }),
    scene,
    author: { kind: "cli", name: "sync-test" },
  });
  const committed = await instance.drafts.commitDraft({
    sessionId,
    draftId: draft.draft.id,
    title,
  });
  return committed.layer;
}

function nodeScene(id: string): Scene {
  return {
    nodes: [
      {
        id,
        kind: "note" as const,
        title: id,
        rect: { x: 10, y: 20, w: 120, h: 60 },
      },
    ],
    edges: [],
    strokes: [],
    assets: [],
  };
}

describe("SyncService", () => {
  test("push bootstrap rejects invalid identities before creating records and never moves an existing Space", async () => {
    const instance = await createInstance();
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FB5",
      spaceId = "01ARZ3NDEKTSV4RRFFQ69G5FB6";
    try {
      const existing = (await instance.sync.negotiate(PROJECT_ID, SPACE_ID, []))
        .scope!;
      const payload = {
        project_id: projectId,
        space_id: spaceId,
        layers: [],
        blobs: [],
        meta: [],
        scope: {
          project: { ...existing.project, id: projectId },
          space: { ...existing.space, id: spaceId, project_id: projectId },
        },
      };
      await expect(
        instance.sync.applyPush(projectId, spaceId, {
          ...payload,
          scope: {
            ...payload.scope,
            space: { ...payload.scope.space, project_id: PROJECT_ID },
          },
        }),
      ).rejects.toMatchObject({ code: "E_USAGE" });
      expect(await instance.storage.getProject(projectId)).toBeNull();
      expect(await instance.storage.getSpace(spaceId)).toBeNull();
      await expect(
        instance.sync.applyPush(projectId, SPACE_ID, {
          ...payload,
          space_id: SPACE_ID,
          scope: {
            ...payload.scope,
            space: { ...payload.scope.space, id: SPACE_ID },
          },
        }),
      ).rejects.toMatchObject({ code: "E_USAGE" });
      expect(await instance.storage.getProject(projectId)).toBeNull();
      expect((await instance.storage.getSpace(SPACE_ID))!.project_id).toBe(
        PROJECT_ID,
      );
      expect(
        (await instance.sync.applyPush(projectId, spaceId, payload)).rejected,
      ).toEqual([]);
      expect((await instance.storage.getSpace(spaceId))!.project_id).toBe(
        projectId,
      );
      expect((await instance.storage.getProject(projectId))!.root).toBeNull();
      await instance.sync.applyPush(projectId, spaceId, payload);
      expect(await instance.storage.listSpaces(projectId)).toHaveLength(1);
    } finally {
      instance.storage.close();
    }
  });

  test("preserves non-conflicting inbound sequence numbers", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const a1 = await commitLayer(
        a,
        "a-root",
        undefined,
        nodeScene("a-root"),
        "A root",
      );
      const a2 = await commitLayer(
        a,
        "a-derive",
        a1.id,
        nodeScene("a-2"),
        "A derive",
      );
      const pushed = await a.sync.push(PROJECT_ID, SPACE_ID, [a1.id, a2.id]);
      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed);

      expect(applied.rejected).toEqual([]);
      expect(applied.seq_map).toEqual({});
      expect(applied.warnings).toEqual([]);
      expect((await b.storage.getLayer(a1.id))?.seq).toBe(1);
      expect((await b.storage.getLayer(a2.id))?.seq).toBe(2);
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("orders incoming DAG parents before children and allocates local sequence without remote gaps", async () => {
    const a = await createInstance(),
      b = await createInstance();
    try {
      const first = await commitLayer(
        a,
        "topo-root",
        undefined,
        nodeScene("root"),
        "Root",
      );
      const child = await commitLayer(
        a,
        "topo-child",
        first.id,
        nodeScene("child"),
        "Child",
      );
      const push = await a.sync.push(PROJECT_ID, SPACE_ID, [
        child.id,
        first.id,
      ]);
      const reordered = {
        ...push,
        layers: push.layers.map((item) => ({
          ...item,
          layer: { ...item.layer, seq: item.layer.id === first.id ? 99 : 1 },
        })),
      };
      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, reordered);
      expect(applied.rejected).toEqual([]);
      expect((await b.storage.getLayer(first.id))?.seq).toBe(1);
      expect((await b.storage.getLayer(child.id))?.seq).toBe(2);
      expect((await b.storage.getLayer(child.id))?.parent_id).toBe(first.id);
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("rejects an existing Layer id when the incoming content differs", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const root = await commitLayer(
        a,
        "a-root",
        undefined,
        nodeScene("original"),
        "A root",
      );
      const pushed = await a.sync.push(PROJECT_ID, SPACE_ID, [root.id]);
      expect(
        (await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed)).rejected,
      ).toEqual([]);

      const changedScene = nodeScene("changed");
      const conflicting = {
        ...pushed,
        layers: [
          {
            ...pushed.layers[0]!,
            layer: {
              ...pushed.layers[0]!.layer,
              content_hash: sceneContentHash(
                changedScene,
              ) as `sha256:${string}`,
            },
            scene: changedScene,
          },
        ],
      };
      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, conflicting);

      expect(applied.accepted).toEqual([]);
      expect(applied.rejected).toEqual([
        {
          layer_id: root.id,
          code: "E_HASH_MISMATCH",
          message: `Layer ${root.id} already exists with different content`,
        },
      ]);
      expect((await b.storage.getLayerScene(root.id))?.nodes[0]?.id).toBe(
        "original",
      );
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("preserves distinct Layer identities with identical content and their descendants", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const first = await commitLayer(
        a,
        "a-first",
        undefined,
        nodeScene("shared-content"),
        "First",
      );
      const second = await commitLayer(
        a,
        "a-second",
        first.id,
        nodeScene("shared-content"),
        "Second",
      );
      expect(second.content_hash).toBe(first.content_hash);

      const pushed = await a.sync.push(PROJECT_ID, SPACE_ID, [
        first.id,
        second.id,
      ]);
      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed);

      expect(applied.accepted).toEqual([first.id, second.id]);
      expect(applied.rejected).toEqual([]);
      expect(
        (await b.storage.listLayers(SPACE_ID)).map((layer) => layer.id),
      ).toEqual([first.id, second.id]);
      expect((await b.storage.getLayer(second.id))?.parent_id).toBe(first.id);
      const third = await commitLayer(
        a,
        "a-third",
        second.id,
        nodeScene("changed"),
        "Third",
      );
      const delta = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, [
        third.id,
      ]);
      const next = await b.sync.applyPush(PROJECT_ID, SPACE_ID, delta);
      expect(next.rejected).toEqual([]);
      expect((await b.storage.getLayer(third.id))?.parent_id).toBe(second.id);
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("adopts a missing active ref but keeps the local focus on conflict", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const aRoot = await commitLayer(
        a,
        "a-root",
        undefined,
        nodeScene("a-root"),
        "A root",
      );
      const bRoot = await commitLayer(
        b,
        "b-root",
        undefined,
        nodeScene("b-root"),
        "B root",
      );
      await a.storage.setSpaceActiveLayer(SPACE_ID, aRoot.id);
      const pushed = await a.sync.push(PROJECT_ID, SPACE_ID, [aRoot.id]);
      await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed);
      expect((await b.storage.getSpace(SPACE_ID))?.active_layer_id).toBeNull();

      const adopted = await b.sync.negotiate(PROJECT_ID, SPACE_ID, [bRoot.id], {
        active: aRoot.id,
      });
      expect(adopted.refs.active).toBe(aRoot.id);
      expect((await b.storage.getSpace(SPACE_ID))?.active_layer_id).toBe(
        aRoot.id,
      );

      await b.storage.setSpaceActiveLayer(SPACE_ID, bRoot.id);
      const conflict = await b.sync.negotiate(
        PROJECT_ID,
        SPACE_ID,
        [aRoot.id, bRoot.id],
        { active: aRoot.id },
      );
      expect(conflict.refs.active).toBe(bRoot.id);
      expect((await b.storage.getSpace(SPACE_ID))?.active_layer_id).toBe(
        bRoot.id,
      );

      const omitted = await b.sync.negotiate(
        PROJECT_ID,
        SPACE_ID,
        [aRoot.id, bRoot.id],
        { active: null },
      );
      expect(omitted.refs.active).toBe(bRoot.id);
      expect((await b.storage.getSpace(SPACE_ID))?.active_layer_id).toBe(
        bRoot.id,
      );
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("converges meta by Lamport and device_id across reciprocal pushes", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      await a.storage.mergeMetaFields(SPACE_ID, [
        {
          field: "space.name",
          value: "from-a",
          lamport: 7,
          device_id: "device-a",
        },
      ]);
      await b.storage.mergeMetaFields(SPACE_ID, [
        {
          field: "space.name",
          value: "from-b",
          lamport: 7,
          device_id: "device-b",
        },
      ]);

      const aToB = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);
      const bApplied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, aToB);
      expect(bApplied.meta_conflicts).toEqual([
        {
          field: "space.name",
          incoming: {
            field: "space.name",
            value: "from-a",
            lamport: 7,
            device_id: "device-a",
          },
          current: {
            field: "space.name",
            value: "from-b",
            lamport: 7,
            device_id: "device-b",
          },
          winner: "current",
        },
      ]);

      const bToA = await b.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);
      const aApplied = await a.sync.applyPush(PROJECT_ID, SPACE_ID, bToA);
      expect(aApplied.meta_conflicts).toEqual([
        {
          field: "space.name",
          incoming: {
            field: "space.name",
            value: "from-b",
            lamport: 7,
            device_id: "device-b",
          },
          current: {
            field: "space.name",
            value: "from-a",
            lamport: 7,
            device_id: "device-a",
          },
          winner: "incoming",
        },
      ]);

      const expected = {
        space_id: SPACE_ID,
        field: "space.name",
        value: "from-b",
        lamport: 7,
        device_id: "device-b",
      };
      expect(await a.storage.listMetaFields(SPACE_ID)).toEqual([expected]);
      expect(await b.storage.listMetaFields(SPACE_ID)).toEqual([expected]);
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("records only real same-key meta conflicts", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const shared = {
        field: "space.name",
        value: "shared",
        lamport: 3,
        device_id: "device-a",
      } as const;
      await a.storage.mergeMetaFields(SPACE_ID, [shared]);
      await b.storage.mergeMetaFields(SPACE_ID, [shared]);
      const payload = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);

      const noConflict = await b.sync.applyPush(PROJECT_ID, SPACE_ID, payload);
      expect(noConflict.meta_conflicts).toEqual([]);

      await b.storage.mergeMetaFields(SPACE_ID, [
        {
          field: "space.name",
          value: "local-b",
          lamport: 3,
          device_id: "device-b",
        },
      ]);
      const conflict = await b.sync.applyPush(PROJECT_ID, SPACE_ID, payload);
      expect(conflict.meta_conflicts).toEqual([
        {
          field: "space.name",
          incoming: shared,
          current: {
            field: "space.name",
            value: "local-b",
            lamport: 3,
            device_id: "device-b",
          },
          winner: "current",
        },
      ]);
      expect((await b.storage.getSpace(SPACE_ID))?.name).toBe("local-b");
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("preserves forks without synthesizing a merge layer", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const root = await commitLayer(
        a,
        "a-root",
        undefined,
        nodeScene("a-root"),
        "A root",
      );
      const rootPayload = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, [
        root.id,
      ]);
      expect(
        (await b.sync.applyPush(PROJECT_ID, SPACE_ID, rootPayload)).rejected,
      ).toEqual([]);

      const left = await commitLayer(
        a,
        "a-left",
        root.id,
        nodeScene("a-left"),
        "A left",
      );
      const right = await commitLayer(
        a,
        "a-right",
        root.id,
        nodeScene("a-right"),
        "A right",
      );
      const forkPayload = await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, [
        left.id,
        right.id,
      ]);
      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, forkPayload);
      expect(applied.rejected).toEqual([]);
      expect(applied.accepted).toEqual([left.id, right.id]);

      const layers = await b.storage.listLayers(SPACE_ID);
      expect(layers).toHaveLength(3);
      expect(
        layers
          .filter((layer) => layer.parent_id === root.id)
          .map((layer) => layer.id)
          .sort(),
      ).toEqual([left.id, right.id].sort());
      expect(layers.map((layer) => layer.kind)).toEqual([
        "root",
        "derive",
        "derive",
      ]);
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });

  test("negotiates, pushes, pulls, remaps assets, and handles seq conflicts", async () => {
    const a = await createInstance();
    const b = await createInstance();
    try {
      const a1 = await commitLayer(
        a,
        "a-root",
        undefined,
        nodeScene("a-root"),
        "A root",
      );
      const a2 = await commitLayer(
        a,
        "a-derive",
        a1.id,
        nodeScene("a-2"),
        "A derive",
      );
      const aBlob = new TextEncoder().encode("shared-sync-blob");
      const aBlobHash = await a.blobs.writeBlob(aBlob);
      await a.storage.createAsset({
        asset_id: ASSET_A_ID,
        space_id: SPACE_ID,
        display_no: "001",
        type: "image",
        title: "A screenshot",
        description: "Payment callback sequence",
        title_source: "human",
        blob_hash: aBlobHash,
        source_url: null,
        owner_id: OWNER_ID,
        created_at: CREATED_AT,
      });
      const a3 = await commitLayer(
        a,
        "a-asset",
        a2.id,
        {
          ...nodeScene("a-3"),
          assets: [
            {
              asset_id: ASSET_A_ID,
              display_no: "001",
              rect: { x: 30, y: 40, w: 200, h: 100 },
              z: 1,
            },
          ],
        },
        "A asset",
      );

      const b1 = await commitLayer(
        b,
        "b-root",
        undefined,
        nodeScene("b-root"),
        "B root",
      );
      const b2 = await commitLayer(
        b,
        "b-derive",
        b1.id,
        nodeScene("b-2"),
        "B derive",
      );
      await b.storage.createAsset({
        asset_id: ASSET_B_ID,
        space_id: SPACE_ID,
        display_no: "001",
        type: "url",
        title: "B URL",
        title_source: "human",
        blob_hash: null,
        source_url: "https://example.com/b",
        owner_id: OWNER_ID,
        created_at: CREATED_AT,
      });

      const negotiation = await a.sync.negotiate(PROJECT_ID, SPACE_ID, [
        b1.id,
        b2.id,
      ]);
      expect(negotiation.missing).toEqual([a1.id, a2.id, a3.id]);
      expect(negotiation.blobs).toEqual([aBlobHash]);

      const pulled = await a.sync.pullLayer(PROJECT_ID, SPACE_ID, a3.id);
      expect(pulled.assets.map((asset) => asset.asset_id)).toEqual([
        ASSET_A_ID,
      ]);
      expect(pulled.blobs[0]?.hash).toBe(aBlobHash);

      const pushed = await a.sync.push(PROJECT_ID, SPACE_ID, [
        a1.id,
        a2.id,
        a3.id,
      ]);
      expect(pushed.layers).toHaveLength(3);
      const pushedBlob = pushed.blobs[0];
      expect(
        typeof pushedBlob === "string" ? pushedBlob : pushedBlob?.hash,
      ).toBe(aBlobHash);

      const applied = await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed);
      expect(applied.rejected).toEqual([]);
      expect(applied.accepted).toEqual([a1.id, a2.id, a3.id]);
      expect(applied.seq_map[a1.id]).toEqual({ from: 1, to: 3 });
      expect(applied.seq_map[a2.id]).toEqual({ from: 2, to: 4 });
      expect(applied.seq_map[a3.id]).toEqual({ from: 3, to: 5 });
      expect(applied.warnings.map((warning) => warning.code)).toEqual([
        "W_SEQ_REASSIGNED",
        "W_SEQ_REASSIGNED",
        "W_SEQ_REASSIGNED",
      ]);

      const importedA1 = await b.storage.getLayer(a1.id);
      const importedA2 = await b.storage.getLayer(a2.id);
      expect(importedA1?.seq).toBe(3);
      expect(importedA1?.seq_origin).toBe(1);
      expect(importedA2?.seq).toBe(4);
      expect(importedA2?.seq_origin).toBe(2);
      expect((await b.storage.getLayer(b1.id))?.seq).toBe(1);
      expect((await b.storage.getLayer(b2.id))?.seq).toBe(2);

      const diff = await b.diffs.diffLayers(a1.id, a2.id);
      expect(diff.mode).toBe("ast");
      expect(await b.storage.getLayerScene(a2.id)).not.toBeNull();

      const importedScene = await b.storage.getLayerScene(a3.id);
      const importedRef = importedScene?.assets[0];
      expect(importedRef?.display_no).toBe("002");
      expect(importedRef?.asset_id).not.toBe(ASSET_A_ID);
      const importedAsset = importedRef
        ? await b.storage.getAsset(importedRef.asset_id)
        : null;
      expect(importedAsset?.blob_hash).toBe(aBlobHash);
      expect(importedAsset?.description).toBe("Payment callback sequence");
      expect(Buffer.from(await b.blobs.readBlob(aBlobHash)).toString()).toBe(
        "shared-sync-blob",
      );

      const appliedAgain = await b.sync.applyPush(PROJECT_ID, SPACE_ID, pushed);
      expect(appliedAgain.rejected).toEqual([]);
      expect(appliedAgain.accepted).toEqual([a1.id, a2.id, a3.id]);
      const shard = await readdir(
        join(temporaryDirectories.at(-1)!, "blobs", aBlobHash.slice(7, 9)),
      );
      expect(shard).toEqual([aBlobHash.slice(9)]);

      const a4 = await commitLayer(a, "a4", a3.id, nodeScene("a-4"), "A4");
      const badPayload = await a.sync.push(PROJECT_ID, SPACE_ID, [a4.id]);
      const bad = {
        ...badPayload,
        layers: badPayload.layers.map((layer) => ({
          ...layer,
          layer: {
            ...layer.layer,
            content_hash: `sha256:${"0".repeat(64)}` as const,
          },
        })),
      };
      const rejected = await b.sync.applyPush(PROJECT_ID, SPACE_ID, bad);
      expect(rejected.rejected[0]?.code).toBe("E_HASH_MISMATCH");
    } finally {
      a.storage.close();
      b.storage.close();
    }
  });
});

test("Space delete and restore metadata travel through the real sync payload", async () => {
  const { isSpaceDeleted, SPACE_DELETED_FIELD } = await import(
    "../src/services/space-visibility"
  );
  const a = await createInstance(),
    b = await createInstance();
  try {
    const old = await b.sync.pushIncremental(PROJECT_ID, SPACE_ID, []);
    await a.storage.writeMetaField(SPACE_ID, SPACE_DELETED_FIELD, "1");
    await b.sync.applyPush(
      PROJECT_ID,
      SPACE_ID,
      await a.sync.pushIncremental(PROJECT_ID, SPACE_ID, []),
    );
    expect(await isSpaceDeleted(b.storage, SPACE_ID)).toBe(true);
    await a.sync.applyPush(PROJECT_ID, SPACE_ID, old);
    expect(await isSpaceDeleted(a.storage, SPACE_ID)).toBe(true);
    await b.storage.writeMetaField(SPACE_ID, SPACE_DELETED_FIELD, "0");
    await a.sync.applyPush(
      PROJECT_ID,
      SPACE_ID,
      await b.sync.pushIncremental(PROJECT_ID, SPACE_ID, []),
    );
    expect(await isSpaceDeleted(a.storage, SPACE_ID)).toBe(false);
  } finally {
    a.storage.close();
    b.storage.close();
  }
});
