import { describe, expect, test } from "bun:test";

import { sceneContentHash } from "@humanboard/schema";

import { HumanBoardError } from "../src/domain/errors";
import { DRAFT_TTL_MS } from "../src/services/draft-service";
import {
  TEST_AUTHOR,
  commitRoot,
  createAdditionalSpace,
  createFixture,
  createImageAsset,
  sceneWithAsset,
  sceneWithNode,
} from "./helpers";

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

describe("DraftService layer kinds", () => {
  test("creates and commits a root layer", async () => {
    const fixture = await createFixture();
    const scene = sceneWithNode("n1", "root");
    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      scene,
      author: TEST_AUTHOR,
    });

    expect(created.overwritten).toBe(false);
    expect(created.draft).toMatchObject({
      parent_id: null,
      kind: "root",
      redo_of: null,
      status: "open",
    });

    const committed = await fixture.service.commitDraft({ sessionId: "s1" });
    expect(committed.layer).toMatchObject({
      seq: 1,
      parent_id: null,
      kind: "root",
      redo_of: null,
      title: "",
      title_source: "pending",
      schema_version: 1,
    });
    expect(committed.short_id).toBe("L1");
    expect(committed.layer.content_hash).toBe(
      sceneContentHash(scene) as `sha256:${string}`,
    );
    expect(Object.isFrozen(committed.layer)).toBe(true);
  });

  test("uses the active layer as the default derive parent", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture);
    await fixture.storage.setSpaceActiveLayer(fixture.space.id, root.layerId);

    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      scene: sceneWithNode("n2"),
      author: TEST_AUTHOR,
    });

    expect(created.draft).toMatchObject({
      kind: "derive",
      parent_id: root.layerId,
      redo_of: null,
    });
  });

  test("creates a transform layer from its parent", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture);
    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "transform",
      parentId: root.layerId,
      scene: sceneWithNode("n2"),
      author: TEST_AUTHOR,
    });

    expect(created.draft).toMatchObject({
      kind: "transform",
      parent_id: root.layerId,
      redo_of: null,
    });
  });

  test("redo points at the target's parent and records redo_of", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture);
    const deriveDraft = await fixture.service.createDraft({
      sessionId: "derive",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "derive",
      parentId: root.layerId,
      scene: sceneWithNode("n2"),
      author: TEST_AUTHOR,
    });
    const derive = await fixture.service.commitDraft({
      sessionId: "derive",
      draftId: deriveDraft.draft.id,
    });

    const redoDraft = await fixture.service.createDraft({
      sessionId: "redo",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "redo",
      parentId: derive.layer.id,
      scene: sceneWithNode("n3"),
      author: TEST_AUTHOR,
    });

    expect(redoDraft.draft).toMatchObject({
      kind: "redo",
      parent_id: root.layerId,
      redo_of: derive.layer.id,
    });
  });

  test("rejects redo of a root layer", async () => {
    const fixture = await createFixture();
    const root = await commitRoot(fixture);

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "redo",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "redo",
          parentId: root.layerId,
          author: TEST_AUTHOR,
        }),
      "E_REDO_INVALID",
    );
  });

  test("automatically creates root when the Space has no layers", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      scene: sceneWithNode("n1"),
      author: TEST_AUTHOR,
    });

    expect(created.draft.kind).toBe("root");
    expect(created.draft.parent_id).toBeNull();
  });
});

describe("DraftService draft lifecycle", () => {
  test("isolates drafts by session", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      scene: sceneWithNode("one"),
      author: TEST_AUTHOR,
    });
    const second = await fixture.service.createDraft({
      sessionId: "s2",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      scene: sceneWithNode("two"),
      author: TEST_AUTHOR,
    });

    expect(first.draft.id).not.toBe(second.draft.id);
    expect((await fixture.service.getDraft("s1")).scene.nodes[0]?.id).toBe("one");
    expect((await fixture.service.getDraft("s2")).scene.nodes[0]?.id).toBe("two");
  });

  test("overwrites the same draft id and refreshes TTL", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      scene: sceneWithNode("one"),
      author: TEST_AUTHOR,
    });
    fixture.clock.advance(5 * 60 * 1000);

    const second = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      scene: sceneWithNode("two"),
      author: TEST_AUTHOR,
    });

    expect(second.overwritten).toBe(true);
    expect(second.draft.id).toBe(first.draft.id);
    expect(second.draft.scene.nodes[0]?.id).toBe("two");
    expect(Date.parse(second.draft.expires_at) - Date.parse(first.draft.expires_at)).toBe(
      5 * 60 * 1000,
    );
    expect(
      Date.parse(second.draft.expires_at) - fixture.clock.now().getTime(),
    ).toBe(DRAFT_TTL_MS);
  });

  test("expires a draft after 30 minutes", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      author: TEST_AUTHOR,
    });
    fixture.clock.advance(DRAFT_TTL_MS);

    await expectError(
      () =>
        fixture.service.commitDraft({
          sessionId: "s1",
          draftId: created.draft.id,
        }),
      "E_DRAFT_EXPIRED",
    );
  });

  test("distinguishes an already consumed draft", async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      author: TEST_AUTHOR,
    });
    await fixture.service.commitDraft({
      sessionId: "s1",
      draftId: created.draft.id,
    });

    await expectError(
      () =>
        fixture.service.commitDraft({
          sessionId: "s1",
          draftId: created.draft.id,
        }),
      "E_DRAFT_CONSUMED",
    );
  });

  test("allows a new draft after a previous draft was consumed", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "root",
      author: TEST_AUTHOR,
    });
    const committed = await fixture.service.commitDraft({
      sessionId: "s1",
      draftId: first.draft.id,
    });

    const second = await fixture.service.createDraft({
      sessionId: "s1",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "derive",
      parentId: committed.layer.id,
      author: TEST_AUTHOR,
    });
    expect(second.draft.id).not.toBe(first.draft.id);
    expect(second.overwritten).toBe(false);
  });
});

