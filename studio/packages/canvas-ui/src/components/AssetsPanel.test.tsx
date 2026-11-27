import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { InspectImageData } from "../client/types";
import { AssetsPanel } from "./AssetsPanel";

const INSPECT: InspectImageData = {
  asset: {
    asset_id: "asset-1",
    display_no: "001",
    type: "image",
    title: "终端报错截图",
    source: { kind: "upload", width: 1600, height: 900 },
  },
  layer: { id: "layer-1", short_id: "L1", seq: 1 },
  content: {
    url: "file:///example/workspace/.humanboard/cache/inspect/asset-001.png",
    width: 1600,
    height: 900,
    overlaid_strokes: ["s1", "s2"],
  },
  warnings: [],
};

describe("AssetsPanel", () => {
  test("renders the composited inspect image and manifest", () => {
    const markup = renderToStaticMarkup(
      <AssetsPanel
        assets={[
          {
            asset_id: "asset-1",
            display_no: "001",
            type: "image",
            title: "终端报错截图",
            title_source: "human",
            source_url: null,
            blob_hash: "sha256:abc",
            rect: { x: 390, y: 600, w: 330, h: 190 },
            z: 1,
          },
        ]}
        activeLayerShortId="L1"
        inspect={INSPECT}
        onInspect={() => {}}
        onClearInspect={() => {}}
      />,
    );

    expect(markup).toContain('src="/inspect/asset-001.png"');
    expect(markup).toContain("合成笔迹 2 条");
    expect(markup).toContain("L1 Asset Manifest");
    expect(markup).toContain("#001 IMAGE");
  });
});
