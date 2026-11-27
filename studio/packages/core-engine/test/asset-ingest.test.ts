import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { HumanBoardError } from "../src/domain/errors";
import {
  AssetIngestService,
  MAX_ASSET_FILE_BYTES,
} from "../src/services/asset-ingest-service";
import { LocalBlobAdapter } from "../src/storage/local-blob-adapter";
import { createFixture, createImageAsset } from "./helpers";

async function expectError(
  action: () => Promise<unknown>,
  code: HumanBoardError["code"],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(HumanBoardError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected HumanBoardError ${code}`);
}

describe("LocalBlobAdapter", () => {
  test("writes content-addressed sharded blobs and verifies hashes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-blobs-"));
    const blobs = new LocalBlobAdapter({ rootDir: join(directory, "blobs") });
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    try {
      const hash = await blobs.writeBlob(data);
      const expected =
        `sha256:${createHash("sha256").update(data).digest("hex")}` as `sha256:${string}`;
      expect(hash).toBe(expected);
      expect(Array.from(await blobs.readBlob(hash))).toEqual(Array.from(data));
      expect(
        existsSync(
          join(directory, "blobs", hash.slice(7, 9), hash.slice(9)),
        ),
      ).toBe(true);
      expect(await blobs.writeBlob(data)).toBe(hash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("detects a blob whose content no longer matches its hash", async () => {
    const directory = mkdtempSync(join(tmpdir(), "humanboard-blobs-"));
    const blobs = new LocalBlobAdapter({ rootDir: join(directory, "blobs") });
    try {
      const hash = await blobs.writeBlob(new Uint8Array([1, 2, 3]));
      const path = join(
        directory,
        "blobs",
        hash.slice(7, 9),
        hash.slice(9),
      );
      writeFileSync(path, new Uint8Array([9, 9, 9]));

      await expectError(() => blobs.readBlob(hash), "E_HASH_MISMATCH");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AssetIngestService", () => {
  test("reads a file, writes its actual hash, and updates Asset.blob_hash", async () => {
    const fixture = await createFixture();
    const directory = mkdtempSync(join(tmpdir(), "humanboard-ingest-"));
    const filePath = join(directory, "screenshot.bin");
    const data = new Uint8Array([10, 20, 30, 40]);
    writeFileSync(filePath, data);

    try {
      const asset = await createImageAsset(fixture, fixture.space.id, "001");
      const service = new AssetIngestService({
        storage: fixture.storage,
        blobs: new LocalBlobAdapter({ rootDir: join(directory, "blobs") }),
      });

      const updated = await service.ingestFile({
        assetId: asset.asset_id,
        filePath,
      });
      const expectedHash =
        `sha256:${createHash("sha256").update(data).digest("hex")}` as `sha256:${string}`;
      expect(updated.blob_hash).toBe(expectedHash);
      expect(updated.title).toBe(asset.title);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects files over 20MB before reading their contents", async () => {
    const fixture = await createFixture();
    const directory = mkdtempSync(join(tmpdir(), "humanboard-ingest-"));
    const filePath = join(directory, "too-large.bin");
    writeFileSync(filePath, new Uint8Array([0]));
    truncateSync(filePath, MAX_ASSET_FILE_BYTES + 1);

    try {
      const asset = await createImageAsset(fixture, fixture.space.id, "001");
      const service = new AssetIngestService({
        storage: fixture.storage,
        blobs: new LocalBlobAdapter({ rootDir: join(directory, "blobs") }),
      });

      await expectError(
        () => service.ingestFile({ assetId: asset.asset_id, filePath }),
        "E_USAGE",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an unknown Asset id", async () => {
    const fixture = await createFixture();
    const directory = mkdtempSync(join(tmpdir(), "humanboard-ingest-"));
    const filePath = join(directory, "small.bin");
    writeFileSync(filePath, new Uint8Array([1]));

    try {
      const service = new AssetIngestService({
        storage: fixture.storage,
        blobs: new LocalBlobAdapter({ rootDir: join(directory, "blobs") }),
      });
      await expectError(
        () =>
          service.ingestFile({
            assetId: fixture.ids.next(),
            filePath,
          }),
        "E_ASSET_NOT_FOUND",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
