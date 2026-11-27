import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Scene } from "@humanboard/schema";
import type {
  Review,
  StudioState,
} from "../../../packages/core-engine/src/revisions/service";
import { SqliteStorageAdapter } from "../../../packages/core-engine/src/storage/sqlite/sqlite-storage-adapter";
import { deleteLayerBranch } from "../../../packages/core-engine/src/services/layer-visibility";
import { openWorkspace } from "./workspace";
import { serveStudio } from "./server";

let dir: string;
let ws: Awaited<ReturnType<typeof openWorkspace>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hb-revision-"));
  ws = await openWorkspace(dir);
});
afterEach(() => {
  ws.close();
  rmSync(dir, { force: true, recursive: true });
});
const run = (input: unknown) => ws.service.execute(ws.spaceId, input);
const state = async (branch = "main") =>
  (await run({ action: "state", branch })) as StudioState;
const save = async (branch: string, head: string, scene: Scene) =>
  (await run({ action: "save", branch, head, scene, title: "edit" })).head;

test("fork, review all diff kinds, accept once, persist both parents and undo as a new version", async () => {
  const a = await state();
  await run({ action: "fork", branch: "work", from: a.head });
  await expect(
    run({ action: "fork", branch: "work", from: a.head }),
  ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
  const proposal = structuredClone(a.scene);
  const removed = proposal.nodes.pop()!;
  proposal.edges = proposal.edges.filter(
    (e) => e.to.node_id !== removed.id && e.from.node_id !== removed.id,
  );
  proposal.nodes[0]!.title = "proposal";
  proposal.nodes.push({ ...removed, id: "new" });
  const source = await save("work", a.head, proposal);
  const local = structuredClone(a.scene);
  local.nodes[0]!.sub = "local";
  const head = await save("main", a.head, local);
  const pair = { branch: "main", head, source, sourceBranch: "work" };
  const preview = (await run({ action: "review", ...pair })) as Review;
  expect(preview.base).toBe(a.head);
  expect(preview.conflicts).toEqual([]);
  expect(
    preview.changes
      .filter((c) => c.entity === "节点")
      .map((c) => c.kind)
      .sort(),
  ).toEqual(["added", "modified", "removed"]);
  const accepted = await run({ action: "accept", ...pair });
  const merged = await state();
  expect(merged.scene.nodes[0]).toMatchObject({
    title: "proposal",
    sub: "local",
  });
  const historical = (await run({
    action: "review",
    branch: "main",
    head: accepted.head,
    source,
  })) as Review;
  expect(historical.alreadyMerged).toBe(true);
  expect(historical.comparedTo).toBe(a.head);
  expect(historical.changes.filter((c) => c.entity === "节点")).toHaveLength(3);
  expect(historical.preview).toEqual(proposal);
  expect(merged.history[0]).toMatchObject({ parent: head, merged: source });
  expect(
    (await run({ action: "accept", ...pair, head: accepted.head })).head,
  ).toBe(accepted.head);
  ws.close();
  ws = await openWorkspace(dir);
  expect((await state()).history).toEqual(merged.history);
  await run({ action: "revert", branch: "main", head: accepted.head });
  const reverted = await state();
  expect(reverted.scene).toEqual(local);
  expect(reverted.history[0]?.parent).toBe(accepted.head);
  expect((await state("work")).head).toBe(source);
});

test("two SQLite connections racing the same head publish exactly one snapshot", async () => {
  const a = await state(),
    other = await openWorkspace(dir);
  try {
    const input = {
      action: "save",
      branch: "main",
      head: a.head,
      scene: a.scene,
      title: "concurrent",
    };
    const results = await Promise.allSettled([
      run(input),
      other.service.execute(other.spaceId, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")?.reason).toMatchObject({
      code: "E_REVISION_CONFLICT",
    });
    expect((await state()).history).toHaveLength(2);
  } finally {
    other.close();
  }
});

test("rejects conflicting edits, stale reviewed source, unknown refs and invalid graph without writes", async () => {
  const a = await state();
  await run({ action: "fork", branch: "proposal", from: a.head });
  const left = structuredClone(a.scene),
    right = structuredClone(a.scene);
  left.nodes[0]!.title = "left";
  right.nodes[0]!.title = "right";
  const head = await save("main", a.head, left),
    source = await save("proposal", a.head, right);
  const pair = { branch: "main", head, source, sourceBranch: "proposal" };
  const r = (await run({ action: "review", ...pair })) as Review;
  expect(r.conflicts).toContainEqual({
    path: ["nodes", a.scene.nodes[0]!.id, "title"],
    base: a.scene.nodes[0]!.title,
    current: "left",
    incoming: "right",
  });
  await expect(run({ action: "accept", ...pair })).rejects.toMatchObject({
    code: "E_REVISION_CONFLICT",
  });
  await save("proposal", source, left);
  await expect(run({ action: "accept", ...pair })).rejects.toMatchObject({
    code: "E_REVISION_CONFLICT",
  });
  await expect(state("unknown")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  await expect(
    run({ action: "fork", branch: "has spaces", from: head }),
  ).rejects.toMatchObject({ code: "E_USAGE" });
  await expect(
    save("main", head, { ...left, nodes: [] }),
  ).rejects.toMatchObject({ code: "E_PATCH_INVALID" });
  expect((await state()).head).toBe(head);
});

test("Studio HTTP and MCP share an isolated database and tool scope", async () => {
  const app = await serveStudio(dir, dir, 0);
  const post = async (path: string, body: unknown) =>
    await fetch(new URL(path, app.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify(body),
    });
  const mcp = async (method: string, params: unknown) =>
    (
      await (
        await post("/mcp", { jsonrpc: "2.0", id: 1, method, params })
      ).json()
    ).result;
  const call = (name: string, args: unknown) =>
    mcp("tools/call", { name, arguments: args });
  try {
    const a = (await (
      await post("/api/studio", { action: "state" })
    ).json()) as StudioState;
    const tools = await mcp("tools/list", {});
    expect(tools.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "board_accept",
      "board_fork",
      "board_revert",
      "board_review",
      "board_save",
      "board_state",
    ]);
    expect((await call("board_state", {})).structuredContent.head).toBe(a.head);
    expect(
      (await call("board_fork", { branch: "agent", from: a.head })).isError,
    ).toBe(false);
    const scene = structuredClone(a.scene);
    scene.nodes[0]!.title = "from MCP";
    const saved = await call("board_save", {
      branch: "agent",
      head: a.head,
      scene,
      title: "MCP change",
    });
    expect(saved.isError).toBe(false);
    const history = (await state("agent")).history;
    expect(history[0]?.author).toEqual({ kind: "cli", name: "MCP" });
    const merge = {
      source: saved.structuredContent.head,
      head: a.head,
      branch: "main",
      sourceBranch: "agent",
    };
    expect(
      (await call("board_review", merge)).structuredContent.changes,
    ).toHaveLength(1);
    const accepted = await post("/api/studio", { action: "accept", ...merge });
    expect(accepted.status).toBe(200);
    expect(
      (await post("/api/studio", { action: "accept", ...merge })).status,
    ).toBe(409);
    expect((await state()).scene.nodes[0]?.title).toBe("from MCP");
    expect(
      (
        await call("board_revert", {
          branch: "main",
          head: (await accepted.json()).head,
        })
      ).isError,
    ).toBe(false);
    expect((await state()).scene).toEqual(a.scene);
  } finally {
    await app.stop();
  }
});

test("classic branch deletion leaves Studio refs on their surviving parent", async () => {
  const a = await state(),
    child = await save("main", a.head, a.scene);
  await save("main", child, a.scene);
  const classic = new SqliteStorageAdapter({
    databasePath: join(dir, "studio.sqlite"),
  });
  try {
    await deleteLayerBranch(classic, ws.spaceId, child);
  } finally {
    classic.close();
  }
  expect((await state()).head).toBe(a.head);
});

test("agent replay isolates its changes until accepted and refuses a stale baseline", async () => {
  const a = await state();
  await expect(
    run({ action: "revert", branch: "main", head: a.head }),
  ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
  const replay = await run({ action: "replay", branch: "main", head: a.head });
  expect(replay.branch).toMatch(/^agent-/);
  expect((await state()).head).toBe(a.head);
  expect((await state(replay.branch)).scene.nodes.length).toBe(
    a.scene.nodes.length + 1,
  );
  await save("main", a.head, a.scene);
  await expect(
    run({ action: "replay", branch: "main", head: a.head }),
  ).rejects.toMatchObject({ code: "E_REVISION_CONFLICT" });
});
