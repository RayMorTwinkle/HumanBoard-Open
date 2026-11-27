import { describe, expect, test } from "bun:test";

import type { Scene } from "@humanboard/schema";

import { HumanBoardError } from "../src/domain/errors";
import type { ScenePatch } from "../src/domain/types";
import { ScenePatchService } from "../src/services/scene-patch-service";
import {
  TEST_AUTHOR,
  commitRoot,
  createFixture,
  createImageAsset,
  sceneWithAsset,
  sceneWithNode,
} from "./helpers";

function emptyScene(): Scene {
  return { nodes: [], edges: [], strokes: [], assets: [] };
}

function stroke(id: string, x = 1): Scene["strokes"][number] {
  return {
    id,
    tool: "pen",
    color: "#FF0000",
    width: 2,
    points: [
      [x, x],
      [x + 1, x + 1],
    ],
  };
}

async function expectPatchError(
  action: () => Promise<unknown>,
  code: HumanBoardError["code"] = "E_PATCH_INVALID",
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

describe("ScenePatchService nodes and edges", () => {
  test("partially updates nodes and edges while preserving unmentioned fields", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const base: Scene = {
      ...emptyScene(),
      nodes: [
        {
          id: "n1",
          kind: "state",
          title: "old",
          sub: "kept",
          rect: { x: 10, y: 20, w: 100, h: 50 },
        },
        {
          id: "n2",
          kind: "note",
          title: "remove",
          rect: { x: 200, y: 20, w: 100, h: 50 },
        },
      ],
      edges: [
        {
          id: "e1",
          from: { node_id: "n1", side: "right", offset: 0.5 },
          to: { node_id: "n2", side: "left", offset: 0.5 },
          label: "old",
        },
      ],
    };

    const result = await service.apply({
      baseScene: base,
      spaceId: fixture.space.id,
      patch: {
        upsert_nodes: [
          { id: "n1", title: "new" },
          {
            id: "n3",
            kind: "service",
            title: "added",
            rect: { x: 400, y: 20, w: 120, h: 60 },
          },
        ],
        remove_nodes: ["n2"],
        upsert_edges: [
          {
            id: "e1",
            to: { node_id: "n3", side: "left", offset: 0.5 },
            label: "new",
          },
          {
            id: "e2",
            from: { node_id: "n1", side: "bottom", offset: 0.5 },
            to: { node_id: "n3", side: "top", offset: 0.5 },
          },
        ],
      },
    });

    expect(result.scene.nodes).toHaveLength(2);
    expect(result.scene.nodes[0]).toMatchObject({
      id: "n1",
      title: "new",
      sub: "kept",
      rect: { x: 10, y: 20, w: 100, h: 50 },
    });
    expect(result.scene.edges[0]).toMatchObject({
      id: "e1",
      label: "new",
      to: { node_id: "n3", side: "left", offset: 0.5 },
    });
    expect(result.scene.edges[1]?.id).toBe("e2");
  });

  test("rejects unknown remove ids and missing required fields for new objects", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const base = sceneWithNode("n1");

    await expectPatchError(() =>
      service.apply({
        baseScene: base,
        spaceId: fixture.space.id,
        patch: { remove_nodes: ["missing"] },
      }),
    );

    await expectPatchError(() =>
      service.apply({
        baseScene: base,
        spaceId: fixture.space.id,
        patch: {
          upsert_nodes: [
            {
              id: "n2",
              title: "missing kind and rect",
            },
          ] as ScenePatch["upsert_nodes"],
        },
      }),
    );
  });

  test("rejects unknown patch fields and invalid final schema", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const base = sceneWithNode("n1");

    await expectPatchError(() =>
      service.apply({
        baseScene: base,
        spaceId: fixture.space.id,
        patch: { unknown_field: true } as unknown as ScenePatch,
      }),
    );

    await expectPatchError(() =>
      service.apply({
        baseScene: base,
        spaceId: fixture.space.id,
        patch: {
          upsert_nodes: [{ id: "n1", unknown_node_field: true }],
        } as unknown as ScenePatch,
      }),
    );

    await expectPatchError(() =>
      service.apply({
        baseScene: base,
        spaceId: fixture.space.id,
        patch: {
          upsert_edges: [
            {
              id: "bad-edge",
              from: { node_id: "n1", side: "right", offset: 2 },
              to: { node_id: "n1", side: "left", offset: 0.5 },
            },
          ],
        },
      }),
    );
  });
});

