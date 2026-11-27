import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionCommandExecutor } from "../src/runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("MCP session executor", () => {
  test("maps Mcp-Session-Id to an isolated HUMANBOARD_SESSION", async () => {
    const root = await mkdtemp(join(tmpdir(), "humanboard-mcp-session-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    const executor = createSessionCommandExecutor({
      cwd,
      env: {
        HUMANBOARD_HOME: home,
        HUMANBOARD_DB: join(home, "humanboard.sqlite"),
        HUMANBOARD_BLOBS: join(home, "blobs"),
        HUMANBOARD_CACHE: join(home, "cache"),
      },
    });

    try {
      const init = await executor.execute({
        sessionId: "session-a",
        argv: ["init", "--json"],
      });
      expect(init.exitCode).toBe(0);

      const patch = JSON.stringify({
        add_strokes: [
          {
            id: "mcp-session-stroke",
            tool: "pen",
            color: "#ff5b47",
            width: 3.2,
            points: [[10, 20], [30, 40]],
          },
        ],
      });
      const draft = await executor.execute({
        sessionId: "session-a",
        argv: ["draft", "--merge", "-", "--json"],
        stdin: patch,
      });
      expect(draft.exitCode).toBe(0);

      const otherSession = await executor.execute({
        sessionId: "session-b",
        argv: ["draft", "--show", "--json"],
      });
      expect(otherSession.exitCode).toBe(4);
      expect(otherSession.error?.code).toBe("E_NO_DRAFT");

      const ownSession = await executor.execute({
        sessionId: "session-a",
        argv: ["draft", "--show", "--json"],
      });
      expect(ownSession.exitCode).toBe(0);
    } finally {
      await executor.close();
    }
  });
});
