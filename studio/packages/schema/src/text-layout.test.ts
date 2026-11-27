import { expect, test } from "bun:test";
import { wrapText } from "./text-layout";

test("mixed text wraps at English word boundaries and preserves explicit lines", () => {
  expect(wrapText("外部 Coding Agent", 110, 14, 10)).toEqual([
    "外部 Coding",
    "Agent",
  ]);
  expect(wrapText("第一行\n第二行", 220, 12, 10)).toEqual(["第一行", "第二行"]);
  expect(wrapText("abcdefghijklmnopqrst", 40, 14, 10).join("")).toBe(
    "abcdefghijklmnopqrst",
  );
});