describe("ScenePatchService strokes", () => {
  test("adds, replaces by id, and removes strokes", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const base: Scene = {
      ...emptyScene(),
      strokes: [stroke("s1", 1), stroke("s2", 10)],
    };

    const result = await service.apply({
      baseScene: base,
      spaceId: fixture.space.id,
      patch: {
        add_strokes: [stroke("s1", 5), stroke("s3", 20)],
        remove_strokes: ["s2"],
      },
    });

    expect(result.scene.strokes.map((item) => item.id)).toEqual(["s1", "s3"]);
    expect(result.scene.strokes[0]?.points[0]).toEqual([5, 5]);
  });

  test("rejects removing an unknown stroke", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);

    await expectPatchError(() =>
      service.apply({
        baseScene: emptyScene(),
        spaceId: fixture.space.id,
        patch: { remove_strokes: ["missing"] },
      }),
    );
  });
});

describe("ScenePatchService assets", () => {
  test("updates existing refs and registers file/url sources", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const existing = await createImageAsset(fixture, fixture.space.id, "001");
    const base = sceneWithAsset(existing.asset_id, "001");

    const result = await service.apply({
      baseScene: base,
      spaceId: fixture.space.id,
      patch: {
        upsert_assets: [
          {
            asset_id: "#001",
            rect: { x: 20, y: 30, w: 400, h: 240 },
            z: 2,
          },
          {
            source: { kind: "file", path: "logs/error.png" },
            rect: { x: 500, y: 30, w: 320, h: 180 },
            z: 1,
          },
          {
            source: { kind: "url", url: "https://1.1.1.1/docs" },
            rect: { x: 900, y: 30, w: 300, h: 160 },
            z: 3,
          },
        ],
      },
    });

    expect(result.scene.assets).toHaveLength(3);
    expect(result.scene.assets[0]).toMatchObject({
      asset_id: existing.asset_id,
      display_no: "001",
      rect: { x: 20, y: 30, w: 400, h: 240 },
      z: 2,
    });
    expect(result.registered_assets.map((asset) => asset.display_no)).toEqual([
      "002",
      "003",
    ]);
    expect(result.registered_assets[0]?.type).toBe("image");
    expect(result.registered_assets[1]).toMatchObject({
      type: "url",
      source_url: "https://1.1.1.1/docs",
      title_source: "pending",
    });
  });

  test("rejects SSRF and malformed URLs before registering any Asset", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const blockedUrls = [
      "http://127.0.0.1/private",
      "http://192.0.2.7/private",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/private",
      "file:///etc/passwd",
      "not a url",
    ];

    for (const url of blockedUrls) {
      await expectPatchError(
        () =>
          service.apply({
            baseScene: emptyScene(),
            spaceId: fixture.space.id,
            patch: {
              upsert_assets: [
                {
                  source: { kind: "url", url },
                  rect: { x: 0, y: 0, w: 100, h: 100 },
                  z: 1,
                },
              ],
            },
          }),
        "E_URL_BLOCKED",
      );
    }

    expect(await fixture.storage.listAssets(fixture.space.id)).toEqual([]);
  });

  test("validates every URL source before creating the first Asset", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);

    await expectPatchError(
      () =>
        service.apply({
          baseScene: emptyScene(),
          spaceId: fixture.space.id,
          patch: {
            upsert_assets: [
              {
                source: { kind: "url", url: "https://1.1.1.1/first" },
                rect: { x: 0, y: 0, w: 100, h: 100 },
                z: 1,
              },
              {
                source: { kind: "url", url: "http://127.0.0.1/second" },
                rect: { x: 120, y: 0, w: 100, h: 100 },
                z: 2,
              },
            ],
          },
        }),
      "E_URL_BLOCKED",
    );

    expect(await fixture.storage.listAssets(fixture.space.id)).toEqual([]);
  });

  test("uses a best-effort URL title without changing pending title source", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService({
      storage: fixture.storage,
      clock: fixture.clock,
      ids: fixture.ids,
      resolveUrlTitle: async () => "  Example title  ",
    });

    const result = await service.apply({
      baseScene: emptyScene(),
      spaceId: fixture.space.id,
      patch: {
        upsert_assets: [
          {
            source: { kind: "url", url: "https://1.1.1.1/docs" },
            rect: { x: 0, y: 0, w: 100, h: 100 },
            z: 1,
          },
        ],
      },
    });

    expect(result.registered_assets[0]).toMatchObject({
      title: "Example title",
      title_source: "pending",
    });
  });

  test("does not persist a source Asset when the patched Scene is invalid", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);

    await expectPatchError(() =>
      service.apply({
        baseScene: emptyScene(),
        spaceId: fixture.space.id,
        patch: {
          upsert_edges: [
            {
              id: "bad-edge",
              from: { node_id: "n1", side: "right", offset: 2 },
              to: { node_id: "n1", side: "left", offset: 0.5 },
            },
          ],
          upsert_assets: [
            {
              source: { kind: "file", path: "unused.png" },
              rect: { x: 0, y: 0, w: 100, h: 100 },
              z: 1,
            },
          ],
        },
      }),
    );

    expect(await fixture.storage.listAssets(fixture.space.id)).toEqual([]);
  });

  test("supports add_assets alias and removal by short id", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const existing = await createImageAsset(fixture, fixture.space.id, "001");
    const base = sceneWithAsset(existing.asset_id, "001");

    const result = await service.apply({
      baseScene: base,
      spaceId: fixture.space.id,
      patch: {
        remove_assets: ["001"],
        add_assets: [
          {
            source: { kind: "file", path: "second.png" },
            rect: { x: 0, y: 0, w: 100, h: 100 },
            z: 1,
          },
        ],
      },
    });

    expect(result.scene.assets).toHaveLength(1);
    expect(result.scene.assets[0]?.display_no).toBe("002");
  });

  test("rejects display_no patches and unknown asset ids", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);

    await expectPatchError(() =>
      service.apply({
        baseScene: emptyScene(),
        spaceId: fixture.space.id,
        patch: {
          upsert_assets: [
            {
              asset_id: fixture.ids.next(),
              display_no: "001",
              rect: { x: 0, y: 0, w: 10, h: 10 },
              z: 1,
            },
          ],
        } as unknown as ScenePatch,
      }),
    );

    await expectPatchError(
      () =>
        service.apply({
          baseScene: emptyScene(),
          spaceId: fixture.space.id,
          patch: {
            remove_assets: ["999"],
          },
        }),
      "E_ASSET_NOT_FOUND",
    );
  });
});

