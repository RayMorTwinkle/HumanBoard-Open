import { expect, test } from "bun:test";

import {
  deleteLayerBranch,
  listVisibleLayers,
} from "../src/services/layer-visibility";
import {
  commitRoot,
  createFixture,
  sceneWithNode,
  TEST_AUTHOR,
  type Fixture,
} from "./helpers";

async function derive(fixture: Fixture, parentId: string, name: string) {
  const draft = await fixture.service.createDraft({
    sessionId: name,
    projectId: fixture.project.id,
    spaceId: fixture.space.id,
    kind: "derive",
    parentId,
    scene: sceneWithNode(name),
    author: TEST_AUTHOR,
  });
  return (
    await fixture.service.commitDraft({
      sessionId: name,
      draftId: draft.draft.id,
    })
  ).layer;
}

test("deleting a layer hides its whole branch and moves the view to its parent", async () => {
  const fixture = await createFixture();
  const root = await commitRoot(fixture);
  const a = await derive(fixture, root.layerId, "a");
  const b = await derive(fixture, a.id, "b");
  const sibling = await derive(fixture, root.layerId, "sibling");
  await fixture.storage.setSpaceActiveLayer(fixture.space.id, b.id);

  const result = await deleteLayerBranch(
    fixture.storage,
    fixture.space.id,
    a.id,
  );

  expect(result.deleted.sort()).toEqual([a.id, b.id].sort());
  expect(result.active_layer_id).toBe(root.layerId);
  const visible = await listVisibleLayers(fixture.storage, fixture.space.id);
  expect(visible.map((l) => l.id)).toEqual([root.layerId, sibling.id]);
  // The records stay for sync; only the history people see changes.
  expect(await fixture.storage.getLayer(b.id)).not.toBeNull();
  expect(
    (await fixture.storage.getSpace(fixture.space.id))!.active_layer_id,
  ).toBe(root.layerId);
});

test("the root layer and already deleted layers cannot be deleted", async () => {
  const fixture = await createFixture();
  const root = await commitRoot(fixture);
  const a = await derive(fixture, root.layerId, "a");
  await expect(
    deleteLayerBranch(fixture.storage, fixture.space.id, root.layerId),
  ).rejects.toMatchObject({ code: "E_USAGE" });
  await deleteLayerBranch(fixture.storage, fixture.space.id, a.id);
  await expect(
    deleteLayerBranch(fixture.storage, fixture.space.id, a.id),
  ).rejects.toMatchObject({ code: "E_LAYER_NOT_FOUND" });
});
