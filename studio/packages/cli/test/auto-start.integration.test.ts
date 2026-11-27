import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAppService } from "../src/local-app-service";
import { resolveRuntimePaths, runtimeInstanceId } from "../src/config";
import {
  readLocalServerState,
  writeLocalServerState,
  processIsAlive,
} from "../../application-service/src/local-server-state";
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
interface Fixture {
  root: string;
  cwd: string;
  home: string;
  env: Record<string, string>;
  paths: ReturnType<typeof resolveRuntimePaths>;
}
const fixtures: Fixture[] = [],
  servers: ReturnType<typeof Bun.serve>[] = [];
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-auto-start-")),
    cwd = join(root, "workspace"),
    home = join(root, "data");
  await mkdir(cwd);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (v): v is [string, string] => v[1] !== undefined,
      ),
    ),
    HUMANBOARD_HOME: home,
    HUMANBOARD_DB: join(home, "humanboard.sqlite"),
    HUMANBOARD_BLOBS: join(home, "blobs"),
    HUMANBOARD_CACHE: join(home, "cache"),
    HUMANBOARD_PORT: "",
    HUMANBOARD_SESSION: "auto-start-test",
    HUMAN_AUTO_TITLE: "off",
    HUMANBOARD_NO_AUTO_START: "",
    HUMANBOARD_SERVER_URL: "",
  };
  const service = await LocalAppService.create({ cwd, env });
  await service.execute(
    { kind: "init", injectSkill: false },
    { output: "json" },
  );
  service.close();
  const value = { root, cwd, home, env, paths: resolveRuntimePaths(env, cwd) };
  fixtures.push(value);
  return value;
}
async function run(
  f: Fixture,
  argv: string[] = ["status", "--json"],
  extra: Record<string, string> = {},
) {
  const child = Bun.spawn([process.execPath, entry, ...argv], {
    cwd: f.cwd,
    env: { ...f.env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const state = await readLocalServerState(f.paths);
    if (state && state.pid !== process.pid && processIsAlive(state.pid)) {
      process.kill(state.pid, "SIGINT");
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && (await readLocalServerState(f.paths)))
        await Bun.sleep(30);
    }
    await rm(f.root, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

test("concurrent cold CLI status starts one detached server and reuses it after both CLIs exit", async () => {
  const f = await fixture();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  f.env.HUMANBOARD_PORT = String(port);
  const results = await Promise.all([run(f), run(f)]);
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).space.name).toBe("main");
  }
  const state = await readLocalServerState(f.paths);
  expect(state).not.toBeNull();
  expect(state!.instance_id).toBe(runtimeInstanceId(f.paths));
  expect(processIsAlive(state!.pid)).toBe(true);
  const health = await fetch(new URL("/health", state!.url)).then((r) =>
    r.json(),
  );
  expect(health.instance_id).toBe(state!.instance_id);
  expect((await run(f)).code).toBe(0);
  expect((await readLocalServerState(f.paths))!.pid).toBe(state!.pid);
  expect(
    (await readFile(join(f.home, "server.log"), "utf8")).match(
      /HumanBoard listening/g,
    ),
  ).toHaveLength(1);
}, 20000);

test("a stale discovery record cannot route commands into a different data directory", async () => {
  const f = await fixture(),
    requests: string[] = [];
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({
        ok: true,
        service: "humanboard",
        instance_id: "different-data-directory",
      });
    },
  });
  servers.push(foreign);
  await writeLocalServerState(
    f.paths,
    `http://127.0.0.1:${foreign.port}`,
    1073741823,
  );
  const result = await run(f);
  expect(result.code).toBe(0);
  const current = await readLocalServerState(f.paths);
  expect(current!.url).not.toBe(`http://127.0.0.1:${foreign.port}/`);
  expect(current!.instance_id).toBe(runtimeInstanceId(f.paths));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((path) => path === "/health")).toBe(true);
}, 20000);

