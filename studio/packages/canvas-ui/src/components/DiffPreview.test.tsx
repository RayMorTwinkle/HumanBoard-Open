import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffPreview } from "./DiffPreview";

test("pure structured diff offers visual comparison as an option", () => {
  const markup = renderToStaticMarkup(
    <DiffPreview
      diff={{
        mode: "ast",
        summary: "说明修改",
        base: { id: "a", short_id: "L2", seq: 2 },
        target: { id: "b", short_id: "L3", seq: 3 },
        warnings: [],
        ast: {
          nodes: {
            added: [],
            removed: [],
            moved: [],
            resized: [],
            updated: [{ id: "a", fields: ["sub"] }],
          },
          edges: { added: [], removed: [], updated: [] },
          assets: { added: [], removed: [], updated: [] },
        },
      }}
      mode="highlight"
      boxes={{ stroke: 0, node: 0 }}
      onMode={() => {}}
      onClose={() => {}}
      objectNames={{ a: "版本引擎" }}
    />,
  );
  expect(markup).not.toContain("变更前");
  expect(markup).not.toContain("高亮变化");
  expect(markup).toContain("视觉对比");
  expect(markup).toContain("版本引擎");
  expect(markup).toContain("说明");
});

test("the floating diff preview offers three images and box counts, no clear button", () => {
  const markup = renderToStaticMarkup(
    <DiffPreview
      diff={{
        mode: "mixed",
        summary: "新增失败分支批注",
        base: { id: "layer-1", short_id: "L1", seq: 1 },
        target: { id: "layer-2", short_id: "L2", seq: 2 },
        visual: {
          coordinate_space: "union",
          bounds: { x: 0, y: 0, w: 1024, h: 640 },
          background_opacity: 0.28,
          before: {
            url: "/before.png",
            bounds: { x: 0, y: 0, w: 1024, h: 640 },
          },
          after: {
            url: "/after.png",
            bounds: { x: 0, y: 0, w: 1024, h: 640 },
          },
          highlight: {
            url: "/highlight.png",
            bounds: { x: 0, y: 0, w: 1024, h: 640 },
          },
          boxes: [
            { id: "A", kind: "stroke" },
            { id: "N1", kind: "node" },
          ],
        },
        warnings: [],
      }}
      mode="before"
      boxes={{ stroke: 1, node: 1 }}
      onMode={() => {}}
      onClose={() => {}}
    />,
  );
  for (const label of ["变更前", "变更后", "高亮变化", "红框 1", "紫框 1"])
    expect(markup).toContain(label);
  expect(markup).toContain("L1 → L2");
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).not.toContain("清除");
});
