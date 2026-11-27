import { expect, test } from "bun:test";
import { withPaperGrid } from "./paper-grid";
test("grid uses paper world coordinates and precedes the diagram", () => {
 const svg = withPaperGrid('<svg viewBox="-48 -48 1120 736"><g id="nodes"/></svg>',{x:-48,y:-48,w:1120,h:736},false);
 expect(svg).toContain('patternUnits="userSpaceOnUse"');
 expect(svg).toContain('x="-48" y="-48" width="1120" height="736"');
 expect(svg.indexOf('data-ui-grid')).toBeLessThan(svg.indexOf('id="nodes"'));
 expect(svg).not.toContain('background-size');
});
