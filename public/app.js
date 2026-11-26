const $ = (id) => document.getElementById(id);
const make = (tag, text) =>
  Object.assign(
    document.createElement(tag),
    text === undefined ? {} : { textContent: text },
  );
const fieldNames = {
  title: "标题",
  body: "内容",
  color: "颜色",
  x: "横坐标",
  y: "纵坐标",
  $card: "整张卡片",
};
const colorNames = {
  jade: "苔绿",
  lavender: "藤紫",
  amber: "麦黄",
  coral: "陶红",
};
let branch = new URLSearchParams(location.search).get("branch") || "main";
let state,
  cards = [],
  base,
  inspected = null,
  selected = null,
  stale = false,
  busy = false,
  scale = 1;
let notice = "",
  dragging = false,
  pollTicket = 0;
const dirty = () =>
  state &&
  !inspected &&
  JSON.stringify(cards) !== JSON.stringify(originalCards);
let originalCards = [];
const activeCard = () => cards.find((card) => card.id === selected);
const draftKey = (name) => "humanboard.draft." + name;
const clone = (value) => structuredClone(value);
async function api(path, data) {
  const res = await fetch(
    "/api/" + path,
    data
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  const value = await res.json();
  if (!res.ok) throw Object.assign(new Error(value.message), value);
  return value;
}
function restoreDraft() {
  try {
    const raw = sessionStorage.getItem(draftKey(branch));
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (
      !state.history.some((v) => v.id === saved.base) ||
      !Array.isArray(saved.cards) ||
      !Array.isArray(saved.original)
    )
      return;
    base = saved.base;
    cards = saved.cards;
    originalCards = saved.original;
    stale = base !== state.head;
    notice = "已恢复此标签页的草稿。";
  } catch {
    /* A disabled browser store still allows in-memory editing. */
  }
}
function remember() {
  if (inspected) return;
  try {
    if (dirty())
      sessionStorage.setItem(
        draftKey(branch),
        JSON.stringify({ base, cards, original: originalCards }),
      );
    else sessionStorage.removeItem(draftKey(branch));
  } catch {
    notice = "浏览器暂时无法保留草稿，请及时提交。";
  }
}
async function loadBranch(name) {
  const next = await api("state?branch=" + encodeURIComponent(name));
  state = next;
  branch = name;
  base = next.head;
  inspected = null;
  selected = null;
  stale = false;
  notice = "";
  originalCards = clone(next.cards);
  cards = clone(next.cards);
  restoreDraft();
  const url = new URL(location.href);
  url.searchParams.set("branch", branch);
  history.replaceState(null, "", url);
  render();
}
function status() {
  if (!state) return;
  $("count").textContent = cards.length + " 张卡片";
  let message = "所有修改已提交";
  if (inspected) message = "正在查看历史版本 " + inspected.slice(0, 8);
  else if (stale) message = "分支已更新，草稿保留在此标签页。";
  else if (dirty()) message = "草稿已修改 · 等待提交";
  $("status").textContent = notice || message;
  $("resume").hidden = !inspected;
  $("forkDraft").hidden = !(stale && dirty());
  $("save").disabled = busy || !dirty() || !!inspected || stale;
  $("add").disabled = busy || !!inspected || cards.length >= 150;
  $("merge").disabled = busy || !!inspected || dirty() || !$("source").value;
  $("branchNew").disabled = busy;
}
function branchMenu() {
  const previous = $("source").value;
  const option = (item) => new Option(item.name, item.name);
  $("branch").replaceChildren(...state.branches.map(option));
  $("branch").value = branch;
  $("source").replaceChildren(
    ...state.branches.filter((b) => b.name !== branch).map(option),
  );
  if ([...$("source").options].some((o) => o.value === previous))
    $("source").value = previous;
  $("source").disabled = !$("source").options.length;
}
function cardContent(el, item) {
  el.dataset.color = item.color;
  el.style.left = item.x + "px";
  el.style.top = item.y + "px";
  el.classList.toggle("selected", item.id === selected);
  el.setAttribute("aria-label", item.title || "未命名卡片");
  const children = el.children;
  children[0].textContent = colorNames[item.color];
  children[1].textContent = item.title || "未命名卡片";
  children[2].textContent = item.body;
}
function paintCards() {
  const elements = new Map(
    [...$("stage").children].map((el) => [el.dataset.id, el]),
  );
  for (const item of cards) {
    let el = elements.get(item.id);
    if (!el) {
      el = make("button");
      el.type = "button";
      el.className = "card";
      el.dataset.id = item.id;
      const kind = make("span");
      kind.className = "card-kind";
      const copy = make("span");
      copy.className = "copy";
      el.append(kind, make("strong"), copy);
      $("stage").append(el);
    }
    elements.delete(item.id);
    cardContent(el, item);
  }
  for (const el of elements.values()) el.remove();
}
function inspector() {
  const item = activeCard();
  $("fields").hidden = !item;
  $("empty").hidden = !!item;
  $("fields").disabled = !!inspected || busy;
  if (!item) return;
  for (const field of ["title", "body", "x", "y"]) $(field).value = item[field];
  for (const swatch of $("colors").children)
    swatch.setAttribute(
      "aria-pressed",
      String(item.color === swatch.dataset.color),
    );
}
function revisionGraph() {
  const rows = [];
  const referenced = new Set();
  let lanes = [];
  const svgNS = "http://www.w3.org/2000/svg";
  for (const v of state.history) {
    let lane = lanes.indexOf(v.id);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(v.id);
    }
    const next = lanes.slice();
    next.splice(lane, 1, ...v.parents.filter((id) => !lanes.includes(id)));
    const svg = document.createElementNS(svgNS, "svg");
    const x = (col) => 7 + col * 9;
    const width = x(Math.max(lanes.length, next.length, 1)) + 1;
    svg.setAttribute("width", width);
    svg.setAttribute("viewBox", "0 0 " + width + " 54");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    function line(x1, y1, x2, y2) {
      const p = document.createElementNS(svgNS, "line");
      for (const [k, n] of Object.entries({
        x1,
        y1,
        x2,
        y2,
        stroke: "#86a08b",
        "stroke-width": 1.4,
      }))
        p.setAttribute(k, n);
      svg.append(p);
    }
    lanes.forEach((id, i) => {
      if (id !== v.id) line(x(i), 0, x(next.indexOf(id)), 54);
      else {
        if (referenced.has(id)) line(x(i), 0, x(i), 27);
        for (const parent of v.parents)
          line(x(i), 27, x(next.indexOf(parent)), 54);
      }
    });
    const dot = document.createElementNS(svgNS, "circle");
    for (const [k, n] of Object.entries({
      cx: x(lane),
      cy: 27,
      r: 3.7,
      fill: v.author === "agent" ? "#d9c7f1" : "#c6f885",
    }))
      dot.setAttribute(k, n);
    svg.append(dot);
    const button = make("button");
    button.type = "button";
    button.className = "rev";
    button.dataset.rev = v.id;
    button.classList.toggle("active", v.id === (inspected || base));
    const legend = make("span");
    legend.className = "legend";
    const names = state.branches
      .filter((b) => b.head === v.id)
      .map((b) => b.name)
      .join(", ");
    legend.append(
      make("strong", v.message),
      make(
        "small",
        (v.author === "agent" ? "Agent" : "人类") +
          " · " +
          v.id.slice(0, 7) +
          (names ? " · " + names : ""),
      ),
    );
    button.append(svg, legend);
    rows.push(button);
    v.parents.forEach((id) => referenced.add(id));
    lanes = next;
  }
  $("history").replaceChildren(...rows);
}
function render() {
  branchMenu();
  paintCards();
  inspector();
  revisionGraph();
  status();
}
function edit() {
  notice = "";
  remember();
  paintCards();
  status();
}
function choose(id) {
  selected = id;
  paintCards();
  inspector();
}
for (const [color, name] of Object.entries(colorNames)) {
  const button = make("button");
  button.type = "button";
  button.className = "swatch";
  button.dataset.color = color;
  button.title = name;
  button.setAttribute("aria-label", name);
  button.onclick = () => {
    activeCard().color = color;
    edit();
    inspector();
  };
  $("colors").append(button);
}
for (const field of ["title", "body", "x", "y"])
  $(field).oninput = (event) => {
    const item = activeCard();
    if (!item || inspected || busy) return;
    const value = event.target.value;
    if (field === "x" || field === "y") {
      if (value === "" || !event.target.validity.valid) return;
      item[field] = Number(value);
    } else item[field] = value;
    edit();
  };

