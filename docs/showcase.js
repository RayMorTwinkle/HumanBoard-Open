// A fixed, fictional exhibit plan keeps the Pages replay offline and repeatable.
const revisions = {
  base:  { title: "展厅",     pointer: "",      note: "共同起点只有「入口」和「展厅」。两位编辑者从这份快照分头工作。" },
  human: { title: "声音展厅", pointer: "策展人", note: "人在主线把「展厅」改名为「声音展厅」，入口的位置保持不动。" },
  agent: { title: "展厅",     pointer: "Agent", note: "Agent 在提案分支增设「听众留言」，主线仍可编辑。" },
  merge: { title: "声音展厅", pointer: "",      note: "改名与新增卡片分别作用于不同对象，这份合并结果同时保留了两项修改。" }
};
const board = document.querySelector("#board");
const controls = document.querySelectorAll("[data-revision]");
for (const control of controls) {
  control.addEventListener("click", () => {
    const key = control.dataset.revision;
    const revision = revisions[key];
    board.dataset.rev = key;
    document.querySelector("#room").textContent = revision.title;
    document.querySelector("#cursor").textContent = revision.pointer;
    document.querySelector("#revision-note").textContent = revision.note;
    document.querySelector("#bench").setAttribute("aria-hidden", String(key === "base" || key === "human"));
    for (const button of controls) button.setAttribute("aria-pressed", String(control === button));
  });
}
