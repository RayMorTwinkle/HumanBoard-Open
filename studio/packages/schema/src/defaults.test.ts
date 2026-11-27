import { expect, test } from "bun:test";
import { SceneSchema } from "./schema";
import { describeSchemaIssues, resolveSceneDefaults } from "./index";

const card = (id: string, x: number, y: number) => ({
  id,
  kind: "service",
  title: id,
  rect: { x, y },
});

test("fills card size and facing anchors, then stores them explicitly", () => {
  const scene = resolveSceneDefaults({
    nodes: [card("a", 0, 0), card("b", 400, 0), card("c", 0, 300)],
    edges: [
      { id: "ab", from: "a", to: { node_id: "b" } },
      { id: "ac", from: "a", to: { node_id: "c", side: "right", offset: 0.2 } },
    ],
    strokes: [],
    assets: [],
  });
  const parsed = SceneSchema.parse(scene);
  expect(parsed.nodes[0]!.rect).toEqual({ x: 0, y: 0, w: 184, h: 68 });
  expect(parsed.edges[0]).toMatchObject({
    from: { node_id: "a", side: "right", offset: 0.5 },
    to: { node_id: "b", side: "left", offset: 0.5 },
  });
  // A pinned anchor is kept; only the missing end is chosen.
  expect(parsed.edges[1]).toMatchObject({
    from: { side: "bottom", offset: 0.5 },
    to: { side: "right", offset: 0.2 },
  });
});

test("describes schema problems one line each and names unknown endpoints", () => {
  const scene = resolveSceneDefaults({
    nodes: [{ ...card("a", 0, 0), rect: { y: 0, w: 10, h: 10 } }],
    edges: [{ id: "e", from: "a", to: "ghost" }],
    strokes: [],
    assets: [],
  });
  const result = SceneSchema.safeParse(scene);
  const lines = describeSchemaIssues(result.error, 8, scene);
  expect(lines[0]).toBe("edges[0].to: unknown node ghost");
  expect(lines).toContain("nodes[0].rect.x: required (number)");
  expect(lines.some((l) => l.includes("side"))).toBe(false);
});
