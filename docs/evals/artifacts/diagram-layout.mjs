// bun --no-env-file diagram-layout.mjs <backup diagram.ts> <candidate diagram.ts>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate)
  throw new Error("Pass both source paths (backup first)");
const warmups = 2,
  rounds = 10;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashValue = (value) => digest(JSON.stringify(value));

async function loadArm(source) {
  const entry = resolve(source);
  const files = {};
  for (const name of [
    "diagram.ts",
    "defaults.ts",
    "text-layout.ts",
    "schema.ts",
  ]) {
    files[name] = digest(await readFile(join(dirname(entry), name)));
  }
  const fromArm = createRequire(entry);
  return {
    compile: (await import(pathToFileURL(entry).href)).compileDiagram,
    metadata: { files_sha256: files, zod: fromArm("zod/package.json").version },
  };
}

const arms = {
  backup: await loadArm(baseline),
  refactor: await loadArm(candidate),
};
assert.equal(arms.backup.metadata.zod, arms.refactor.metadata.zod);
const node = (i) => ({ id: "n" + i, title: "步骤 " + i });
function tree(size, parentIndex, layout) {
  return {
    mode: "mindmap",
    layout,
    nodes: Array.from({ length: size }, (_, i) =>
      i ? { ...node(i), parent: node(parentIndex(i)).id } : node(i),
    ),
  };
}
function reverseEdges(size) {
  return {
    mode: "logic",
    layout: "right",
    nodes: Array.from({ length: size }, (_, i) => node(i)),
    edges: Array.from({ length: size - 1 }, (_, i) => ({
      id: "e" + i,
      from: node(i).id,
      to: node(i + 1).id,
    })).reverse(),
  };
}

const edit = tree(120, (i) => Math.floor((i - 1) / 3), "bilateral");
const previous = edit.nodes.slice(0, 119).map((n, i) => ({
  id: n.id,
  title: n.title,
  kind: "note",
  style: { shape: "rounded" },
  rect: {
    x: Math.floor(i / 10) * 340 - 80,
    y: (i % 10) * 140 + 30,
    w: 220,
    h: 64,
  },
}));
edit.nodes[1].sub = "这里增加一段说明，已有节点上仍保留手写标记的位置";
const fixtures = [
  {
    name: "mindmap-small-12",
    diagram: tree(12, (i) => Math.floor((i - 1) / 3), "right"),
  },
  { name: "mindmap-chain-500", diagram: tree(500, (i) => i - 1, "right") },
  { name: "logic-reverse-edges-500", diagram: reverseEdges(500) },
  { name: "mindmap-pinned-edit-120", diagram: edit, previous },
];

