import { expect, test } from "bun:test";
import {
  createFixture,
  createAdditionalSpace,
  commitRoot,
  sceneWithNode,
  TEST_AUTHOR,
} from "./helpers";
import {
  isSpaceDeleted,
  visibleSpaces,
  SPACE_DELETED_FIELD,
} from "../src/services/space-visibility";

test("space tombstones survive stale peer metadata, and explicit restore propagates", async () => {
  const a = await createFixture(),
    b = await createFixture();
  const stale = await b.storage.writeMetaField(
    b.space.id,
    SPACE_DELETED_FIELD,
    "0",
  );
  await a.storage.mergeMetaFields(a.space.id, [stale]);
  const deletion = await a.storage.writeMetaField(
    a.space.id,
    SPACE_DELETED_FIELD,
    "1",
  );
  await b.storage.mergeMetaFields(b.space.id, [deletion]);
  await a.storage.mergeMetaFields(a.space.id, [stale]);
  expect(await isSpaceDeleted(a.storage, a.space.id)).toBe(true);
  expect(await visibleSpaces(b.storage, b.project.id)).toHaveLength(0);
  const restore = await b.storage.writeMetaField(
    b.space.id,
    SPACE_DELETED_FIELD,
    "0",
  );
  await a.storage.mergeMetaFields(a.space.id, [restore]);
  expect(await visibleSpaces(a.storage, a.project.id)).toHaveLength(1);
});

test("deleting a space rejects both new drafts and an existing draft's commit without deleting layers", async () => {
  const f = await createFixture();
  const root = await commitRoot(f);
  const request = {
    sessionId: "pending",
    projectId: f.project.id,
    spaceId: f.space.id,
    kind: "derive" as const,
    parentId: root.layerId,
    scene: sceneWithNode("next"),
    author: TEST_AUTHOR,
  };
  const draft = await f.service.createDraft(request);
  await f.storage.writeMetaField(f.space.id, SPACE_DELETED_FIELD, "1");
  await expect(
    f.service.createDraft({ ...request, sessionId: "another" }),
  ).rejects.toMatchObject({ code: "E_SPACE_DELETED" });
  await expect(
    f.service.commitDraft({ sessionId: "pending", draftId: draft.draft.id }),
  ).rejects.toMatchObject({ code: "E_SPACE_DELETED" });
  expect(await f.storage.getLayer(root.layerId)).not.toBeNull();
  await f.storage.writeMetaField(f.space.id, SPACE_DELETED_FIELD, "0");
  expect(
    (
      await f.service.commitDraft({
        sessionId: "pending",
        draftId: draft.draft.id,
      })
    ).layer.parent_id,
  ).toBe(root.layerId);
});
