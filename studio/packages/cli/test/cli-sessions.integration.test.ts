import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAppService } from "../src/local-app-service";
import { createServerRuntime, type ServerRuntime } from "../src/server-runtime";
const roots: string[] = [],
  runtimes: ServerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
test("independent connected CLI agents retain their own drafts and author while web saves remain human", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-cli-sessions-"));
  roots.push(root);
  const cwd = join(root, "server");
  await mkdir(cwd);
  const env = { HUMANBOARD_HOME: join(root, "data"), HUMAN_AUTO_TITLE: "off" };
  const service = await LocalAppService.create({ cwd, env });
  await service.execute(
    { kind: "init", injectSkill: false },
    { output: "json" },
  );
  service.close();
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port!;
  await probe.stop(true);
  const runtime = await createServerRuntime({
    cwd,
    env,
    host: "127.0.0.1",
    port,
  });
  runtimes.push(runtime);
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const clientEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) =>
        v !== undefined && !/^HUMAN_/.test(k) && !/^HUMANBOARD_/.test(k),
    ),
  ) as Record<string, string>;
  async function cli(session: string, args: string[]) {
    const p = Bun.spawn([process.execPath, entry, ...args, "--json"], {
      cwd,
      env: {
        ...clientEnv,
        HUMANBOARD_HOME: join(root, "client"),
        HUMANBOARD_SESSION: session,
        HUMANBOARD_SERVER_URL: runtime.url,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return {
      code,
      data: stdout ? JSON.parse(stdout) : null,
      error: stderr ? JSON.parse(stderr) : null,
    };
  }
  for (const id of ["a", "b"])
    await writeFile(
      join(root, id + ".json"),
      JSON.stringify({
        upsert_nodes: [
          {
            id,
            kind: "note",
            title: "Agent " + id,
            rect: { x: 50, y: 50, w: 180, h: 70 },
          },
        ],
      }),
    );
  const a = await cli("agent:a", ["draft", "--merge", join(root, "a.json")]);
  const b = await cli("agent:b", ["draft", "--merge", join(root, "b.json")]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const ownA = await cli("agent:a", ["draft", "--show"]);
  expect(ownA.data.id).toBe(a.data.draft_id);
  expect(ownA.data.scene.nodes.map((n: { id: string }) => n.id)).toEqual(["a"]);
  const stolen = await cli("agent:b", [
    "commit",
    a.data.draft_id,
    "-m",
    "wrong session",
  ]);
  expect(stolen.code).not.toBe(0);
  const ca = await cli("agent:a", ["commit", "-m", "A own plan"]);
  expect(ca.code).toBe(0);
  const ownB = await cli("agent:b", ["draft", "--show"]);
  expect(ownB.data.id).toBe(b.data.draft_id);
  const cb = await cli("agent:b", ["commit", "-m", "B own plan"]);
  expect(cb.code).toBe(0);
  const ga = await cli("agent:a", ["get", ca.data.layer_id, "--format", "ast"]);
  expect(ga.data.ast.nodes.map((n: { id: string }) => n.id)).toEqual(["a"]);
  expect(ga.data.layer.author.kind).toBe("cli");
  const gb = await cli("agent:b", ["get", cb.data.layer_id, "--format", "ast"]);
  expect(gb.data.ast.nodes.map((n: { id: string }) => n.id)).toEqual(["b"]);
  const web = async (argv: string[], stdin?: string) =>
    fetch(runtime.url + "/api/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HumanBoard-Client": "1",
      },
      body: JSON.stringify({ session_id: "browser-regression", argv, stdin }),
    }).then((r) => r.json());
  const wd = await web(
    ["draft", "--merge", "-"],
    JSON.stringify({
      upsert_nodes: [
        {
          id: "human",
          kind: "note",
          title: "Human",
          rect: { x: 10, y: 10, w: 160, h: 60 },
        },
      ],
    }),
  );
  expect(wd.exitCode).toBe(0);
  const wc = await web(["commit", "-m", "Human own edit"]);
  expect(wc.exitCode).toBe(0);
  const wg = await web(["get", wc.data.layer_id, "--format", "ast"]);
  expect(wg.data.layer.author.kind).toBe("human");
}, 15000);
