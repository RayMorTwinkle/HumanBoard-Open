import { expect, test } from "bun:test";
import { sceneContentHash } from "@humanboard/schema";
import { browserSceneHash } from "./scene-hash";
test("browser snapshot hashes agree with server canonical hashing", async () => {
  const scene = {
    nodes: [
      {
        id: "n",
        kind: "note" as const,
        title: "e\u0301",
        rect: { x: -1.005, y: 0, w: 160, h: 80 },
      },
    ],
    edges: [],
    strokes: [],
    assets: [],
  };
  expect(await browserSceneHash(scene)).toBe(sceneContentHash(scene));
});
