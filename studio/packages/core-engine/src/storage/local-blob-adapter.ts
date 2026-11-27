import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HumanBoardError } from "../domain/errors";
import type { BlobAdapter } from "./blob-adapter";

export interface LocalBlobAdapterOptions {
  readonly rootDir: string;
}

function hashOf(data: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function validateHash(hash: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(hash);
  if (!match) {
    throw new HumanBoardError("E_USAGE", `Invalid blob hash: ${hash}`);
  }
  return match[1]!;
}

export class LocalBlobAdapter implements BlobAdapter {
  private readonly rootDir: string;

  constructor(options: LocalBlobAdapterOptions) {
    if (options.rootDir.trim().length === 0) {
      throw new HumanBoardError("E_USAGE", "rootDir must not be empty");
    }
    this.rootDir = options.rootDir;
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const hex = validateHash(hash);
    const path = this.pathFor(hex);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(path));
    } catch (error) {
      throw new HumanBoardError("E_NOT_FOUND", `Blob ${hash} does not exist`, {
        hash,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (hashOf(data) !== hash) {
      throw new HumanBoardError(
        "E_HASH_MISMATCH",
        `Blob ${hash} content hash does not match`,
        { hash, actual: hashOf(data) },
      );
    }
    return data;
  }

  async writeBlob(data: Uint8Array): Promise<`sha256:${string}`> {
    const hash = hashOf(data);
    const path = this.pathFor(hash.slice(7));
    try {
      await mkdir(join(this.rootDir, hash.slice(7, 9)), { recursive: true });
      await writeFile(path, data, { flag: "wx" });
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") {
        throw new HumanBoardError("E_INTERNAL", `Cannot write blob ${hash}`, {
          hash,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      await this.readBlob(hash);
    }
    return hash;
  }

  private pathFor(hex: string): string {
    return join(this.rootDir, hex.slice(0, 2), hex.slice(2));
  }
}
