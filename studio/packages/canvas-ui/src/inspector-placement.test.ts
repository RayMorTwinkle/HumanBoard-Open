import { expect, test } from "bun:test";
import { placeInspector } from "./inspector-placement";
test("expanded inspector avoids selected node instead of covering its resize handles", () => {
  const viewport = { x: 382, y: 80, w: 822, h: 728 },
    selection = { x: 549, y: 312, w: 132, h: 59 },
    size = { w: 300, h: 560 };
  const p = placeInspector(selection, viewport, size);
  expect(p.x).toBeGreaterThan(selection.x + selection.w);
  expect(p.y + size.h).toBeLessThanOrEqual(viewport.y + viewport.h);
  const rightNode = { ...selection, x: 1000 };
  const left = placeInspector(rightNode, viewport, size);
  expect(left.x + size.w).toBeLessThan(rightNode.x);
});
test("inspector remains reachable when the available area is too narrow for avoidance", () => {
  const p = placeInspector(
    { x: 50, y: 70, w: 180, h: 80 },
    { x: 0, y: 0, w: 280, h: 400 },
    { w: 250, h: 300 },
  );
  expect(p.x).toBeGreaterThanOrEqual(12);
  expect(p.y).toBeGreaterThanOrEqual(12);
  expect(p.x + 250).toBeLessThanOrEqual(280);
  expect(p.y + 300).toBeLessThanOrEqual(400);
});
