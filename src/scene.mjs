export const colors = ["jade", "lavender", "amber", "coral"];
export const fields = ["title", "body", "color", "x", "y"];

export class BoardError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function invalid(message) {
  throw new BoardError(400, "INVALID_INPUT", message);
}

export function identifier(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value)
  ) {
    invalid(
      "标识符须以字母或数字开头，仅允许字母、数字、下划线与短横线，最多 48 个字符。",
    );
  }
  return value;
}

export function shortText(value, limit, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!allowEmpty && !value.trim())
  ) {
    invalid(
      `文本须为字符串，长度不超过 ${limit}，${allowEmpty ? "允许" : "不允许"}空白。`,
    );
  }
  return value;
}

export function card(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("卡片格式无效。");
  const id = identifier(input.id);
  const title = shortText(input.title, 80);
  const body = shortText(input.body, 600, true);
  if (!colors.includes(input.color)) invalid("卡片颜色无效。");
  for (const [key, max] of [
    ["x", 800],
    ["y", 436],
  ]) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > max)
      invalid(`卡片坐标 ${key} 超出范围。`);
  }
  return { id, title, body, color: input.color, x: input.x, y: input.y };
}

export function scene(cards) {
  if (!Array.isArray(cards) || cards.length > 150)
    invalid("每张画板最多容纳 150 张卡片。");
  const unique = new Map();
  for (const raw of cards) {
    const item = card(raw);
    if (unique.has(item.id)) invalid("卡片标识重复。");
    unique.set(item.id, item);
  }
  return [...unique.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export const starter = [
  {
    id: "question",
    title: "记录现场",
    body: "人和 Agent 如何在同一幅画布上留下各自的判断？",
    color: "jade",
    x: 74,
    y: 92,
  },
  {
    id: "proposal",
    title: "分支提案",
    body: "从当前版本分出一条线，尝试新的布局和文案。",
    color: "lavender",
    x: 389,
    y: 171,
  },
  {
    id: "review",
    title: "一起审阅",
    body: "回到共同起点，逐项核对哪些变化值得合入。",
    color: "amber",
    x: 687,
    y: 305,
  },
];

const byId = (cards) => new Map(cards.map((item) => [item.id, item]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function diff(before, after) {
  const base = byId(before);
  const target = byId(after);
  const changes = [];
  for (const id of new Set([...base.keys(), ...target.keys()])) {
    const old = base.get(id);
    const next = target.get(id);
    if (!old || !next)
      changes.push({
        id,
        kind: old ? "removed" : "added",
        before: old ?? null,
        after: next ?? null,
      });
    else {
      const changed = fields.filter((key) => old[key] !== next[key]);
      if (changed.length)
        changes.push({
          id,
          kind: "edited",
          fields: changed,
          before: old,
          after: next,
        });
    }
  }
  return changes;
}

export function mergeScenes(ancestor, target, source, resolutions = []) {
  if (!Array.isArray(resolutions)) invalid("冲突选择须为列表。");
  const choices = new Map();
  for (const resolution of resolutions) {
    if (!resolution || !["target", "source"].includes(resolution.use))
      invalid("冲突选择须为 target 或 source。");
    const id = identifier(resolution.id);
    if (![...fields, "$card"].includes(resolution.field))
      invalid("冲突字段无效。");
    const key = id + "." + resolution.field;
    if (choices.has(key)) invalid("冲突选择重复。");
    choices.set(key, resolution.use);
  }
  const maps = [ancestor, target, source].map(byId);
  const conflicts = [];
  function choose(id, field, base, ours, theirs) {
    if (same(ours, theirs) || same(base, theirs)) return ours;
    if (same(base, ours)) return theirs;
    const key = id + "." + field;
    const choice = choices.get(key);
    choices.delete(key);
    if (choice) return choice === "target" ? ours : theirs;
    conflicts.push({
      id,
      field,
      base: base ?? null,
      target: ours ?? null,
      source: theirs ?? null,
    });
    return ours;
  }
  const merged = [];
  for (const id of new Set(maps.flatMap((map) => [...map.keys()]))) {
    const [base, ours, theirs] = maps.map((map) => map.get(id));
    if (base && ours && theirs) {
      const result = { id };
      for (const field of fields)
        result[field] = choose(
          id,
          field,
          base[field],
          ours[field],
          theirs[field],
        );
      merged.push(result);
    } else {
      const result = choose(id, "$card", base, ours, theirs);
      if (result) merged.push(result);
    }
  }
  if (choices.size) invalid("选择包含当前版本中不存在的冲突。");
  return { cards: scene(merged), conflicts };
}
