import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Board } from "../src/board.mjs";
import { boardServer } from "../src/http.mjs";

async function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "hb-entry-"));
  const board = new Board(dir);
  const server = boardServer(board);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port,
    url = "http://127.0.0.1:" + port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    board.close();
    rmSync(dir, { recursive: true });
  });
  async function api(path, data) {
    const response = await fetch(
      url + path,
      data
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }
        : {},
    );
    return { status: response.status, body: await response.json() };
  }
  return { dir, url, port, api };
}
function rpcClient(dir) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
    {
      env: { ...process.env, HUMANBOARD_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let requestId = 0;
  function write(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  async function rpc(method, params) {
    const id = ++requestId;
    write({ id, method, params });
    const line = await lines.next();
    assert.equal(line.done, false);
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    return response;
  }
  const close = async () => {
    const stop = once(child, "exit");
    child.stdin.end();
    await stop;
  };
  return { rpc, write, close };
}

test("浏览器资源、HTTP 演练、只读主分支与本机访问边界", async (t) => {
  const { url, port, api } = await workspace(t);
  for (const path of ["/", "/app.css", "/app.js"])
    assert.equal((await fetch(url + path)).status, 200);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { origin: "https://example.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(url + "/api/branch", { method: "POST", body: "x" })).status,
    415,
  );
  assert.equal(
    (await api("/api/commit", { message: "x".repeat(600_000) })).status,
    413,
  );
  const before = (await api("/api/state")).body;
  const run = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("../scripts/demo.mjs", import.meta.url))],
    { env: { ...process.env, PORT: String(port) } },
  );
  const demo = JSON.parse(run.stdout);
  const after = (await api("/api/state")).body;
  assert.equal(after.head, before.head);
  assert.equal(after.branches.length, 2);
  assert.equal(demo.changes.length, 1);
  assert.equal(demo.changes[0].kind, "added");
  const state = (await api("/api/state?branch=" + demo.branch)).body;
  assert.equal(state.cards.length, before.cards.length + 1);
});

test("stdio 协商与工具发现；HTTP 和 MCP 争用同一基线时恰有一次成功", async (t) => {
  const { dir, api } = await workspace(t);
  const client = rpcClient(dir);
  try {
    const pre = await client.rpc("tools/list", {});
    assert.equal(pre.error.code, -32002);
    const init = await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-test", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    client.write({ method: "notifications/initialized" });
    const tools = await client.rpc("tools/list", {});
    assert.ok(tools.result.tools.some((tool) => tool.name === "board_merge"));
    const stateCall = await client.rpc("tools/call", {
      name: "board_state",
      arguments: {},
    });
    const state = JSON.parse(stateCall.result.content[0].text);
    const changes = {
      branch: "main",
      base: state.head,
      cards: state.cards.map((card) => ({ ...card, y: 80 })),
      message: "调整布局",
    };
    const [http, mcp] = await Promise.all([
      api("/api/commit", changes),
      client.rpc("tools/call", {
        name: "board_commit",
        arguments: {
          ...changes,
          cards: state.cards.map((card) => ({ ...card, title: "重新命名" })),
        },
      }),
    ]);
    const agent = JSON.parse(mcp.result.content[0].text);
    assert.equal([agent, http.body].filter((result) => result.head).length, 1);
    assert.equal(
      [agent, http.body].filter((result) => result.code === "STALE_HEAD")
        .length,
      1,
    );
    const after = (await api("/api/state")).body;
    assert.equal(after.history.length, 2);
    assert.deepEqual(after.history[0].parents, [state.head]);
    const compared = await client.rpc("tools/call", {
      name: "board_diff",
      arguments: { from: state.head, to: after.head },
    });
    assert.equal(
      JSON.parse(compared.result.content[0].text).length,
      state.cards.length,
    );
  } finally {
    await client.close();
  }
});

test(
  "绝对路径含目录符号链接时也启动本地 HTTP 服务",
  { timeout: 8000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-start-"));
    const linked = join(dir, "linked-repo");
    symlinkSync(fileURLToPath(new URL("../", import.meta.url)), linked, "dir");
    const child = spawn(process.execPath, [join(linked, "src/server.mjs")], {
      cwd: dir,
      env: { ...process.env, PORT: "0", HUMANBOARD_DIR: join(dir, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    try {
      const lines = createInterface({ input: child.stdout });
      let url;
      for await (const line of lines) {
        url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) break;
      }
      assert.ok(url, "服务应在退出前输出本机监听地址");
      const response = await fetch(url + "/api/state");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).branch, "main");
    } finally {
      child.kill();
      await exited;
      rmSync(dir, { recursive: true });
    }
  },
);
