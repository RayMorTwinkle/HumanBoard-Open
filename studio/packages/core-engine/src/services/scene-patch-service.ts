import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  SceneSchema,
  DiagramSchema,
  DEFAULT_NODE_SIZE,
  describeSchemaIssues,
  resolveSceneDefaults,
  type AssetRef,
  type Edge,
  type Node,
  type Rect,
  type Scene,
  type Stroke,
} from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/ports";
import { SystemClock, UlidGenerator } from "../domain/ports";
import type { Asset, AssetSource, ScenePatch, ULID } from "../domain/types";
import { OWNER_ID } from "../domain/types";
import type { StorageAdapter } from "../storage/storage-adapter";
import { validateSceneAssetRefs } from "./scene-assets";

const PATCH_KEYS = new Set([
  "diagram",
  "upsert_nodes",
  "remove_nodes",
  "upsert_edges",
  "remove_edges",
  "add_strokes",
  "remove_strokes",
  "upsert_assets",
  "remove_assets",
  "add_assets",
]);
const NODE_KEYS = new Set(["id", "kind", "title", "sub", "rect", "style"]);
const EDGE_KEYS = new Set(["id", "from", "to", "label", "style"]);
const STROKE_KEYS = new Set([
  "id",
  "tool",
  "color",
  "width",
  "points",
  "pressure",
]);
const ASSET_KEYS = new Set(["asset_id", "source", "rect", "z", "display_no"]);
const RECT_KEYS = new Set(["x", "y", "w", "h"]);

export interface ScenePatchServiceOptions {
  readonly storage: StorageAdapter;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly resolveUrlTitle?: (url: string) => Promise<string | null>;
}

export interface ApplyScenePatchRequest {
  readonly baseScene: Scene;
  readonly patch: ScenePatch;
  readonly spaceId: ULID;
}

export interface ApplyScenePatchResult {
  readonly scene: Scene;
  readonly registered_assets: Asset[];
}

type UnknownRecord = Record<string, unknown>;

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

// CLI ingestion prepares file bytes before Draft creation without exposing this
// internal hash as a user-patch field.
const preparedFileBlobHashes = new WeakMap<object, `sha256:${string}`>();

export function setPreparedFileBlobHash(
  source: object,
  blobHash: `sha256:${string}`,
): void {
  preparedFileBlobHashes.set(source, blobHash);
}

function isRecord(value: unknown): value is UnknownRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function patchError(
  message: string,
  path: string,
  details: Record<string, unknown> = {},
): HumanBoardError {
  return new HumanBoardError("E_PATCH_INVALID", message, { path, ...details });
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) {
    throw patchError("Expected an object", path);
  }
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw patchError("Expected an array", path);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw patchError("Expected a non-empty string", path);
  }
  return value;
}

function assertAllowedKeys(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw patchError("Unknown patch field", path, { fields: unknownKeys });
  }
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readRect(value: unknown, path: string): Partial<Rect> {
  const record = expectRecord(value, path);
  assertAllowedKeys(record, RECT_KEYS, path);
  return record as Partial<Rect>;
}

function mergeRect(base: Rect, patch: Partial<Rect>): Rect {
  return {
    x: patch.x ?? base.x,
    y: patch.y ?? base.y,
    w: patch.w ?? base.w,
    h: patch.h ?? base.h,
  };
}

function requireCompleteRect(rect: Partial<Rect>, path: string): Rect {
  if (
    rect.x === undefined ||
    rect.y === undefined ||
    rect.w === undefined ||
    rect.h === undefined
  ) {
    throw patchError("New objects require a complete rect", path);
  }
  return rect as Rect;
}

/** A new card needs a position; a missing size falls back to the default card. */
function requireNodeRect(rect: Partial<Rect>, path: string): Rect {
  if (rect.x === undefined || rect.y === undefined) {
    throw patchError("New nodes require rect.x and rect.y", path);
  }
  return {
    x: rect.x,
    y: rect.y,
    w: rect.w ?? DEFAULT_NODE_SIZE.w,
    h: rect.h ?? DEFAULT_NODE_SIZE.h,
  };
}

function removeById<T extends { readonly id: string }>(
  items: T[],
  ids: readonly string[],
  path: string,
): void {
  for (const [index, id] of ids.entries()) {
    const itemIndex = items.findIndex((item) => item.id === id);
    if (itemIndex === -1) {
      throw patchError("Cannot remove an unknown id", `${path}[${index}]`, {
        id,
      });
    }
    items.splice(itemIndex, 1);
  }
}