describe("DraftService hashing and sequencing", () => {
  test("reuses content_hash for identical Scene content", async () => {
    const fixture = await createFixture();
    const otherSpace = await createAdditionalSpace(fixture, "hash-other");
    const scene = sceneWithNode("same");
    const first = await commitRoot(fixture, "first", scene);
    const secondDraft = await fixture.service.createDraft({
      sessionId: "second",
      projectId: fixture.project.id,
      spaceId: otherSpace.id,
      kind: "root",
      scene,
      author: TEST_AUTHOR,
    });
    const second = await fixture.service.commitDraft({
      sessionId: "second",
      draftId: secondDraft.draft.id,
    });
    const firstLayer = await fixture.storage.getLayer(first.layerId);
    const secondLayer = await fixture.storage.getLayer(second.layer.id);

    expect(firstLayer?.content_hash).toBe(secondLayer?.content_hash);
    expect(firstLayer?.content_hash).toBe(
      sceneContentHash(scene) as `sha256:${string}`,
    );
  });

  test("assigns unique per-Space seq values starting at 1", async () => {
    const fixture = await createFixture();
    const first = await commitRoot(fixture, "first");
    const secondDraft = await fixture.service.createDraft({
      sessionId: "second",
      projectId: fixture.project.id,
      spaceId: fixture.space.id,
      kind: "derive",
      parentId: first.layerId,
      author: TEST_AUTHOR,
    });
    const second = await fixture.service.commitDraft({
      sessionId: "second",
      draftId: secondDraft.draft.id,
    });
    const otherSpace = await createAdditionalSpace(fixture, "other");

    const otherDraft = await fixture.service.createDraft({
      sessionId: "other",
      projectId: fixture.project.id,
      spaceId: otherSpace.id,
      kind: "root",
      author: TEST_AUTHOR,
    });
    const otherLayer = await fixture.service.commitDraft({
      sessionId: "other",
      draftId: otherDraft.draft.id,
    });

    expect([first.seq, second.layer.seq]).toEqual([1, 2]);
    expect(otherLayer.layer.seq).toBe(1);
  });
});

describe("DraftService errors", () => {
  test("uses protocol error codes for missing scope and state", async () => {
    const fixture = await createFixture();

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "s1",
          projectId: fixture.ids.next(),
          spaceId: fixture.space.id,
          kind: "root",
          author: TEST_AUTHOR,
        }),
      "E_PROJECT_NOT_FOUND",
    );

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "s1",
          projectId: fixture.project.id,
          spaceId: fixture.ids.next(),
          kind: "root",
          author: TEST_AUTHOR,
        }),
      "E_SPACE_NOT_FOUND",
    );

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "s1",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "derive",
          author: TEST_AUTHOR,
        }),
      "E_NO_ACTIVE_VIEW",
    );

    await expectError(
      () =>
        fixture.service.commitDraft({
          sessionId: "missing",
        }),
      "E_NO_DRAFT",
    );
  });

  test("rejects an unknown parent layer", async () => {
    const fixture = await createFixture();
    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "s1",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "derive",
          parentId: fixture.ids.next(),
          author: TEST_AUTHOR,
        }),
      "E_LAYER_NOT_FOUND",
    );
  });

  test("rejects creating a second root in the same Space", async () => {
    const fixture = await createFixture();
    await commitRoot(fixture);

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "second-root",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "root",
          author: TEST_AUTHOR,
        }),
      "E_USAGE",
    );
  });

  test("rejects providing both scene and patch", async () => {
    const fixture = await createFixture();
    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "s1",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "root",
          scene: sceneWithNode("n1"),
          patch: {},
          author: TEST_AUTHOR,
        }),
      "E_USAGE",
    );
  });

  test("validates asset existence and display number consistency", async () => {
    const fixture = await createFixture();
    const missingAssetId = fixture.ids.next();

    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "missing-asset",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "root",
          scene: sceneWithAsset(missingAssetId, "001"),
          author: TEST_AUTHOR,
        }),
      "E_ASSET_NOT_FOUND",
    );

    const asset = await createImageAsset(fixture, fixture.space.id, "001");
    await expectError(
      () =>
        fixture.service.createDraft({
          sessionId: "wrong-display-no",
          projectId: fixture.project.id,
          spaceId: fixture.space.id,
          kind: "root",
          scene: sceneWithAsset(asset.asset_id, "002"),
          author: TEST_AUTHOR,
        }),
      "E_PATCH_INVALID",
    );
  });
});
