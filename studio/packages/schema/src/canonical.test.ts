import { sceneContentHash } from "./hash";
import { describe, expect, test } from "bun:test";

import {
  CanonicalizationError,
  canonicalJson,
  canonicalSceneJson,
  canonicalizeScene,
  round2HalfAwayFromZero,
} from "./canonical";
import type { Scene, Stroke } from "./schema";

const TESTDATA = new URL("../testdata/", import.meta.url);
const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const goldenInput = (await Bun.file(
  new URL("scene.golden.input.json", TESTDATA),
).json()) as Scene;
const goldenCanonical = (
  await Bun.file(new URL("scene.golden.canonical.json", TESTDATA)).text()
).trimEnd();
const goldenHash = (
  await Bun.file(new URL("scene.golden.sha256", TESTDATA)).text()
).trim();

function sceneWithRect(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Scene {
  return {
    nodes: [
      {
        id: "n1",
        kind: "state",
        title: "节点",
        rect,
      },
    ],
    edges: [],
    strokes: [],
    assets: [],
  };
}

function stroke(id: string, points: [number, number][]): Stroke {
  return {
    id,
    tool: "pen",
    color: "#FF0000",
    width: 2,
    points,
  };
}

describe("PROTOCOL §5 golden vector", () => {
  test("canonicalizes the §5.3 sample byte-for-byte", () => {
    expect(canonicalSceneJson(goldenInput)).toBe(goldenCanonical);
    expect(canonicalSceneJson(goldenInput)).not.toMatch(/[\n\r\t]/);
    expect(canonicalSceneJson(goldenInput)).not.toContain('": ');
    expect(canonicalSceneJson(goldenInput)).not.toContain('", ');
  });

  test("reproduces the fixed sha256 content hash", () => {
    expect(goldenHash).toBe(sceneContentHash(goldenInput));
  });
});

describe("numeric normalization", () => {
  test("rounds halves away from zero, including negative values", () => {
    expect(round2HalfAwayFromZero(1.005)).toBe(1.01);
    expect(round2HalfAwayFromZero(-1.005)).toBe(-1.01);
    expect(round2HalfAwayFromZero(-1.235)).toBe(-1.24);
    expect(round2HalfAwayFromZero(-1.225)).toBe(-1.23);
    expect(round2HalfAwayFromZero(1.235)).toBe(1.24);

    const scene = sceneWithRect({ x: -1.235, y: -1.225, w: 1.235, h: 1.225 });
    expect(canonicalizeScene(scene).nodes[0]!.rect).toEqual({
      x: -1.24,
      y: -1.23,
      w: 1.24,
      h: 1.23,
    });
  });

  test("normalizes negative zero to zero", () => {
    const scene = sceneWithRect({ x: -0, y: 0, w: 10, h: 10 });
    expect(canonicalSceneJson(scene)).toContain('"x":0');
    expect(canonicalSceneJson(scene)).not.toContain("-0");
  });

  test("removes trailing zeros and never emits scientific notation", () => {
    expect(
      canonicalJson({
        trailing: 12.5,
        integer: 1e3,
        large: 1e21,
        tiny: 1e-7,
      }),
    ).toBe(
      '{"integer":1000,"large":1000000000000000000000,"tiny":0,"trailing":12.5}',
    );
  });

  test("rejects NaN and Infinity", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(
      CanonicalizationError,
    );
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(
      CanonicalizationError,
    );
    expect(() => round2HalfAwayFromZero(Number.NEGATIVE_INFINITY)).toThrow(
      CanonicalizationError,
    );
  });
});

describe("ordering", () => {
  test("sorts nodes and edges by id and assets by asset_id then z", () => {
    const scene: Scene = {
      nodes: [
        {
          id: "n2",
          kind: "note",
          title: "二",
          rect: { x: 0, y: 0, w: 1, h: 1 },
        },
        {
          id: "n1",
          kind: "note",
          title: "一",
          rect: { x: 0, y: 0, w: 1, h: 1 },
        },
      ],
      edges: [
        {
          id: "e2",
          from: { node_id: "n1", side: "right", offset: 0.5 },
          to: { node_id: "n2", side: "left", offset: 0.5 },
        },
        {
          id: "e1",
          from: { node_id: "n1", side: "bottom", offset: 0.5 },
          to: { node_id: "n2", side: "top", offset: 0.5 },
        },
      ],
      strokes: [],
      assets: [
        {
          asset_id: VALID_ULID,
          display_no: "002",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          z: 2,
        },
        {
          asset_id: VALID_ULID,
          display_no: "001",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          z: 1,
        },
      ],
    };

    const canonical = canonicalizeScene(scene);
    expect(canonical.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
    expect(canonical.edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);
    expect(canonical.assets.map((asset) => asset.display_no)).toEqual([
      "001",
      "002",
    ]);
  });

  test("preserves stroke order and point order", () => {
    const scene = sceneWithRect({ x: 0, y: 0, w: 10, h: 10 });
    scene.strokes = [
      stroke("s2", [
        [2, 2],
        [3, 3],
      ]),
      stroke("s1", [
        [1, 1],
        [0, 0],
      ]),
    ];

    const canonical = canonicalizeScene(scene);
    expect(canonical.strokes.map((item) => item.id)).toEqual(["s2", "s1"]);
    expect(canonical.strokes[0]!.points).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  test("sorts object keys recursively by Unicode code point", () => {
    expect(
      canonicalJson({
        "\u{10000}": 2,
        nested: { z: 1, a: 2 },
        "\uE000": 1,
        a: 3,
      }),
    ).toBe('{"a":3,"nested":{"a":2,"z":1},"\uE000":1,"\u{10000}":2}');
  });

  test("treats __proto__ as an ordinary data key", () => {
    const value = JSON.parse('{"__proto__":1,"safe":2}') as unknown;
    expect(canonicalJson(value)).toBe('{"__proto__":1,"safe":2}');
  });
});

describe("string normalization", () => {
  test("normalizes strings and keys to Unicode NFC", () => {
    const decomposed = "e\u0301";
    const composed = "\u00E9";

    expect(canonicalJson({ [decomposed]: decomposed })).toBe(
      `{"${composed}":"${composed}"}`,
    );
  });
});
