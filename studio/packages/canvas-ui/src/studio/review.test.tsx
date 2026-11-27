import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Node, Scene } from "@humanboard/schema/scene";
import type { Review } from "../../../core-engine/src/revisions/service";
import { GraphCanvas } from "./GraphCanvas";
import { extent, fit, zoomAt } from "./camera";

const card = (id: string): Node => ({
  id,
  kind: "note",
  title: id,
  rect: { x: 0, y: 0, w: 180, h: 90 },
});
test("review shows added, modified and removed cards without mutating either snapshot", () => {
  const a = card("added"),
    b = card("changed"),
    c = card("deleted");
  const scene: Scene = { nodes: [b, c], edges: [], strokes: [], assets: [] };
  const preview = { ...scene, nodes: [a, { ...b, title: "updated" }] };
  const review: Review = {
    base: "root",
    head: "head",
    source: "proposal",
    alreadyMerged: false,
    comparedTo: "head",
    preview,
    conflicts: [],
    changes: [
      {
        entity: "节点",
        id: a.id,
        label: a.title,
        kind: "added",
        before: null,
        after: a,
      },
      {
        entity: "节点",
        id: b.id,
        label: b.title,
        kind: "modified",
        before: b,
        after: preview.nodes[1]!,
      },
      {
        entity: "节点",
        id: c.id,
        label: c.title,
        kind: "removed",
        before: c,
        after: null,
      },
    ],
  };
  const html = renderToStaticMarkup(
    <GraphCanvas
      scene={scene}
      review={review}
      fitKey={0}
      selected={null}
      onMove={() => {}}
      onSelect={() => {}}
      connecting={false}
      locked
    />,
  );
  for (const change of review.changes)
    expect(html).toContain(
      `data-node="${change.id}" data-kind="${change.kind}"`,
    );
  expect(scene.nodes).toEqual([b, c]);
  expect(preview.nodes).toHaveLength(2);
});

test("fit leaves space for floating controls and zoom keeps the pointer's world position fixed", () => {
  const scene: Scene = {
    nodes: [card("a")],
    edges: [],
    strokes: [],
    assets: [],
  };
  const bounds = extent(scene),
    cam = fit(bounds, 390, 420);
  expect(cam.y + cam.k * bounds.y).toBeGreaterThanOrEqual(68);
  expect(cam.y + cam.k * (bounds.y + bounds.h)).toBeLessThanOrEqual(320);
  const point = { x: 140, y: 170 },
    zoom = zoomAt(cam, point, 1.5);
  expect((point.x - zoom.x) / zoom.k).toBeCloseTo((point.x - cam.x) / cam.k);
  expect((point.y - zoom.y) / zoom.k).toBeCloseTo((point.y - cam.y) / cam.k);
});
