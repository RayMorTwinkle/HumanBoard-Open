import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  HumanBoardError,
  MAX_ASSET_FILE_BYTES,
  OWNER_ID,
  renderSceneToPNGAsync,
  type Asset,
  type BlobAdapter,
  type StorageAdapter,
} from "@humanboard/core-engine";
import type { Scene } from "@humanboard/schema";
import { readImageMetadata } from "./image-metadata";
import type { UrlInspectResult } from "./url-inspector";

/** Asset IO and visual materialization shared by CLI, HTTP and built-in Agent. */
export class AssetApplicationService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly blobs: BlobAdapter,
    private readonly urlSourceValidator: (url: string) => Promise<unknown>,
    private readonly urlSourceInspector: (
      url: string,
    ) => Promise<Pick<UrlInspectResult, "title" | "description">>,
    private readonly onRegistered: (assets: Asset[]) => void,
  ) {}
  async stageFile(
    hash: string,
    data: Uint8Array,
  ): Promise<{ blob_hash: string }> {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash))
      throw new HumanBoardError("E_USAGE", "Invalid upload hash");
    if (!data.length || data.length > MAX_ASSET_FILE_BYTES)
      throw new HumanBoardError(
        "E_USAGE",
        "Image must be between 1 byte and 20 MB",
      );
    readImageMetadata(data);
    const actual = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    if (actual !== hash)
      throw new HumanBoardError(
        "E_HASH_MISMATCH",
        "Uploaded file hash does not match its content",
        { hash, actual },
      );
    return { blob_hash: await this.blobs.writeBlob(data) };
  }
  async renderScenePNG(scene: Scene): Promise<Buffer> {
    return renderSceneToPNGAsync(scene, await this.renderAssets([scene]));
  }

  async renameAsset(id: string, title: string): Promise<Asset> {
    if (!title.trim() || Array.from(title).length > 120)
      throw new HumanBoardError(
        "E_USAGE",
        "Asset title must be 1–120 characters",
      );
    return this.storage.updateAsset(id, {
      title: title.trim(),
      title_source: "human",
    });
  }

  async readAssetImage(assetId: string): Promise<{
    data: Uint8Array;
    mime: string;
    width: number;
    height: number;
  }> {
    const asset = await this.storage.getAsset(assetId);
    if (!asset || asset.type !== "image" || !asset.blob_hash)
      throw new HumanBoardError("E_ASSET_NOT_FOUND", "Image asset not found");
    const data = await this.blobs.readBlob(asset.blob_hash);
    const metadata = readImageMetadata(data);
    return {
      data,
      mime: metadata.mimeType,
      width: metadata.width,
      height: metadata.height,
    };
  }

  async registerFrontendAsset(input: {
    project_id: string;
    space_id: string;
    name?: string;
    data_base64?: string;
    url?: string;
  }): Promise<unknown> {
    const space = await this.storage.getSpace(input.space_id);
    if (!space || space.project_id !== input.project_id)
      throw new HumanBoardError(
        "E_SPACE_NOT_FOUND",
        "Space not found in Project",
      );
    let blob: `sha256:${string}` | null = null;
    let width = 360,
      height = 220,
      title = "",
      description = "";
    if (input.data_base64 !== undefined) {
      const data = new Uint8Array(Buffer.from(input.data_base64, "base64"));
      if (data.length === 0 || data.length > MAX_ASSET_FILE_BYTES)
        throw new HumanBoardError(
          "E_USAGE",
          "Image must be between 1 byte and 20 MB",
        );
      const metadata = readImageMetadata(data);
      width = metadata.width;
      height = metadata.height;
      blob = await this.blobs.writeBlob(data);
    } else if (input.url) {
      await this.urlSourceValidator(input.url);
      try {
        const page = await this.urlSourceInspector(input.url);
        title = page.title;
        description = page.description ?? "";
      } catch {
        title = new URL(input.url).hostname;
      }
    } else throw new HumanBoardError("E_USAGE", "Provide an image or URL");
    const asset = await this.storage.createAsset({
      asset_id: ulid(),
      space_id: space.id,
      display_no: await this.storage.nextAssetDisplayNo(space.id),
      type: blob ? "image" : "url",
      title,
      ...(description
        ? { description: Array.from(description).slice(0, 240).join("") }
        : {}),
      title_source: title ? "builtin" : "pending",
      blob_hash: blob,
      source_url: input.url ?? null,
      owner_id: OWNER_ID,
      created_at: new Date().toISOString(),
    });
    try {
      this.onRegistered([asset]);
    } catch {
      /* background work never rolls back registration */
    }
    return { ...asset, width, height };
  }

  async renderAssets(scenes: readonly Scene[]) {
    const assetImages: Record<string, string> = {},
      assetTitles: Record<string, string> = {},
      assetCards: Record<string, { url: string; description?: string }> = {};
    for (const id of new Set(
      scenes.flatMap((scene) => scene.assets.map((asset) => asset.asset_id)),
    )) {
      const asset = await this.storage.getAsset(id);
      if (!asset) continue;
      assetTitles[id] = asset.title || asset.source_url || "图片";
      if (asset.type === "url" && asset.source_url)
        assetCards[id] = {
          url: asset.source_url,
          description: asset.description,
        };
      if (asset.type === "image" && asset.blob_hash) {
        const image = await this.readAssetImage(id);
        assetImages[id] =
          `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`;
      }
    }
    return { assetImages, assetTitles, assetCards };
  }
}