function readStringArray(value: unknown, path: string): string[] {
  return expectArray(value, path).map((item, index) =>
    expectString(item, `${path}[${index}]`),
  );
}

function blockedUrl(
  message: string,
  path: string,
  details: Record<string, unknown> = {},
): HumanBoardError {
  return new HumanBoardError("E_URL_BLOCKED", message, { path, ...details });
}

function ipv4Parts(address: string): [number, number, number, number] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
    : null;
}

function isPublicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) {
    return false;
  }
  const [a, b, c] = parts;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const normalized = address.toLowerCase().split("%")[0]!;
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }

  const parseHalf = (value: string): number[] | null => {
    if (value.length === 0) {
      return [];
    }
    const parts = value.split(":");
    const groups: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const ipv4 = ipv4Parts(part);
        if (!ipv4) {
          return null;
        }
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) {
    return null;
  }
  if (halves.length === 2 && left.length + right.length > 8) {
    return null;
  }
  const groups =
    halves.length === 2
      ? [
          ...left,
          ...Array<number>(8 - left.length - right.length).fill(0),
          ...right,
        ]
      : left;
  if (
    groups.length !== 8 ||
    groups.some((group) => group < 0 || group > 0xffff)
  ) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return false;
  }
  if (bytes.every((value) => value === 0)) {
    return false;
  }
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return false;
  }
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
    return false;
  }
  if ((bytes[0]! & 0xfe) === 0xfc || bytes[0] === 0xff) {
    return false;
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return false;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return false;
  }
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return false;
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b
  ) {
    return false;
  }
  if (
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.slice(0, 12).every((value) => value === 0)) {
    return false;
  }
  return true;
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPublicIpv4(address);
  }
  if (family === 6) {
    return isPublicIpv6(address);
  }
  return false;
}

