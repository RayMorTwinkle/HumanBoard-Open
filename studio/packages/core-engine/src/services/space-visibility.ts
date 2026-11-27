import type { StorageAdapter } from "../storage/storage-adapter";
export const SPACE_DELETED_FIELD = "space.deleted";
export async function isSpaceDeleted(
  storage: StorageAdapter,
  id: string,
): Promise<boolean> {
  return (await storage.getMetaField(id, SPACE_DELETED_FIELD))?.value === "1";
}
export async function visibleSpaces(
  storage: StorageAdapter,
  projectId: string,
) {
  const all = await storage.listSpaces(projectId);
  const flags = await Promise.all(
    all.map((s) => isSpaceDeleted(storage, s.id)),
  );
  return all.filter((_, i) => !flags[i]);
}
