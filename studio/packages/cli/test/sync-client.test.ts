import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SyncPushPayload } from "@humanboard/core-engine";

import { resolveRuntimePaths } from "../src/config";
import {
  remoteClientFromConfig,
  RemoteSyncClient,
  MAX_SYNC_PUSH_BYTES,
  pushLocalToRemote,
  type LocalSyncProvider,
  type SyncTransport,
} from "../src/sync-client";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("large blob pushes are bounded and retry after a partial upload without committing Layers early", async () => {
  const empty = {
    accepted: [],
    rejected: [],
    seq_map: {},
    meta_conflicts: [],
    warnings: [],
  };
  const staged = new Set<string>();
  const sizes: number[] = [];
  let failSecond = true,
    calls = 0,
    completed = 0;
  const client = new RemoteSyncClient({
    serverUrl: "http://fixture.invalid",
    fetch: async (_url, init) => {
      const body = String(init?.body);
      sizes.push(Buffer.byteLength(body));
      const payload = JSON.parse(body) as SyncPushPayload;
      calls++;
      if (calls === 2 && failSecond) {
        failSecond = false;
        return Response.json(
          { error: { code: "E_CONNECT", message: "interrupted" } },
          { status: 503 },
        );
      }
      for (const blob of payload.blobs) {
        if (typeof blob === "string") expect(staged.has(blob)).toBe(true);
        else staged.add(blob.hash);
      }
      if (payload.layers.length) completed++;
      return Response.json(empty);
    },
  });
  const blobs = [1, 2].map((value) => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, value);
    return {
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
      data_base64: bytes.toString("base64"),
    };
  });
  const payload = {
    project_id: "P",
    space_id: "S",
    layers: [{ layer: { id: "L" } }],
    blobs,
    meta: [],
  } as unknown as SyncPushPayload;
  await expect(client.pushRemote(payload)).rejects.toThrow("interrupted");
  expect(staged.size).toBe(1);
  expect(completed).toBe(0);
  await client.pushRemote(payload);
  expect(staged.size).toBe(2);
  expect(completed).toBe(1);
  expect(sizes.every((size) => size <= MAX_SYNC_PUSH_BYTES)).toBe(true);
});

test("an older server rejecting bootstrap is reported as a failure, not a completed sync", async () => {
  const paths: string[] = [];
  const client = new RemoteSyncClient({
    serverUrl: "http://fixture.invalid",
    fetch: async (url) => {
      paths.push(url.pathname);
      return Response.json(
        { error: { code: "E_SPACE_NOT_FOUND", message: "Space is absent" } },
        { status: 404 },
      );
    },
  });
  const local = {
    getSyncService: () => ({
      inventory: async () => ({
        layer_ids: ["L"],
        blob_hashes: [],
        active_layer_id: "L",
      }),
      negotiate: async () => ({
        scope: { project: { id: "P" }, space: { id: "S", project_id: "P" } },
      }),
    }),
  } as unknown as LocalSyncProvider;
  await expect(
    pushLocalToRemote(local, client, "P", "S"),
  ).rejects.toMatchObject({ code: "E_SPACE_NOT_FOUND" });
  expect(paths).toEqual(["/sync/negotiate", "/sync/push"]);
});

describe("RemoteSyncClient", () => {
  test("reads config and calls every sync endpoint with auth headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "humanboard-sync-client-"));
    temporaryDirectories.push(root);
    const env = { HUMANBOARD_HOME: join(root, "home") };
    const paths = resolveRuntimePaths(env, root);
    await mkdir(paths.home, { recursive: true });
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        server_url: "http://127.0.0.1:4317/",
        token: "secret-token",
      })}\n`,
      "utf8",
    );

    const blob = new TextEncoder().encode("sync-client-blob");
    const hash =
      `sha256:${createHash("sha256").update(blob).digest("hex")}` as const;
    const requests: Array<{
      readonly path: string;
      readonly authorization: string | null;
      readonly client: string | null;
    }> = [];
    const fetchImpl = async (url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        path: `${url.pathname}${url.search}`,
        authorization: headers.get("authorization"),
        client: headers.get("x-humanboard-client"),
      });
      if (url.pathname.startsWith("/blobs/")) {
        return new Response(blob);
      }
      if (url.pathname.startsWith("/layers/")) {
        return Response.json({ layer: { id: "layer" } });
      }
      return Response.json({ accepted: [] });
    };

    const client = await remoteClientFromConfig(paths, { fetch: fetchImpl });
    expect(client).not.toBeNull();
    const transport: SyncTransport = client!;
    await transport.negotiateRemote("project", "space", ["layer"], {
      blobs: [],
    });
    await transport.pullRemoteLayer("project", "space", "layer");
    await transport.pullRemoteBlob(hash);
    await transport.pushRemote({
      project_id: "project",
      space_id: "space",
      layers: [],
      blobs: [],
      meta: [],
    } as SyncPushPayload);

    expect(requests.map((request) => request.path)).toEqual([
      "/sync/negotiate",
      "/layers/layer?project_id=project&space_id=space",
      `/blobs/${hash}`,
      "/sync/push",
    ]);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer secret-token",
      ),
    ).toBe(true);
    expect(
      requests
        .filter(
          (request) =>
            request.path === "/sync/negotiate" || request.path === "/sync/push",
        )
        .every((request) => request.client === "1"),
    ).toBe(true);
  });

  test("returns null when the server config does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "humanboard-sync-client-"));
    temporaryDirectories.push(root);
    const paths = resolveRuntimePaths(
      { HUMANBOARD_HOME: join(root, "home") },
      root,
    );
    expect(await remoteClientFromConfig(paths)).toBeNull();
  });
});