async function validateUrlSource(
  sourceUrl: string,
  path: string,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw blockedUrl("URL is malformed", path, { url: sourceUrl });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw blockedUrl("Only http and https URLs are allowed", path, {
      url: sourceUrl,
      protocol: url.protocol,
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw blockedUrl("URL credentials are not allowed", path, {
      url: sourceUrl,
    });
  }

  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (hostname.length === 0) {
    throw blockedUrl("URL hostname is missing", path, { url: sourceUrl });
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw blockedUrl("Cannot resolve URL hostname", path, {
      url: sourceUrl,
      hostname,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (addresses.length === 0) {
    throw blockedUrl("URL hostname resolved to no addresses", path, {
      url: sourceUrl,
      hostname,
    });
  }
  for (const address of addresses) {
    if (
      (address.family !== 4 && address.family !== 6) ||
      !isPublicNetworkAddress(address.address)
    ) {
      throw blockedUrl(
        "URL resolves to a private, loopback, link-local, or reserved address",
        path,
        {
          url: sourceUrl,
          address: address.address,
          family: address.family,
        },
      );
    }
  }
  return url;
}

export class ScenePatchService {
  private readonly storage: StorageAdapter;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly resolveUrlTitle:
    | ((url: string) => Promise<string | null>)
    | undefined;

  constructor(options: ScenePatchServiceOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new UlidGenerator(this.clock);
    this.resolveUrlTitle = options.resolveUrlTitle;
  }

  async apply(request: ApplyScenePatchRequest): Promise<ApplyScenePatchResult> {
    const patch = expectRecord(request.patch, "$");
    assertAllowedKeys(patch, PATCH_KEYS, "$");

    const scene = structuredClone(request.baseScene);
    if (hasOwn(patch, "diagram")) {
      if (patch.diagram === null) delete scene.diagram;
      else {
        scene.diagram = DiagramSchema.parse(patch.diagram);
        if (
          scene.diagram.layout !== request.baseScene.diagram?.layout ||
          scene.diagram.mode !== request.baseScene.diagram?.mode ||
          (scene.diagram.layout_revision ?? 0) !==
            (request.baseScene.diagram?.layout_revision ?? 0)
        )
          scene.nodes = [];
      }
    }
    if (
      scene.diagram &&
      ["upsert_nodes", "remove_nodes", "upsert_edges", "remove_edges"].some(
        (k) => Array.isArray(patch[k]) && (patch[k] as unknown[]).length,
      )
    )
      throw patchError(
        "Structured diagrams use diagram content; convert with diagram:null before editing coordinates",
        "$.diagram",
      );
    const registeredAssets: Asset[] = [];

    if (hasOwn(patch, "remove_nodes")) {
      removeById(
        scene.nodes,
        readStringArray(patch.remove_nodes, "$.remove_nodes"),
        "$.remove_nodes",
      );
    }
    if (hasOwn(patch, "remove_edges")) {
      removeById(
        scene.edges,
        readStringArray(patch.remove_edges, "$.remove_edges"),
        "$.remove_edges",
      );
    }
    if (hasOwn(patch, "remove_strokes")) {
      removeById(
        scene.strokes,
        readStringArray(patch.remove_strokes, "$.remove_strokes"),
        "$.remove_strokes",
      );
    }
    if (hasOwn(patch, "remove_assets")) {
      await this.removeAssets(
        scene,
        readStringArray(patch.remove_assets, "$.remove_assets"),
        request.spaceId,
      );
    }

    if (hasOwn(patch, "upsert_nodes")) {
      this.upsertNodes(
        scene,
        expectArray(patch.upsert_nodes, "$.upsert_nodes"),
      );
    }
    if (hasOwn(patch, "upsert_edges")) {
      this.upsertEdges(
        scene,
        expectArray(patch.upsert_edges, "$.upsert_edges"),
      );
    }
    if (hasOwn(patch, "add_strokes")) {
      this.addStrokes(scene, expectArray(patch.add_strokes, "$.add_strokes"));
    }

    const assetUpserts = [
      ...(hasOwn(patch, "upsert_assets")
        ? expectArray(patch.upsert_assets, "$.upsert_assets").map(
            (value, index) => ({
              value,
              path: `$.upsert_assets[${index}]`,
            }),
          )
        : []),
      ...(hasOwn(patch, "add_assets")
        ? expectArray(patch.add_assets, "$.add_assets").map((value, index) => ({
            value,
            path: `$.add_assets[${index}]`,
          }))
        : []),
    ];
    await this.validateAssetSources(assetUpserts);
    let nextDisplayNo: string | null = null;
    const allocateDisplayNo = async (): Promise<string> => {
      if (nextDisplayNo === null) {
        nextDisplayNo = await this.storage.nextAssetDisplayNo(request.spaceId);
      }
      const current = nextDisplayNo;
      const numeric = Number.parseInt(current, 10);
      nextDisplayNo = Number.isFinite(numeric)
        ? String(numeric + 1).padStart(3, "0")
        : current;
      return current;
    };
    for (const { value, path } of assetUpserts) {
      await this.upsertAsset(
        scene,
        expectRecord(value, path),
        request.spaceId,
        path,
        registeredAssets,
        allocateDisplayNo,
      );
    }

    let parsed: Scene;
    try {
      parsed = SceneSchema.parse(resolveSceneDefaults(scene));
    } catch (error) {
      const issues = describeSchemaIssues(error, 8, scene);
      throw patchError(
        `Patched Scene does not match the schema: ${issues[0]}`,
        "$",
        { issues },
      );
    }

    for (const asset of registeredAssets) {
      await this.storage.createAsset(asset);
    }
    await validateSceneAssetRefs(this.storage, parsed, request.spaceId);
    return { scene: parsed, registered_assets: registeredAssets };
  }

  private upsertNodes(scene: Scene, values: unknown[]): void {
    for (const [index, value] of values.entries()) {
      const path = `$.upsert_nodes[${index}]`;
      const patch = expectRecord(value, path);
      assertAllowedKeys(patch, NODE_KEYS, path);
      const id = expectString(patch.id, `${path}.id`);
      const existingIndex = scene.nodes.findIndex((node) => node.id === id);

      if (existingIndex === -1) {
        if (
          !hasOwn(patch, "kind") ||
          !hasOwn(patch, "title") ||
          !hasOwn(patch, "rect")
        ) {
          throw patchError("New nodes require id, kind, title, and rect", path);
        }
        const rect = requireNodeRect(
          readRect(patch.rect, `${path}.rect`),
          path,
        );
        const node: UnknownRecord = {
          id,
          kind: patch.kind,
          title: patch.title,
          rect,
        };
        if (hasOwn(patch, "sub")) {
          node.sub = patch.sub;
        }
        if (hasOwn(patch, "style")) {
          node.style = patch.style;
        }
        scene.nodes.push(node as Node);
        continue;
      }

      const existing = scene.nodes[existingIndex]!;
      const merged: UnknownRecord = { ...existing };
      for (const key of ["kind", "title", "sub", "style"] as const) {
        if (hasOwn(patch, key)) {
          merged[key] = patch[key];
        }
      }
      if (hasOwn(patch, "rect")) {
        merged.rect = mergeRect(
          existing.rect,
          readRect(patch.rect, `${path}.rect`),
        );
      }
      scene.nodes[existingIndex] = merged as Node;
    }
  }

  private upsertEdges(scene: Scene, values: unknown[]): void {
    for (const [index, value] of values.entries()) {
      const path = `$.upsert_edges[${index}]`;
      const patch = expectRecord(value, path);
      assertAllowedKeys(patch, EDGE_KEYS, path);
      const id = expectString(patch.id, `${path}.id`);
      const existingIndex = scene.edges.findIndex((edge) => edge.id === id);

      if (existingIndex === -1) {
        if (!hasOwn(patch, "from") || !hasOwn(patch, "to")) {
          throw patchError("New edges require id, from, and to", path);
        }
        const edge: UnknownRecord = {
          id,
          from: patch.from,
          to: patch.to,
        };
        if (hasOwn(patch, "label")) {
          edge.label = patch.label;
        }
        if (hasOwn(patch, "style")) {
          edge.style = patch.style;
        }
        scene.edges.push(edge as Edge);
        continue;
      }

      const existing = scene.edges[existingIndex]!;
      const merged: UnknownRecord = { ...existing };
      for (const key of ["from", "to", "label", "style"] as const) {
        if (hasOwn(patch, key)) {
          merged[key] = patch[key];
        }
      }
      scene.edges[existingIndex] = merged as Edge;
    }
  }

  private addStrokes(scene: Scene, values: unknown[]): void {
    for (const [index, value] of values.entries()) {
      const path = `$.add_strokes[${index}]`;
      const patch = expectRecord(value, path);
      assertAllowedKeys(patch, STROKE_KEYS, path);
      const id = expectString(patch.id, `${path}.id`);
      const existingIndex = scene.strokes.findIndex(
        (stroke) => stroke.id === id,
      );
      if (existingIndex === -1) {
        scene.strokes.push(patch as unknown as Stroke);
      } else {
        scene.strokes[existingIndex] = patch as unknown as Stroke;
      }
    }
  }

  private async removeAssets(
    scene: Scene,
    assetIds: readonly string[],
    spaceId: ULID,
  ): Promise<void> {
    for (const [index, assetId] of assetIds.entries()) {
      const asset = await this.resolveAsset(
        assetId,
        spaceId,
        `$.remove_assets[${index}]`,
      );
      const refIndex = scene.assets.findIndex(
        (assetRef) => assetRef.asset_id === asset.asset_id,
      );
      if (refIndex === -1) {
        throw new HumanBoardError(
          "E_ASSET_NOT_FOUND",
          `Asset ${asset.asset_id} is not referenced by the base Scene`,
          { asset_id: asset.asset_id, space_id: spaceId },
        );
      }
      scene.assets.splice(refIndex, 1);
    }
  }

  private async upsertAsset(
    scene: Scene,
    patch: UnknownRecord,
    spaceId: ULID,
    path: string,
    registeredAssets: Asset[],
    allocateDisplayNo: () => Promise<string>,
  ): Promise<void> {
    assertAllowedKeys(patch, ASSET_KEYS, path);
    if (hasOwn(patch, "display_no")) {
      throw patchError("display_no cannot be patched", `${path}.display_no`);
    }

    const hasAssetId = hasOwn(patch, "asset_id");
    const hasSource = hasOwn(patch, "source");
    if (hasAssetId === hasSource) {
      throw patchError(
        "Asset upsert requires exactly one of asset_id or source",
        path,
      );
    }

    let asset: Asset;
    if (hasSource) {
      asset = await this.registerSource(
        expectRecord(patch.source, `${path}.source`),
        spaceId,
        `${path}.source`,
        allocateDisplayNo,
      );
      registeredAssets.push(asset);
    } else {
      asset = await this.resolveAsset(
        expectString(patch.asset_id, `${path}.asset_id`),
        spaceId,
        `${path}.asset_id`,
      );
    }

    const existingIndex = scene.assets.findIndex(
      (assetRef) => assetRef.asset_id === asset.asset_id,
    );
    const existing = existingIndex === -1 ? null : scene.assets[existingIndex]!;
    const patchRect = hasOwn(patch, "rect")
      ? readRect(patch.rect, `${path}.rect`)
      : undefined;
    const rect = existing
      ? mergeRect(existing.rect, patchRect ?? {})
      : requireCompleteRect(patchRect ?? {}, `${path}.rect`);
    const z = hasOwn(patch, "z") ? patch.z : existing?.z;

    if (typeof z !== "number") {
      throw patchError(
        "Asset upsert requires z for a new AssetRef",
        `${path}.z`,
      );
    }

    const assetRef: AssetRef = {
      asset_id: asset.asset_id,
      display_no: asset.display_no,
      rect,
      z,
    };
    if (existingIndex === -1) {
      scene.assets.push(assetRef);
    } else {
      scene.assets[existingIndex] = assetRef;
    }
  }

  private async registerSource(
    source: UnknownRecord,
    spaceId: ULID,
    path: string,
    allocateDisplayNo: () => Promise<string>,
  ): Promise<Asset> {
    const kind = expectString(source.kind, `${path}.kind`);
    let assetSource: AssetSource;
    if (kind === "file") {
      assertAllowedKeys(source, new Set(["kind", "path"]), path);
      assetSource = {
        kind: "file",
        path: expectString(source.path, `${path}.path`),
      };
    } else if (kind === "url") {
      assertAllowedKeys(source, new Set(["kind", "url"]), path);
      const url = expectString(source.url, `${path}.url`);
      assetSource = {
        kind: "url",
        url,
      };
    } else {
      throw patchError("Asset source kind must be file or url", `${path}.kind`);
    }

    let title = "";
    if (assetSource.kind === "url" && this.resolveUrlTitle !== undefined) {
      try {
        title = (await this.resolveUrlTitle(assetSource.url))?.trim() ?? "";
      } catch {
        title = "";
      }
    }

    const asset: Asset = {
      asset_id: this.ids.next(),
      space_id: spaceId,
      display_no: await allocateDisplayNo(),
      type: assetSource.kind === "file" ? "image" : "url",
      title,
      title_source: "pending",
      blob_hash:
        assetSource.kind === "file"
          ? (preparedFileBlobHashes.get(source) ?? null)
          : null,
      source_url: assetSource.kind === "url" ? assetSource.url : null,
      owner_id: OWNER_ID,
      created_at: this.clock.now().toISOString(),
    };

    // Persist only after the complete patched Scene has passed schema checks.
    return asset;
  }

  private async validateAssetSources(
    assetUpserts: readonly { readonly value: unknown; readonly path: string }[],
  ): Promise<void> {
    for (const { value, path } of assetUpserts) {
      const patch = expectRecord(value, path);
      if (!hasOwn(patch, "source")) {
        continue;
      }
      const source = expectRecord(patch.source, `${path}.source`);
      const kind = expectString(source.kind, `${path}.source.kind`);
      if (kind === "url") {
        assertAllowedKeys(source, new Set(["kind", "url"]), `${path}.source`);
        const url = expectString(source.url, `${path}.source.url`);
        await validateUrlSource(url, `${path}.source.url`);
      } else if (kind === "file") {
        assertAllowedKeys(source, new Set(["kind", "path"]), `${path}.source`);
        expectString(source.path, `${path}.source.path`);
      } else {
        throw patchError(
          "Asset source kind must be file or url",
          `${path}.source.kind`,
        );
      }
    }
  }

  private async resolveAsset(
    reference: string,
    spaceId: ULID,
    path: string,
  ): Promise<Asset> {
    const shortId = reference.startsWith("#") ? reference.slice(1) : reference;
    const asset = /^\d{3,}$/.test(shortId)
      ? await this.storage.getAssetByDisplayNo(spaceId, shortId)
      : await this.storage.getAsset(shortId);

    if (!asset || asset.space_id !== spaceId) {
      throw new HumanBoardError(
        "E_ASSET_NOT_FOUND",
        `Asset ${reference} does not exist in Space ${spaceId}`,
        { path, asset_id: reference, space_id: spaceId },
      );
    }
    return asset;
  }
}
