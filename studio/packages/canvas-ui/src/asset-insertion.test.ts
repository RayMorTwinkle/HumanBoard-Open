import { afterEach, expect, test } from "bun:test";
import { insertBoardAsset } from "./asset-insertion";
import { HumanBoardClient } from "./client/HumanBoardClient";
import { useBoardStore } from "./store/useBoardStore";
const initial = useBoardStore.getState();
afterEach(() => useBoardStore.setState(initial, true));
const asset = {
  asset_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  display_no: "001",
  type: "url",
  title: "参考指南",
  description: "需要保留的网页摘要",
  source_url: "https://example.test/docs",
  blob_hash: null,
  title_source: "builtin",
  width: 300,
  height: 180,
};
function board() {
  useBoardStore.setState({
    ...initial,
    status: {
      project: { id: "p", name: "Project", root: null },
      space: { id: "s", name: "Space" },
      active_layer: null,
      layers: [],
      layers_truncated: false,
      total_layers: 0,
      spaces: [],
      warnings: [],
    },
    workingScene: {
      nodes: [
        {
          id: "human",
          kind: "note",
          title: "原有未保存内容",
          rect: { x: 100, y: 100, w: 160, h: 80 },
        },
      ],
      edges: [],
      strokes: [],
      assets: [],
    },
  });
}
test("drop insertion uses the shared upload path and preserves dirty content and URL metadata", async () => {
  board();
  const client = new HumanBoardClient({
    fetchImpl: async (_url, init) => {
      expect(useBoardStore.getState().editingLocked).toBe(true);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        project_id: "p",
        space_id: "s",
        url: "https://example.test/docs",
      });
      return Response.json(asset);
    },
  });
  await insertBoardAsset({ url: asset.source_url, at: [600, 300] }, client);
  const state = useBoardStore.getState();
  expect(state.workingScene!.nodes[0]!.id).toBe("human");
  expect(state.workingScene!.assets[0]!.rect).toEqual({
    x: 450,
    y: 210,
    w: 300,
    h: 180,
  });
  expect(state.editingLocked).toBe(false);
  expect(state.dirty).toBe(true);
  expect(state.registeredAssets[0]!.description).toBe(asset.description);
  expect(state.selectedNodeId).toBe(`asset:${asset.asset_id}`);
});
test("failed asset registration unlocks editing without changing the current Scene", async () => {
  board();
  const before = useBoardStore.getState().workingScene;
  const client = new HumanBoardClient({
    fetchImpl: async () =>
      Response.json(
        { error: { code: "E_CONNECT", message: "upload failed" } },
        { status: 503 },
      ),
  });
  await expect(
    insertBoardAsset({ url: asset.source_url }, client),
  ).rejects.toThrow("upload failed");
  expect(useBoardStore.getState().editingLocked).toBe(false);
  expect(useBoardStore.getState().workingScene).toBe(before);
});
