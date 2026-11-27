import { HumanBoardError } from "../domain/errors";
import type { Layer, ULID } from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";

/**
 * Layers are append-only and synced by id, so a human "delete" is a tombstone in the
 * Space's meta registers: synced last-writer-wins, never resurrected by a peer's push.
 */
const PREFIX = "layer.";
const SUFFIX = ".deleted";
export const layerDeletedField = (layerId: ULID) =>
  `${PREFIX}${layerId}${SUFFIX}`;

export async function deletedLayerIds(
  storage: StorageAdapter,
  spaceId: ULID,
): Promise<Set<string>> {
  return new Set(
    (await storage.listMetaFields(spaceId))
      .filter(
        (f) =>
          f.value === "1" &&
          f.field.startsWith(PREFIX) &&
          f.field.endsWith(SUFFIX),
      )
      .map((f) => f.field.slice(PREFIX.length, -SUFFIX.length)),
  );
}

/** The history people and agents see: every Layer not deleted by a human. */
export async function listVisibleLayers(
  storage: StorageAdapter,
  spaceId: ULID,
): Promise<Layer[]> {
  const [layers, deleted] = await Promise.all([
    storage.listLayers(spaceId),
    deletedLayerIds(storage, spaceId),
  ]);
  return deleted.size ? layers.filter((l) => !deleted.has(l.id)) : layers;
}

/**
 * Deletes a Layer together with everything built on it. Root Layers stay: they are
 * the Space's origin. If the view was inside the removed branch it returns to the parent.
 */
export async function deleteLayerBranch(
  storage: StorageAdapter,
  spaceId: ULID,
  layerId: ULID,
): Promise<{ deleted: ULID[]; active_layer_id: ULID | null }> {
  const space = await storage.getSpace(spaceId);
  if (!space)
    throw new HumanBoardError(
      "E_SPACE_NOT_FOUND",
      `Space ${spaceId} does not exist`,
      { space_id: spaceId },
    );
  const layers = await listVisibleLayers(storage, spaceId);
  const target = layers.find((l) => l.id === layerId);
  if (!target)
    throw new HumanBoardError(
      "E_LAYER_NOT_FOUND",
      `Layer ${layerId} does not exist in Space ${spaceId}`,
      { layer_id: layerId, space_id: spaceId },
    );
  if (target.parent_id === null)
    throw new HumanBoardError("E_USAGE", "Root Layer cannot be deleted", {
      layer_id: layerId,
    });
  const branch = new Set([layerId]);
  // seq order puts every parent before its children.
  for (const layer of [...layers].sort((a, b) => a.seq - b.seq))
    if (layer.parent_id && branch.has(layer.parent_id)) branch.add(layer.id);
  for (const id of branch)
    await storage.writeMetaField(spaceId, layerDeletedField(id), "1");
  let active = space.active_layer_id;
  if (active === null || branch.has(active)) {
    active = target.parent_id;
    await storage.setSpaceActiveLayer(spaceId, active);
  }
  return { deleted: [...branch], active_layer_id: active };
}