new ResizeObserver(() => {
  const el = $("viewport");
  if (matchMedia("(max-width:570px)").matches) {
    scale = 0.75;
    $("stage").style.transform = "scale(" + scale + ")";
  } else {
    scale = Math.min(el.clientWidth / 1000, el.clientHeight / 570);
    $("stage").style.transform = "translate(-50%, -50%) scale(" + scale + ")";
  }
}).observe($("viewport"));
$("stage").onclick = (event) => {
  const button = event.target.closest(".card");
  if (button && !busy) choose(button.dataset.id);
};
$("stage").onpointerdown = (event) => {
  const button = event.target.closest(".card");
  if (!button || busy || event.button !== 0) return;
  choose(button.dataset.id);
  if (inspected) return;
  const item = activeCard(),
    start = { x: item.x, y: item.y, px: event.clientX, py: event.clientY };
  const pointer = event.pointerId;
  dragging = true;
  button.setPointerCapture(pointer);
  button.onpointermove = (move) => {
    if (move.pointerId !== pointer) return;
    item.x = Math.max(
      0,
      Math.min(800, Math.round(start.x + (move.clientX - start.px) / scale)),
    );
    item.y = Math.max(
      0,
      Math.min(436, Math.round(start.y + (move.clientY - start.py) / scale)),
    );
    cardContent(button, item);
    $("x").value = item.x;
    $("y").value = item.y;
  };
  button.onlostpointercapture = () => {
    button.onpointermove = null;
    button.onlostpointercapture = null;
    dragging = false;
    if (item.x !== start.x || item.y !== start.y) edit();
  };
};
$("add").onclick = () => {
  const n = cards.length;
  const item = {
    id: "card-" + crypto.randomUUID().slice(0, 8),
    title: "新卡片",
    body: "",
    color: "jade",
    x: 60 + ((n * 53) % 620),
    y: 54 + ((n * 43) % 290),
  };
  cards.push(item);
  selected = item.id;
  edit();
  inspector();
  $("title").focus();
  $("title").select();
};
$("remove").onclick = () => {
  cards = cards.filter((c) => c.id !== selected);
  selected = null;
  edit();
  inspector();
};