// The compatibility corpus exercises non-tree edges, shared successors, all
// layouts, unsorted parents, custom colors, tied orders, pins and rejection paths.
function corpus() {
  const cases = [];
  let state = 0x1126;
  const random = (limit) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
  for (let i = 0; i < 60; i++) {
    const size = 6 + random(26);
    let diagram;
    if (i % 2 === 0) {
      const layout = ["right", "down", "bilateral"][(i / 2) % 3];
      diagram = tree(size, (j) => random(j), layout);
      for (const n of diagram.nodes) {
        if (!random(3)) n.order = random(6);
        if (!random(5)) n.color = "rose";
        if (!random(4)) n.parentLabel = "分支";
      }
    } else {
      diagram = reverseEdges(size);
      diagram.layout = i % 4 === 1 ? "down" : "right";
      for (let j = 0; j < size; j++)
        diagram.edges.push({
          id: "extra" + j,
          from: node(random(size)).id,
          to: node(random(size)).id,
          label: "复核",
          dashed: !random(2),
        });
    }
    for (let j = size - 1; j > 0; j--) {
      const k = random(j + 1);
      [diagram.nodes[j], diagram.nodes[k]] = [
        diagram.nodes[k],
        diagram.nodes[j],
      ];
    }
    cases.push({ name: "seed1126-" + i, diagram });
  }
  cases.push({ name: "pin-preservation", diagram: edit, previous });
  const root = node(0);
  const invalid = (name, diagram, error) =>
    cases.push({ name, diagram, error });
  invalid(
    "dangling-parent",
    { mode: "mindmap", nodes: [root, { ...node(1), parent: "none" }] },
    "Unknown parent none",
  );
  invalid(
    "detached-cycle",
    {
      mode: "mindmap",
      nodes: [root, { ...node(1), parent: "n2" }, { ...node(2), parent: "n1" }],
    },
    "Mindmap parent cycle",
  );
  invalid(
    "duplicate-node",
    { mode: "logic", nodes: [root, root] },
    "Duplicate node id",
  );
  invalid(
    "duplicate-edge",
    {
      mode: "logic",
      nodes: [root],
      edges: Array(2).fill({ id: "e", from: "n0", to: "n0" }),
    },
    "Duplicate edge id",
  );
  invalid(
    "unknown-endpoint",
    {
      mode: "logic",
      nodes: [root],
      edges: [{ id: "e", from: "n0", to: "none" }],
    },
    "Unknown edge endpoint e",
  );
  invalid(
    "invalid-direction",
    { mode: "logic", layout: "bilateral", nodes: [root] },
    "Logic diagrams support right or down layout",
  );
  return cases;
}
function run(compile, fixture) {
  if (fixture.error) {
    assert.throws(() => compile(fixture.diagram, fixture.previous), {
      message: fixture.error,
    });
    return { rejected: fixture.error };
  }
  return compile(fixture.diagram, fixture.previous);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = sorted.length / 2;
  return (sorted[i - 1] + sorted[i]) / 2;
}

const compatibility = corpus().map((fixture) => {
  const before = run(arms.backup.compile, fixture);
  const after = run(arms.refactor.compile, fixture);
  assert.deepEqual(after, before, fixture.name);
  return {
    name: fixture.name,
    input_sha256: hashValue(fixture),
    output_sha256: hashValue(after),
  };
});
const measurements = [];
for (const fixture of fixtures) {
  const results = { backup: [], refactor: [] };
  const outputs = {};
  for (let round = -warmups; round < rounds; round++) {
    const order =
      round % 2 === 0 ? ["backup", "refactor"] : ["refactor", "backup"];
    for (const name of order) {
      const start = performance.now();
      const scene = run(arms[name].compile, fixture);
      const elapsed = performance.now() - start;
      const hash = hashValue(scene); // Outside the timed region.
      assert.equal(
        hash,
        outputs[name] ?? hash,
        "Non-deterministic output: " + fixture.name,
      );
      outputs[name] = hash;
      if (round >= 0) results[name].push(elapsed);
    }
  }
  assert.equal(outputs.backup, outputs.refactor, fixture.name);
  measurements.push({
    fixture: fixture.name,
    input_sha256: hashValue(fixture),
    nodes: fixture.diagram.nodes.length,
    output_sha256: outputs,
    samples_ms: results,
    median_ms: {
      backup: median(results.backup),
      refactor: median(results.refactor),
    },
  });
}
console.log(
  JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      runtime: "bun " + Bun.version,
      platform: os.platform(),
      arch: os.arch(),
      os_release: os.release(),
      cpu: os.cpus()[0]?.model,
      metric:
        "compileDiagram wall time (ms); hash, fixture generation and module imports excluded",
      order: "same process; alternating AB and BA for each fixture",
      warmups,
      rounds,
      arms: Object.fromEntries(
        Object.entries(arms).map(([name, arm]) => [
          name,
          {
            ...arm.metadata,
            source_label:
              (name === "backup" ? process.argv[4] : process.argv[5]) ?? name,
          },
        ]),
      ),
      measurements,
      compatibility,
    },
    null,
    2,
  ),
);
