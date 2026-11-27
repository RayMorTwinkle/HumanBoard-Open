import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LayersPanel } from "./LayersPanel";

describe("LayersPanel", () => {
  test("renders layer metadata, active state, and diff entry", () => {
    const markup = renderToStaticMarkup(
      <LayersPanel
        layers={[
          {
            id: "layer-1",
            space_id: "space-1",
            seq: 1,
            short_id: "L1",
            title: "手绘退款流程",
            title_source: "agent",
            kind: "root",
            parent_id: null,
            redo_of: null,
            created_at: "2026-10-22T08:00:00Z",
            author: { kind: "human" },
            schema_version: 1,
          },
        ]}
        activeLayerId="layer-1"
        onSelect={() => {}}
        onDiff={() => {}}
      />,
    );
    expect(markup).toContain("Layers");
    expect(markup).toContain("L1");
    expect(markup).toContain("手绘退款流程");
    expect(markup).toContain("正在看");
    expect(markup).toContain("查看 L1 的 Diff");
    expect(markup).toContain("人类编辑");
    expect(markup).not.toContain("加载 3-PNG");
  });
  test("marks layers saved elsewhere until they are viewed", () => {
    const layer = (n: number, parent: string | null) => ({
      id: `layer-${n}`,
      space_id: "space-1",
      seq: n,
      short_id: `L${n}`,
      title: `第 ${n} 层`,
      title_source: "agent" as const,
      kind: parent ? ("derive" as const) : ("root" as const),
      parent_id: parent,
      redo_of: null,
      created_at: "2026-10-30T08:00:00Z",
      author: { kind: n === 1 ? "human" : "cli" },
      schema_version: 1,
    });
    const markup = renderToStaticMarkup(
      <LayersPanel
        layers={[layer(1, null), layer(2, "layer-1")]}
        activeLayerId="layer-1"
        freshLayerIds={new Set(["layer-2"])}
        onSelect={() => {}}
        onDiff={() => {}}
      />,
    );
    expect(markup.match(/layer-row[^"]*is-fresh/g)).toHaveLength(1);
    expect(markup).toContain('<span class="fresh-tag">新</span>');
  });
});
