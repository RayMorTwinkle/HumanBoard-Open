import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServerApp } from "@humanboard/server-self-hosted";
import { CommitEventBus } from "../src/commit-event-bus";
import { LocalAppService } from "../src/local-app-service";
import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";
import { findProjectBinding } from "../src/config";
import { runCli } from "../src/main";

const directories: string[] = [],
  runtimes: ServerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
function request(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method,
    headers: {
      Host: new URL(url).host,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-HumanBoard-Client": "1" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const baseOptions = () => ({
  cacheDir: "/private/tmp",
  execute: async () => ({ exitCode: 0, data: { ok: true } }),
  events: new CommitEventBus(),
});
test("requires Bearer or a valid HttpOnly login cookie when configured", async () => {
  const app = createServerApp({
    ...baseOptions(),
    authToken: "test-access-token",
  });
  expect(
    (await app.fetch(request("http://127.0.0.1:4317/health"))).status,
  ).toBe(401);
  expect(
    (
      await app.fetch(
        request("http://127.0.0.1:4317/api/auth", "POST", { token: "wrong" }),
      )
    ).status,
  ).toBe(401);
  const login = await app.fetch(
    request("http://127.0.0.1:4317/api/auth", "POST", {
      token: "test-access-token",
    }),
  );
  const cookie = login.headers.get("set-cookie")!;
  expect(login.status).toBe(200);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).not.toContain("test-access-token");
  expect(
    (
      await app.fetch(
        request("http://127.0.0.1:4317/health", "GET", undefined, {
          Cookie: cookie.split(";")[0]!,
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.fetch(
        request("http://127.0.0.1:4317/health", "GET", undefined, {
          Authorization: "Bearer test-access-token",
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.fetch(
        request("http://127.0.0.1:4317/health", "GET", undefined, {
          Cookie: `hb_session=${"g".repeat(64)}`,
        }),
      )
    ).status,
  ).toBe(401);
});
test("rejects unsafe external serving and accepts HTTPS proxy hosts with authentication", async () => {
  expect(() =>
    createServerApp({ ...baseOptions(), host: "0.0.0.0" }),
  ).toThrow();
  const app = createServerApp({
    ...baseOptions(),
    host: "0.0.0.0",
    authToken: "remote-token",
    publicUrl: "https://board.example.test",
  });
  expect(
    (
      await app.fetch(
        request("https://board.example.test/health", "GET", undefined, {
          Authorization: "Bearer remote-token",
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.fetch(
        request("https://evil.example.test/health", "GET", undefined, {
          Authorization: "Bearer remote-token",
        }),
      )
    ).status,
  ).toBe(403);
});
test("skips a data directory named .humanboard when searching for project binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-binding-dir-"));
  directories.push(root);
  await mkdir(join(root, ".humanboard"));
  await mkdir(join(root, "project"));
  expect(await findProjectBinding(join(root, "project"))).toBeNull();
});
test("connected CLI commits through the running service and publishes one event", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-delivery-cli-"));
  directories.push(root);
  const env = { HUMANBOARD_HOME: join(root, "data") };
  const local = await LocalAppService.create({ cwd: root, env });
  await local.execute({ kind: "init", injectSkill: false }, { output: "json" });
  local.close();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd: root,
    env,
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  let events = 0;
  runtime.events.subscribe(() => events++, { all: true });
  const cliEnv = {
    HUMANBOARD_HOME: join(root, "client-without-database"),
    HUMANBOARD_SERVER_URL: runtime.url,
  };
  const output: string[] = [];
  expect(
    await runCli(["draft", "--json"], {
      cwd: root,
      env: cliEnv,
      stdout: (s) => output.push(s),
    }),
  ).toBe(0);
  expect(
    await runCli(["commit", "-m", "connected CLI", "--json"], {
      cwd: root,
      env: cliEnv,
      stdout: (s) => output.push(s),
    }),
  ).toBe(0);
  expect(events).toBe(1);
  expect(JSON.parse(output.at(-1)!).title).toBe("connected CLI");
  // Browser writes use a separate draft session and are classified as human.
  const post = async (argv: string[]) => {
    const r = await fetch(`${runtime.url}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({
        argv: [...argv, "--json"],
        session_id: "browser-regression",
      }),
    });
    return (await r.json()) as { exitCode: number; data: any };
  };
  let human = 0;
  runtime.events.subscribe(() => human++);
  await post(["draft"]);
  const committed = await post(["commit", "-m", "human save"]);
  expect(committed.exitCode).toBe(0);
  expect(human).toBe(1);
  expect(events).toBe(2);
});

test("watch replays persisted commits from before the service process started", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-replay-"));
  directories.push(root);
  const env = { HUMANBOARD_HOME: join(root, "data") };
  const local = await LocalAppService.create({ cwd: root, env });
  const init = await local.execute(
    { kind: "init", injectSkill: false },
    { output: "json" },
  );
  await local.execute(
    {
      kind: "draft",
      action: "create",
      redo: false,
      transform: false,
      input: { kind: "none" },
    },
    { output: "json" },
  );
  const committed = await local.execute(
    { kind: "commit", message: "before server restart" },
    { output: "json" },
  );
  local.close();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd: root,
    env,
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  const response = await fetch(
    `${runtime.url}/api/watch?since=L1&all=true&timeout=1`,
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  const event = JSON.parse(
    new TextDecoder().decode(first.value).trim().split("\n")[0]!,
  );
  expect(event.layer_id).toBe(
    (committed.data as { layer_id: string }).layer_id,
  );
  expect(event.title).toBe("before server restart");
});

test("auto-discovery never routes a different data directory into the running server", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-instance-server-"));
  const clientRoot = await mkdtemp(
    join(tmpdir(), "humanboard-instance-client-"),
  );
  directories.push(root, clientRoot);
  const env = { HUMANBOARD_HOME: join(root, "data") };
  const local = await LocalAppService.create({ cwd: root, env });
  const initialized = await local.execute(
    { kind: "init", injectSkill: false },
    { output: "json" },
  );
  local.close();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd: root,
    env,
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  const clientEnv = {
    HUMANBOARD_HOME: join(clientRoot, "data"),
    HUMANBOARD_PORT: String(port),
  };
  const output: string[] = [];
  expect(
    await runCli(["init", "--json"], {
      cwd: clientRoot,
      env: clientEnv,
      stdout: (s) => output.push(s),
    }),
  ).toBe(0);
  expect(JSON.parse(output[0]!).project_id).not.toBe(
    (initialized.data as { project_id: string }).project_id,
  );
  const server = await runtime.pool.getDefault();
  const status = await server.execute({ kind: "status" }, { output: "json" });
  expect((status.data as { project: { id: string } }).project.id).toBe(
    (initialized.data as { project_id: string }).project_id,
  );
});
