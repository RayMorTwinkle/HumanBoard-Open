import { describe, expect, test } from "bun:test";

import { countDiffBoxes } from "./diff";

describe("countDiffBoxes", () => {
  test("counts stroke and node boxes separately", () => {
    expect(
      countDiffBoxes([
        { id: "A", kind: "stroke" },
        { id: "B", kind: "stroke" },
        { id: "N1", kind: "node" },
      ]),
    ).toEqual({ stroke: 2, node: 1 });
  });
});
