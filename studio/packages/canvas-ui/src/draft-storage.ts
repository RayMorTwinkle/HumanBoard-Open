/** A clean tab must never erase a recovery snapshot written by another tab. */
const keyFor = (layerId: string) => `humanboard:draft:${layerId}`;
export function createDraftStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  owner: string,
) {
  const observed = new Map<string, string>();
  return {
    read(layerId: string): string | null {
      const value = storage.getItem(keyFor(layerId));
      if (value === null) return null;
      if (!observed.has(layerId)) observed.set(layerId, value);
      const parsed = JSON.parse(value);
      return parsed.recovery_owner ? JSON.stringify(parsed.value) : value;
    },
    write(layerId: string, value: string): void {
      const next = JSON.stringify({
        recovery_owner: owner,
        value: JSON.parse(value),
      });
      storage.setItem(keyFor(layerId), next);
      observed.set(layerId, next);
    },
    remove(layerId: string): void {
      const key = keyFor(layerId),
        current = storage.getItem(key);
      // Only an explicit save/discard of the snapshot this tab observed can clear it.
      if (current !== null && current === observed.get(layerId))
        storage.removeItem(key);
      observed.delete(layerId);
    },
  };
}
let drafts: ReturnType<typeof createDraftStorage> | undefined;
const current = () =>
  (drafts ??= createDraftStorage(
    {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
    crypto.randomUUID(),
  ));
export const readDraft = (id: string) => current().read(id);
export const writeDraft = (id: string, value: string) =>
  current().write(id, value);
export const removeDraft = (id: string) => current().remove(id);