test("explicit remote outage does not create a replacement local server", async () => {
  const f = await fixture();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const result = await run(f, ["status", "--json"], {
    HUMANBOARD_SERVER_URL: `http://127.0.0.1:${port}`,
  });
  expect(result.code).toBe(6);
  expect(JSON.parse(result.stderr).error.code).toBe("E_CONNECT");
  expect(await readLocalServerState(f.paths)).toBeNull();
});

test("a requested occupied port is preserved and dead startup locks can be recovered", async () => {
  const f = await fixture();
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        ok: true,
        service: "humanboard",
        instance_id: "foreign",
      }),
  });
  servers.push(foreign);
  const result = await run(f, ["status", "--json"], {
    HUMANBOARD_PORT: String(foreign.port),
  });
  expect(result.code).toBe(6);
  expect(JSON.parse(result.stderr).error.message).toContain("already occupied");
  expect(await readLocalServerState(f.paths)).toBeNull();
  await writeFile(
    join(f.home, "server-start.lock"),
    JSON.stringify({ pid: 1073741823 }),
  );
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  expect(
    (await run(f, ["status", "--json"], { HUMANBOARD_PORT: String(port) }))
      .code,
  ).toBe(0);
  expect((await fetch(`http://127.0.0.1:${foreign.port}/health`)).status).toBe(
    200,
  );
}, 20000);

test("discovery treats a symbolic-link data directory as the same existing database", async () => {
  const f = await fixture(),
    realHome = await realpath(f.home),
    alias = join(f.root, "data-alias");
  await symlink(
    realHome,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const realPaths = resolveRuntimePaths(
    {
      ...f.env,
      HUMANBOARD_HOME: realHome,
      HUMANBOARD_DB: join(realHome, "humanboard.sqlite"),
    },
    f.cwd,
  );
  const aliasPaths = resolveRuntimePaths(
    {
      ...f.env,
      HUMANBOARD_HOME: alias,
      HUMANBOARD_DB: join(alias, "humanboard.sqlite"),
    },
    f.cwd,
  );
  expect(runtimeInstanceId(aliasPaths)).toBe(runtimeInstanceId(realPaths));
  const futureReal = {
    ...realPaths,
    database: join(realHome, "future.sqlite"),
  };
  const futureAlias = { ...aliasPaths, database: join(alias, "future.sqlite") };
  const futureId = runtimeInstanceId(futureReal);
  expect(runtimeInstanceId(futureAlias)).toBe(futureId);
  await writeFile(futureReal.database, "");
  expect(runtimeInstanceId(futureAlias)).toBe(futureId);
  await writeLocalServerState(realPaths, "http://127.0.0.1:43219", process.pid);
  expect((await readLocalServerState(aliasPaths))?.instance_id).toBe(
    runtimeInstanceId(realPaths),
  );
});

test("serve --stop stops the verified owned daemon without starting a replacement", async () => {
  const f = await fixture();
  expect((await run(f)).code).toBe(0);
  const state = await readLocalServerState(f.paths);
  expect(state).not.toBeNull();
  const stopped = await run(f, ["serve", "--stop", "--json"]);
  expect(stopped.code).toBe(0);
  expect(JSON.parse(stopped.stdout).stopped).toBe(true);
  expect(await readLocalServerState(f.paths)).toBeNull();
  const again = await run(f, ["serve", "--stop", "--json"]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).stopped).toBe(false);
  expect(await readLocalServerState(f.paths)).toBeNull();
}, 20000);

test("serve --stop never signals a process whose endpoint fingerprint differs", async () => {
  const f = await fixture();
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        ok: true,
        service: "humanboard",
        instance_id: "foreign",
      }),
  });
  servers.push(foreign);
  const dummy = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    { cwd: f.cwd, env: f.env, stdout: "ignore", stderr: "ignore" },
  );
  try {
    await writeLocalServerState(
      f.paths,
      `http://127.0.0.1:${foreign.port}`,
      dummy.pid,
    );
    const result = await run(f, ["serve", "--stop", "--json"]);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.stderr).error.message).toContain(
      "no process was signalled",
    );
    expect(dummy.exitCode).toBeNull();
  } finally {
    dummy.kill();
    await dummy.exited;
  }
});
