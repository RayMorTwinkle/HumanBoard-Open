import { expect, test } from "bun:test";
import { createDraftStorage } from "./draft-storage";
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}
test("second tab cannot remove a newer first-tab recovery snapshot", () => {
  const local = storage(),
    first = createDraftStorage(local, "first"),
    second = createDraftStorage(local, "second");
  first.write("L1", '{"scene":"old"}');
  second.read("L1");
  first.write("L1", '{"scene":"new"}');
  second.remove("L1");
  expect(first.read("L1")).toBe('{"scene":"new"}');
  const reopened = createDraftStorage(local, "reopened");
  expect(reopened.read("L1")).toBe('{"scene":"new"}');
  reopened.remove("L1");
  expect(first.read("L1")).toBeNull();
});
test("unrelated tab cannot remove draft and legacy format remains recoverable", () => {
  const local = storage(),
    first = createDraftStorage(local, "first"),
    second = createDraftStorage(local, "second");
  local.setItem("humanboard:draft:L1", '{"scene":"legacy"}');
  second.remove("L1");
  expect(first.read("L1")).toBe('{"scene":"legacy"}');
  first.write("L1", '{"scene":"updated"}');
  second.remove("L1");
  expect(first.read("L1")).toBe('{"scene":"updated"}');
  first.remove("L1");
  expect(first.read("L1")).toBeNull();
});
test("metadata reads do not claim another tab's newer dirty snapshot", () => {
  const local = storage(),
    first = createDraftStorage(local, "first"),
    second = createDraftStorage(local, "second");
  first.write("L1", '{"scene":"first"}');
  second.write("L1", '{"scene":"second"}');
  first.read("L1");
  first.remove("L1");
  expect(second.read("L1")).toBe('{"scene":"second"}');
});