async function task(fn) {
  if (busy) return;
  busy = true;
  pollTicket++;
  document.querySelector("main").inert = true;
  status();
  try {
    await fn();
  } catch (error) {
    if (error.code === "STALE_HEAD" && error.branch === branch && dirty())
      stale = true;
    notice = error.message;
    if (state) render();
    else $("status").textContent = notice;
  } finally {
    busy = false;
    document.querySelector("main").inert = false;
    status();
    inspector();
  }
}
function dialog(title, contents, confirmLabel, read) {
  $("dialogTitle").textContent = title;
  $("dialogContent").replaceChildren(...contents);
  $("confirm").textContent = confirmLabel;
  return new Promise((resolve) => {
    let result;
    const d = $("dialog");
    $("cancel").onclick = () => d.close();
    $("dialogForm").onsubmit = (event) => {
      event.preventDefault();
      result = read();
      d.close();
    };
    d.onclose = () => resolve(result);
    d.showModal();
  });
}
function ask(title, label, initial, limit, confirmLabel) {
  const el = make("label", label);
  el.className = "dialog-label";
  const input = make("input");
  input.required = true;
  input.maxLength = limit;
  input.value = initial;
  el.append(input);
  const result = dialog(title, [el], confirmLabel, () => input.value.trim());
  input.select();
  return result;
}
$("save").onclick = () =>
  task(async () => {
    const message = await ask(
      "提交当前草稿",
      "版本说明",
      "更新协作地图",
      140,
      "提交版本",
    );
    if (!message) return;
    await api("commit", { branch, base, cards, message, author: "human" });
    originalCards = clone(cards);
    remember();
    await loadBranch(branch);
  });
async function createBranch() {
  const label = await ask(
    "新建分支",
    "分支名称（字母、数字、下划线、短横线）",
    "proposal-" + crypto.randomUUID().slice(0, 5),
    48,
    "创建分支",
  );
  if (!label) return;
  const from = inspected || base;
  await api("branch", { name: label, from });
  if (dirty()) {
    const saved = clone(cards);
    await loadBranch(label);
    cards = saved;
    remember();
    render();
  } else await loadBranch(label);
}
$("branchNew").onclick = $("forkDraft").onclick = () => task(createBranch);
$("branch").onchange = () => {
  const name = $("branch").value;
  $("branch").value = branch;
  task(() => loadBranch(name));
};
$("resume").onclick = () => task(() => loadBranch(branch));
$("history").onclick = (event) => {
  const id = event.target.closest(".rev")?.dataset.rev;
  if (!id) return;
  task(async () => {
    if (id === state.head) return loadBranch(branch);
    const version = await api("version?id=" + encodeURIComponent(id));
    const changes = version.parents.length
      ? await api("diff?from=" + version.parents[0] + "&to=" + id)
      : [];
    inspected = id;
    selected = null;
    cards = version.cards;
    notice =
      "历史快照 " +
      id.slice(0, 7) +
      " · " +
      (version.parents.length
        ? "相对第一父版本变更 " + changes.length + " 张卡片"
        : "初始版本");
    render();
  });
};
const displayValue = (value) =>
  value === null
    ? "（移除）"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