describe("DraftService patch integration", () => {
  test("creates a derived draft from a patch and exposes registered assets", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture, "root", sceneWithNode("n1", "old"));

    const result = await fixture.service.createDraft({
      sessionId: "patch",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "derive",
      parentId: root.layerId,
      author: TEST_AUTHOR,
      patch: {
        upsert_nodes: [{ id: "n1", title: "patched" }],
        add_strokes: [stroke("s1")],
        upsert_assets: [
          {
            source: { kind: "url", url: "https://1.1.1.1/" },
            rect: { x: 0, y: 0, w: 300, h: 200 },
            z: 1,
          },
        ],
      },
    });

    expect(result.draft.scene.nodes[0]?.title).toBe("patched");
    expect(result.draft.scene.strokes).toHaveLength(1);
    expect(result.draft.scene.assets[0]?.display_no).toBe("001");
    expect(result.registered_assets).toHaveLength(1);
  });

  test("does not create an Asset or Draft when URL registration is blocked", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture, "blocked-root");

    await expectPatchError(
      () =>
        fixture.service.createDraft({
          sessionId: "blocked-url",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "derive",
          parentId: root.layerId,
          author: TEST_AUTHOR,
          patch: {
            upsert_assets: [
              {
                source: { kind: "url", url: "http://127.0.0.1/private" },
                rect: { x: 0, y: 0, w: 300, h: 200 },
                z: 1,
              },
            ],
          },
        }),
      "E_URL_BLOCKED",
    );

    expect(await fixture.storage.listAssets(fixture.space.id)).toEqual([]);
    expect(await fixture.storage.getDraftBySession("blocked-url")).toBeNull();
  });
});

describe("ScenePatchService defaults", () => {
  test("fills card size and edge anchors, and explains a bad edge", async () => {
    const fixture = await createFixture();
    const service = new ScenePatchService(fixture);
    const result = await service.apply({
      baseScene: emptyScene(),
      spaceId: fixture.space.id,
      patch: {
        upsert_nodes: [
          { id: "api", kind: "service", title: "API", rect: { x: 0, y: 0 } },
          { id: "db", kind: "database", title: "DB", rect: { x: 0, y: 300 } },
        ],
        upsert_edges: [{ id: "e", from: "api", to: "db" }],
      } as unknown as ScenePatch,
    });
    expect(result.scene.nodes[0]?.rect).toEqual({ x: 0, y: 0, w: 184, h: 68 });
    expect(result.scene.edges[0]).toEqual({
      id: "e",
      from: { node_id: "api", side: "bottom", offset: 0.5 },
      to: { node_id: "db", side: "top", offset: 0.5 },
    });

    try {
      await service.apply({
        baseScene: result.scene,
        spaceId: fixture.space.id,
        patch: {
          upsert_edges: [{ id: "x", from: "api", to: "nope" }],
        } as unknown as ScenePatch,
      });
      throw new Error("expected a patch error");
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardError);
      expect((error as HumanBoardError).message).toContain(
        "edges[1].to: unknown node nope",
      );
    }
  });
});
