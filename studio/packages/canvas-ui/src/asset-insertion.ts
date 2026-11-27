import { HumanBoardClient } from "./client/HumanBoardClient";
import { useBoardStore } from "./store/useBoardStore";
/** One insertion path for the picker, paste, links and canvas drops. */
export async function insertBoardAsset(
  input: { file?: File; url?: string; at?: readonly [number, number] },
  client = new HumanBoardClient(),
): Promise<void> {
  const state = useBoardStore.getState();
  if (!state.status || state.editingLocked) return;
  if (!input.file && !input.url) return;
  state.setEditingLocked(true);
  state.setError(null);
  try {
    if (
      input.file &&
      (input.file.size > 20 * 1024 * 1024 ||
        (input.file.type &&
          !["image/png", "image/jpeg"].includes(input.file.type)))
    )
      throw new Error("仅支持不超过20 MB的 PNG / JPEG 图片");
    const encoded = input.file
      ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]!);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(input.file!);
        })
      : undefined;
    const asset = await client.registerAsset({
      project_id: state.status.project.id,
      space_id: state.status.space.id,
      ...(input.file
        ? { name: input.file.name, data_base64: encoded }
        : { url: input.url }),
    });
    const width = Math.min(420, asset.width),
      height = (width * asset.height) / asset.width;
    const count = useBoardStore.getState().workingScene?.assets.length ?? 0;
    const rect = {
      x: input.at ? input.at[0] - width / 2 : 100 + count * 36,
      y: input.at ? input.at[1] - height / 2 : 130 + count * 36,
      w: width,
      h: height,
    };
    state.registerAsset({ ...asset, rect, z: count });
    state.setEditingLocked(false);
    state.editScene((scene) => ({
      ...scene,
      assets: [
        ...scene.assets,
        {
          asset_id: asset.asset_id,
          display_no: asset.display_no,
          rect,
          z: count,
        },
      ],
    }));
    state.selectNode(`asset:${asset.asset_id}`);
  } finally {
    state.setEditingLocked(false);
  }
}
