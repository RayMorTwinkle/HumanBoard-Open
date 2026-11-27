import { expect, test } from "bun:test";
import { submitAgentMessage } from "./agent-composer";
const ready = { configured: true, pending: false, editingLocked: false };
test("save/upload lock does not dispatch or accept clearing composer", async () => {
  let calls = 0;
  expect(
    await submitAgentMessage("draft", { ...ready, editingLocked: true }, () => {
      calls++;
    }),
  ).toBe(false);
  expect(calls).toBe(0);
});
test("late controller lock rejection preserves composer and accepted send clears", async () => {
  expect(await submitAgentMessage("draft", ready, () => false)).toBe(false);
  expect(await submitAgentMessage("draft", ready, async () => true)).toBe(true);
});
