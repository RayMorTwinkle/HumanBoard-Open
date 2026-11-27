import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { HumanBoardError, MAX_ASSET_FILE_BYTES } from "@humanboard/core-engine";
import { readImageMetadata } from "./image-metadata";

/** Transport-only aliases: no client filesystem paths become server filesystem paths. */
export async function prepareConnectedFiles(
  stdin: string,
  cwd: string,
  upload: (hash: string, data: Uint8Array) => Promise<void>,
): Promise<{ stdin: string; fileBlobs: Record<string, string> }> {
  let patch: unknown;
  try {
    patch = JSON.parse(stdin);
  } catch {
    throw new HumanBoardError(
      "E_PATCH_INVALID",
      "Draft patch must be valid JSON",
    );
  }
  const fileBlobs: Record<string, string> = {};
  if (
    !patch ||
    typeof patch !== "object" ||
    !Array.isArray((patch as { upsert_assets?: unknown }).upsert_assets)
  )
    return { stdin, fileBlobs };
  const aliases = new Map<string, string>(),
    uploaded = new Set<string>();
  for (const item of (patch as { upsert_assets: unknown[] }).upsert_assets) {
    if (!item || typeof item !== "object") continue;
    const source = (item as { source?: { kind?: unknown; path?: unknown } })
      .source;
    if (!source || source.kind !== "file" || typeof source.path !== "string")
      continue;
    const path = resolve(cwd, source.path);
    let alias = aliases.get(path);
    if (!alias) {
      let data: Uint8Array;
      try {
        const info = await stat(path);
        if (!info.isFile())
          throw new HumanBoardError(
            "E_USAGE",
            "Asset source must be a regular file",
            { path },
          );
        if (info.size > MAX_ASSET_FILE_BYTES)
          throw new HumanBoardError(
            "E_USAGE",
            "Asset file exceeds the 20 MB limit",
            { path, max_bytes: MAX_ASSET_FILE_BYTES },
          );
        data = new Uint8Array(await readFile(path));
      } catch (error) {
        if (error instanceof HumanBoardError) throw error;
        throw new HumanBoardError("E_USAGE", "Cannot read client asset file", {
          path,
        });
      }
      if (!data.length || data.length > MAX_ASSET_FILE_BYTES)
        throw new HumanBoardError(
          "E_USAGE",
          "Asset file must be between 1 byte and 20 MB",
          { path },
        );
      readImageMetadata(data);
      const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
      if (!uploaded.has(hash)) {
        await upload(hash, data);
        uploaded.add(hash);
      }
      alias = `upload:${aliases.size + 1}`;
      aliases.set(path, alias);
      fileBlobs[alias] = hash;
    }
    source.path = alias;
  }
  return { stdin: JSON.stringify(patch), fileBlobs };
}
