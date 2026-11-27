import { readFile, stat } from "node:fs/promises";

import { HumanBoardError } from "../domain/errors";
import type { Asset, ULID } from "../domain/types";
import type { BlobAdapter } from "../storage/blob-adapter";
import type { StorageAdapter } from "../storage/storage-adapter";

export const MAX_ASSET_FILE_BYTES = 20 * 1024 * 1024;

export interface AssetIngestServiceOptions {
  readonly storage: StorageAdapter;
  readonly blobs: BlobAdapter;
  readonly maxBytes?: number;
}

export interface IngestFileRequest {
  readonly assetId: ULID;
  readonly filePath: string;
}

export class AssetIngestService {
  private readonly storage: StorageAdapter;
  private readonly blobs: BlobAdapter;
  private readonly maxBytes: number;

  constructor(options: AssetIngestServiceOptions) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0)
    ) {
      throw new HumanBoardError("E_USAGE", "maxBytes must be positive");
    }
    this.storage = options.storage;
    this.blobs = options.blobs;
    this.maxBytes = options.maxBytes ?? MAX_ASSET_FILE_BYTES;
  }

  async ingestFile(request: IngestFileRequest): Promise<Asset> {
    if (request.filePath.trim().length === 0) {
      throw new HumanBoardError("E_USAGE", "filePath must not be empty");
    }

    const asset = await this.storage.getAsset(request.assetId);
    if (!asset) {
      throw new HumanBoardError(
        "E_ASSET_NOT_FOUND",
        `Asset ${request.assetId} does not exist`,
      );
    }
    if (asset.type !== "image") {
      throw new HumanBoardError(
        "E_USAGE",
        `Asset ${request.assetId} is not an image`,
      );
    }

    let fileSize: number;
    try {
      fileSize = (await stat(request.filePath)).size;
    } catch (error) {
      throw new HumanBoardError("E_USAGE", "Cannot read asset file", {
        path: request.filePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (fileSize > this.maxBytes) {
      throw new HumanBoardError(
        "E_USAGE",
        `Asset file exceeds ${this.maxBytes} bytes`,
        { path: request.filePath, size: fileSize, max_bytes: this.maxBytes },
      );
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(request.filePath));
    } catch (error) {
      throw new HumanBoardError("E_USAGE", "Cannot read asset file", {
        path: request.filePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (data.byteLength > this.maxBytes) {
      throw new HumanBoardError(
        "E_USAGE",
        `Asset file exceeds ${this.maxBytes} bytes`,
        {
          path: request.filePath,
          size: data.byteLength,
          max_bytes: this.maxBytes,
        },
      );
    }

    const blobHash = await this.blobs.writeBlob(data);
    return this.storage.updateAsset(request.assetId, {
      blob_hash: blobHash,
    });
  }
}
