import { randomUUID } from "node:crypto";

const origin = "http://127.0.0.1:" + Number(process.env.PORT || 4317);
async function request(path, data) {
  const response = await fetch(
    origin + path,
    data
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.message);
  return value;
}
try {
  const { head, cards } = await request("/api/state");
  const branch = "agent-" + randomUUID().slice(0, 8);
  await request("/api/branch", { name: branch, from: head });
  const note = {
    id: "note-" + randomUUID().slice(0, 8),
    title: "Agent 的审阅建议",
    body: "先审阅提案分支的差异，再决定是否合入主分支。",
    color: "coral",
    x: 88,
    y: 310,
  };
  const result = await request("/api/commit", {
    branch,
    base: head,
    cards: [...cards, note],
    message: "补充审阅建议",
    author: "agent",
  });
  const changes = await request(
    "/api/diff?from=" + head + "&to=" + result.head,
  );
  console.log(
    JSON.stringify(
      {
        branch,
        head: result.head,
        changes,
        review: origin + "/?branch=" + branch,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "演练未完成。请先运行 npm start，并使用相同 PORT。",
    error.message,
  );
  process.exitCode = 1;
}
