import { expect, test } from "bun:test";
import { buildLayerTimeline, timelineEdges } from "./layer-timeline";
const layer = (
  id: string,
  seq: number,
  parent_id: string | null,
  redo_of: string | null = null,
) => ({ id, seq, parent_id, redo_of });
test("timeline uses real parent edges across interleaved commits and preserves branches", () => {
  const input = [
    layer("a", 1, null),
    layer("b", 2, "a"),
    layer("c", 3, "a"),
    layer("d", 4, "b"),
    layer("e", 5, "c"),
    layer("f", 6, "d"),
  ];
  const graph = buildLayerTimeline(input);
  expect(graph.laneCount).toBe(2);
  expect(graph.byId.get("a")!.lane).toBe(graph.byId.get("f")!.lane);
  expect(graph.byId.get("c")!.lane).toBe(graph.byId.get("e")!.lane);
  expect(graph.byId.get("b")!.lane).not.toBe(graph.byId.get("c")!.lane);
  const links = timelineEdges(graph, [30, 110, 190, 270, 350, 430]);
  expect(links.map((e) => [e.from, e.to])).toEqual([
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "e"],
    ["d", "f"],
  ]);
  expect(links.find((e) => e.to === "d")!.d).toBe("M 18 110 L 18 270");
  expect(buildLayerTimeline([...input].reverse()).nodes).toEqual(graph.nodes);
});
test("timeline reuses finished lanes, distinguishes redo and marks missing parents", () => {
  const graph = buildLayerTimeline([
    layer("a", 1, null),
    layer("b", 2, "a"),
    layer("c", 3, "a"),
    layer("d", 4, "c"),
    layer("e", 5, "c", "d"),
    layer("omitted", 6, "missing"),
  ]);
  expect(graph.laneCount).toBe(2);
  expect(graph.byId.get("e")!.lane).toBe(graph.byId.get("a")!.lane);
  expect(graph.byId.get("omitted")!.missingParent).toBe(true);
  const links = timelineEdges(graph, []);
  expect(links.find((e) => e.to === "e" && e.kind === "parent")!.from).toBe(
    "c",
  );
  expect(links.find((e) => e.to === "e" && e.kind === "redo")!.from).toBe("d");
  expect(links.some((e) => e.from === "missing")).toBe(false);
});
test("timeline handles empty, cyclic input and a long linear history without recursive overflow", () => {
  expect(buildLayerTimeline([]).nodes).toEqual([]);
  expect(
    buildLayerTimeline([layer("a", 1, "b"), layer("b", 2, "a")]).nodes,
  ).toHaveLength(2);
  const input = Array.from({ length: 12000 }, (_, i) =>
    layer(String(i), i, i ? String(i - 1) : null),
  );
  const graph = buildLayerTimeline(input);
  expect(graph.laneCount).toBe(1);
  expect(graph.nodes).toHaveLength(12000);
});
