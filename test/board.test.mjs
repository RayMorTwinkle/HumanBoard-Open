import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.mjs";
import { mergeScenes, scene, starter } from "../src/scene.mjs";

function local(t) {
  const dir = mkdtempSync(join(tmpdir(), "hb-domain-"));
  const b = new Board(dir);
  t.after(() => {
    b.close();
    rmSync(dir, { recursive: true });
  });
  return { b, dir };
}
function edit(b, branch, values) {
  const current = b.state(branch);
  const cards = current.cards.map((item) =>
    item.id === "question" ? { ...item, ...values } : item,
  );
  return b.commit({
    branch,
    base: current.head,
    cards,
    message: "更新问题",
    author: "human",
  }).head;
}

test("分歧字段可同时合入，双亲保留，重复合并幂等，重开数据库可见同一历史", (t) => {
  const { b, dir } = local(t);
  const base = b.head("main");
  b.branch({ name: "proposal", from: base });
  const targetHead = edit(b, "main", { x: 128 });
  const sourceHead = edit(b, "proposal", { title: "新的标题" });
  const args = { target: "main", source: "proposal", targetHead, sourceHead };
  const preview = b.merge({ ...args, preview: true });
  assert.equal(preview.conflicts.length, 0);
  assert.deepEqual(
    preview.changes.map((change) => change.fields),
    [["title"]],
  );
  assert.equal(b.head("main"), targetHead);
  const merged = b.merge(args);
  assert.deepEqual(b.version(merged.head).parents, [targetHead, sourceHead]);
  const card = b
    .version(merged.head)
    .cards.find((item) => item.id === "question");
  assert.equal(card.x, 128);
  assert.equal(card.title, "新的标题");
  assert.equal(b.merge({ ...args, targetHead: merged.head }).unchanged, true);
  const reopened = new Board(dir);
  try {
    assert.deepEqual(reopened.state(), b.state());
  } finally {
    reopened.close();
  }
});
test("相同字段冲突逐项决议；预览后来源变化要求重新审阅", (t) => {
  const { b } = local(t);
  b.branch({ name: "agent", from: b.head("main") });
  const targetHead = edit(b, "main", { title: "人类草案", y: 105 });
  const sourceHead = edit(b, "agent", { title: "代理草案", y: 192 });
  const args = { target: "main", source: "agent", targetHead, sourceHead };
  const oldLength = b.graph().length;
  const preview = b.merge({ ...args, preview: true });
  assert.deepEqual(
    preview.conflicts.map((c) => c.field),
    ["title", "y"],
  );
  assert.throws(() => b.merge(args), { code: "MERGE_CONFLICT" });
  assert.equal(b.graph().length, oldLength);
  const newSource = edit(b, "agent", { title: "修订草案" });
  assert.throws(() => b.merge(args), { code: "STALE_HEAD" });
  const resolutions = [
    { id: "question", field: "title", use: "source" },
    { id: "question", field: "y", use: "target" },
  ];
  const result = b.merge({ ...args, sourceHead: newSource, resolutions });
  const card = b.version(result.head).cards.find((c) => c.id === "question");
  assert.equal(card.title, "修订草案");
  assert.equal(card.y, 105);
});
test("提交基线、重复卡片、非法坐标、重复分支均不可造成部分写入", (t) => {
  const { b } = local(t);
  const original = b.state();
  const head = edit(b, "main", { x: 100 });
  assert.throws(
    () =>
      b.commit({
        branch: "main",
        base: original.head,
        cards: original.cards,
        message: "过期提交",
      }),
    { code: "STALE_HEAD" },
  );
  assert.throws(
    () =>
      b.commit({
        branch: "main",
        base: head,
        cards: [original.cards[0], original.cards[0]],
        message: "重复",
      }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => scene([{ ...starter[0], x: 8.2 }]), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => b.branch({ name: "main", from: head }), {
    code: "BRANCH_EXISTS",
  });
  assert.equal(b.head("main"), head);
  assert.equal(
    b.version(original.head).cards.find((c) => c.id === "question").x,
    74,
  );
});
test("编辑与删除、同 ID 新增均为整卡冲突；单侧删除与快进可重试", (t) => {
  const { b } = local(t);
  const cards = scene([starter[0]]);
  const edited = scene([{ ...starter[0], title: "更改" }]);
  assert.equal(mergeScenes(cards, [], edited).conflicts[0].field, "$card");
  assert.deepEqual(
    mergeScenes(cards, [], edited, [
      { id: "question", field: "$card", use: "target" },
    ]).cards,
    [],
  );
  assert.equal(mergeScenes([], cards, edited).conflicts[0].field, "$card");
  assert.deepEqual(mergeScenes(cards, [], cards).cards, []);
  const base = b.head("main");
  b.branch({ name: "proposal", from: base });
  const child = edit(b, "proposal", { x: 12 });
  assert.equal(
    b.merge({
      target: "main",
      source: "proposal",
      targetHead: base,
      sourceHead: child,
    }).head,
    child,
  );
  assert.equal(b.graph().length, 2);
});
test("交叉合并历史有两个最近基点时拒绝自动合并", (t) => {
  const { b } = local(t);
  const root = b.head("main");
  b.branch({ name: "beta", from: root });
  const a = edit(b, "main", { x: 127 });
  const z = edit(b, "beta", { y: 251 });
  b.branch({ name: "old-a", from: a });
  const m = b.merge({
    target: "main",
    source: "beta",
    targetHead: a,
    sourceHead: z,
  }).head;
  const n = b.merge({
    target: "beta",
    source: "old-a",
    targetHead: z,
    sourceHead: a,
  }).head;
  assert.throws(
    () =>
      b.merge({ target: "main", source: "beta", targetHead: m, sourceHead: n }),
    (error) =>
      error.code === "AMBIGUOUS_BASE" && error.details.bases.length === 2,
  );
});