$("merge").onclick = () =>
  task(async () => {
    const source = $("source").value;
    const params = {
      target: branch,
      source,
      targetHead: state.head,
      sourceHead: state.branches.find((b) => b.name === source).head,
    };
    const result = await api("merge", { ...params, preview: true });
    const hint = make(
      "p",
      source + " → " + branch + " · 共同祖先 " + result.base.slice(0, 7),
    );
    hint.className = "hint";
    const contents = [hint],
      rows = [];
    for (const change of result.changes) {
      const verb = { added: "新增", removed: "移除", edited: "修改" }[
        change.kind
      ];
      const item = make(
        "div",
        verb +
          " · " +
          (change.after || change.before).title +
          (change.fields
            ? " · " + change.fields.map((k) => fieldNames[k]).join("、")
            : ""),
      );
      item.className = "change";
      if (change.fields) {
        const values = make("dl");
        values.className = "values";
        for (const field of change.fields) {
          const show = (value) =>
            field === "color" ? colorNames[value] : String(value) || "（空）";
          values.append(
            make("dt", fieldNames[field]),
            make("dd", "原值　" + show(change.before[field])),
            make("dd", "合入　" + show(change.after[field])),
          );
        }
        item.append(values);
      } else {
        const card = change.after || change.before;
        item.append(make("p", card.body || "（空白卡片）"));
      }
      contents.push(item);
    }
    if (!result.changes.length && !result.conflicts.length)
      contents.push(make("p", "两个版本的卡片内容一致。"));
    result.conflicts.forEach((conflict, index) => {
      const container = make("fieldset");
      container.className = "conflict";
      container.append(
        make("legend", conflict.id + " · " + fieldNames[conflict.field]),
      );
      const prior = make("p", "共同祖先　" + displayValue(conflict.base));
      prior.className = "hint";
      container.append(prior);
      const choices = [];
      for (const side of ["target", "source"]) {
        const label = make("label"),
          radio = make("input");
        radio.type = "radio";
        radio.name = "conflict" + index;
        radio.value = side;
        radio.required = true;
        label.append(
          radio,
          document.createTextNode(
            (side === "target" ? "当前分支" : "来源分支") +
              " · " +
              displayValue(conflict[side]),
          ),
        );
        container.append(label);
        choices.push(radio);
      }
      rows.push({ conflict, choices });
      contents.push(container);
    });
    const resolutions = await dialog("审阅分支合并", contents, "确认合并", () =>
      rows.map(({ conflict, choices }) => ({
        id: conflict.id,
        field: conflict.field,
        use: choices.find((r) => r.checked).value,
      })),
    );
    if (!resolutions) return;
    await api("merge", {
      ...params,
      preview: false,
      resolutions,
      author: "human",
    });
    await loadBranch(branch);
  });
setInterval(async () => {
  if (!state || busy || inspected || dragging || document.hidden) return;
  const ticket = pollTicket,
    current = branch;
  try {
    const next = await api("state?branch=" + encodeURIComponent(current));
    if (
      busy ||
      inspected ||
      dragging ||
      ticket !== pollTicket ||
      current !== branch
    )
      return;
    if (
      next.head === state.head &&
      JSON.stringify(next.branches) === JSON.stringify(state.branches)
    )
      return;
    if (next.head !== base && !dirty()) {
      base = next.head;
      originalCards = clone(next.cards);
      cards = clone(next.cards);
      stale = false;
      notice = "";
    } else if (next.head !== base) {
      stale = true;
      notice = "";
    }
    state = next;
    render();
  } catch {
    /* Explicit user actions surface service errors and retain the local draft. */
  }
}, 3000);
task(() => loadBranch(branch));
