import type { Scene } from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import type { ULID } from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";

export async function validateSceneAssetRefs(
  storage: StorageAdapter,
  scene: Scene,
  spaceId: ULID,
): Promise<void> {
  for (const assetRef of scene.assets) {
    const asset = await storage.getAsset(assetRef.asset_id);
    if (!asset || asset.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_ASSET_NOT_FOUND",
        `Asset ${assetRef.asset_id} does not exist in Space ${spaceId}`,
        { asset_id: assetRef.asset_id, space_id: spaceId },
      );
    }
    if (asset.display_no !== assetRef.display_no) {
      throw new HumanBoardError(
        "E_PATCH_INVALID",
        `Asset ${assetRef.asset_id} display_no does not match its Space record`,
        {
          asset_id: assetRef.asset_id,
          expected_display_no: asset.display_no,
          actual_display_no: assetRef.display_no,
        },
      );
    }
  }
}
