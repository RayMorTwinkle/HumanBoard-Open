import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAppService } from "../src/local-app-service";
import { parseCliArgs } from "../src/parser";
import { renderSceneToPNGAsync } from "@humanboard/core-engine";

test("cold PNG rasterization yields to the event loop instead of blocking other requests", async () => {
  let finished = false;
  const rendering = renderSceneToPNGAsync({nodes: [{id: "cjk", kind: "note", title: "中文异步渲染", rect: {x: 100, y: 100, w: 200, h: 80}}], edges: [], strokes: [], assets: []}).then(png => { finished = true; return png; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  const png = await rendering;
  expect(png.subarray(1, 4).toString()).toBe("PNG");
});

test("AST reads and logical diffs do not render; explicit PNGs are reused and renames invalidate them", async () => {
  const root = await mkdtemp(join(tmpdir(), "humanboard-render-behavior-"));
  let stdin = "";
  const service = await LocalAppService.create({
    cwd: root,
    env: { HUMANBOARD_HOME: join(root, "data"), HUMAN_AUTO_TITLE: "0" },
    readStdin: async () => stdin,
    urlSourceValidator: async () => {},
    urlSourceInspector: async () => ({
      title: "old title",
      description: "card",
    }),
  });
  const run = async (argv: string[]) => {
    const parsed = parseCliArgs(argv);
    return (await service.execute(parsed.command, parsed.global)).data as any;
  };
  try {
    await run(["init"]);
    const scope = await run(["status"]);
    const asset = (await service.registerFrontendAsset({
      project_id: scope.project.id,
      space_id: scope.space.id,
      url: "https://example.test/card",
    })) as any;
    stdin = JSON.stringify({
      nodes: [
        {
          id: "n",
          title: "logic",
          kind: "service",
          rect: { x: 100, y: 100, w: 160, h: 80 },
        },
      ],
      edges: [],
      strokes: [],
      assets: [
        {
          asset_id: asset.asset_id,
          display_no: asset.display_no,
          rect: { x: 300, y: 100, w: 300, h: 180 },
          z: 0,
        },
      ],
    });
    await run(["draft", "--stdin"]);
    const committed = await run(["commit", "-m", "logic"]);
    const before = (await readdir(join(root, "data/cache/renders"))).sort();
    const ast = await run([
      "get",
      committed.layer_id,
      "--format",
      "ast",
      "--with-strokes",
    ]);
    expect(ast.ast.nodes).toHaveLength(1);
    expect(ast.render).toBeUndefined();
    const logical = await run(["diff", committed.layer_id]);
    expect(logical.has_strokes).toBe(false);
    expect(logical.visual).toBeUndefined();
    expect((await readdir(join(root, "data/cache/renders"))).sort()).toEqual(
      before,
    );
    const rendered = await run(["get", committed.layer_id, "--format", "both"]);
    const path = fileURLToPath(rendered.render.url);
    const firstWrite = (await stat(path)).mtimeMs;
    await Bun.sleep(15);
    const again = await run(["get", committed.layer_id, "--format", "both"]);
    expect(again.render.url).toBe(rendered.render.url);
    expect((await stat(path)).mtimeMs).toBe(firstWrite);
    const forced = await run(["diff", committed.layer_id, "--visual"]);
    expect(forced.visual.before.url).toBeString();
    const highlightPath = fileURLToPath(forced.visual.highlight.url);
    const diffWrite = (await stat(highlightPath)).mtimeMs;
    await Bun.sleep(15);
    await run(["diff", committed.layer_id, "--visual"]);
    expect((await stat(highlightPath)).mtimeMs).toBe(diffWrite);
    await service.renameAsset(asset.asset_id, "new title");
    const renamed = await run(["get", committed.layer_id, "--format", "both"]);
    expect(renamed.render.url).not.toBe(rendered.render.url);
    stdin = JSON.stringify({
      add_strokes: [
        {
          id: "ink",
          tool: "pen",
          color: "#ff0000",
          width: 3,
          points: [
            [10, 10],
            [20, 20],
          ],
        },
      ],
    });
    await run(["draft", "--parent", committed.layer_id, "--merge", "-"]);
    const annotated = await run(["commit", "-m", "ink"]);
    expect((await run(["diff", annotated.layer_id])).visual).toBeDefined();
    expect(
      (await run(["diff", annotated.layer_id, "--no-visual"])).visual,
    ).toBeUndefined();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
