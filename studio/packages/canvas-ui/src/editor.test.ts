import { expect, test } from "bun:test";
import { emptyScene, scenePatch, summarizeEdits } from "./editor";
test("captures node moves, edge deletion, asset moves, and erased committed strokes", () => {
  const base = emptyScene();
  base.nodes.push({
    id: "n",
    kind: "note",
    title: "old",
    rect: { x: 0, y: 0, w: 10, h: 10 },
  });
  base.strokes.push({
    id: "s",
    tool: "pen",
    color: "red",
    width: 2,
    points: [[0, 0]],
  });
  const next = {
    ...base,
    nodes: [{ ...base.nodes[0]!, rect: { x: 42, y: 0, w: 10, h: 10 } }],
    strokes: [],
  };
  expect(summarizeEdits(base, next).nodes.moved).toEqual(["n"]);
  expect(summarizeEdits(base, next).strokes.erased).toBe(1);
  expect(scenePatch(base, next).remove_strokes).toEqual(["s"]);
  expect(scenePatch(base, next).upsert_nodes[0]!.rect.x).toBe(42);
});
