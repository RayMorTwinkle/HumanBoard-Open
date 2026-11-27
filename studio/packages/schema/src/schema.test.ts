import { describe, expect, test } from "bun:test";

import { SceneSchema } from "./schema";
import type { Scene } from "./schema";

const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function validScene(): Scene {
  return {
    nodes: [
      {
        id: "n1",
        kind: "state",
        title: "待支付",
        rect: { x: 390, y: 150, w: 186, h: 76 },
      },
    ],
    edges: [
      {
        id: "e1",
        from: { node_id: "n1", side: "right", offset: 0.5 },
        to: { node_id: "n2", side: "left", offset: 0.5 },
      },
    ],
    strokes: [
      {
        id: "s1",
        tool: "pen",
        color: "#FF5B47",
        width: 3.2,
        points: [
          [582, 398],
          [600, 392],
        ],
      },
    ],
    assets: [
      {
        asset_id: VALID_ULID,
        display_no: "001",
        rect: { x: 390, y: 600, w: 330, h: 190 },
        z: 1,
      },
    ],
  };
}

describe("SceneSchema", () => {
  test("accepts a valid Scene", () => {
    expect(SceneSchema.parse(validScene())).toEqual(validScene());
  });

  test("maps an unknown NodeKind to unknown without failing the Scene", () => {
    const scene = validScene() as unknown as Record<string, unknown>;
    scene.nodes = [
      {
        id: "n1",
        kind: "future-node-kind",
        title: "未来节点",
        rect: { x: 0, y: 0, w: 100, h: 50 },
      },
    ];

    const parsed = SceneSchema.parse(scene);
    expect(parsed.nodes[0]?.kind).toBe("unknown");
  });

  test("still requires the NodeKind field", () => {
    const scene = validScene() as unknown as Record<string, unknown>;
    scene.nodes = [
      {
        id: "n1",
        title: "缺少 kind",
        rect: { x: 0, y: 0, w: 100, h: 50 },
      },
    ];

    expect(() => SceneSchema.parse(scene)).toThrow();
  });

  test("rejects NaN and Infinity", () => {
    const nanScene = validScene();
    nanScene.nodes[0]!.rect.x = Number.NaN;
    expect(() => SceneSchema.parse(nanScene)).toThrow();

    const infiniteScene = validScene();
    infiniteScene.strokes[0]!.width = Number.POSITIVE_INFINITY;
    expect(() => SceneSchema.parse(infiniteScene)).toThrow();
  });

  test("enforces anchor offset bounds and ULID asset ids", () => {
    const invalidOffset = validScene();
    invalidOffset.edges[0]!.from.offset = 1.1;
    expect(() => SceneSchema.parse(invalidOffset)).toThrow();

    const invalidUlid = validScene();
    invalidUlid.assets[0]!.asset_id = "01J...";
    expect(() => SceneSchema.parse(invalidUlid)).toThrow();
  });
});
