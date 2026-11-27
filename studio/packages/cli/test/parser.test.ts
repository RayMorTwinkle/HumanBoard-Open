import { describe, expect, test } from "bun:test";

import { HumanBoardError } from "@humanboard/core-engine";

import { outputModeForCommand, parseCliArgs } from "../src/parser";

describe("CLI parser", () => {
  test("accepts global options before and after the subcommand", () => {
    const before = parseCliArgs([
      "--project",
      "payments",
      "--space=flow",
      "--json",
      "get",
      "L2",
    ]);
    expect(before.global).toEqual({
      project: "payments",
      space: "flow",
      output: "json",
    });
    expect(before.command).toEqual({
      kind: "get",
      layer: "L2",
      format: "ast",
      withStrokes: false,
    });

    const after = parseCliArgs([
      "get",
      "L2",
      "--space",
      "flow",
      "--project=payments",
      "--json",
    ]);
    expect(after.global).toEqual(before.global);
    expect(after.command).toEqual(before.command);
  });

  test("rejects mutually exclusive output flags", () => {
    expect(() => parseCliArgs(["--json", "--text", "status"])).toThrow(
      HumanBoardError,
    );
    try {
      parseCliArgs(["--json", "--text", "status"]);
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardError);
      expect((error as HumanBoardError).code).toBe("E_USAGE");
    }
  });

  test("parses draft inputs, kinds, and short commit messages", () => {
    const parsed = parseCliArgs([
      "draft",
      "--parent",
      "L4",
      "--redo",
      "--merge",
      "patch.json",
    ]);
    expect(parsed.command).toEqual({
      kind: "draft",
      action: "create",
      parent: "L4",
      redo: true,
      transform: false,
      input: { kind: "merge", path: "patch.json" },
    });

    const commit = parseCliArgs(["commit", "-m", "补充失败分支"]);
    expect(commit.command).toEqual({
      kind: "commit",
      message: "补充失败分支",
    });
  });

  test("uses protocol defaults for text and JSON output", () => {
    expect(outputModeForCommand(parseCliArgs([]))).toBe("text");
    expect(outputModeForCommand(parseCliArgs(["layers"]))).toBe("text");
    expect(outputModeForCommand(parseCliArgs(["--help"]))).toBe("text");
    expect(outputModeForCommand(parseCliArgs(["get"]))).toBe("json");
    expect(outputModeForCommand(parseCliArgs(["status", "--json"]))).toBe(
      "json",
    );
  });

  test("parses serve, watch, inspect, and connect commands", () => {
    expect(
      parseCliArgs(["serve", "--host", "127.0.0.1", "--port", "4318"]).command,
    ).toEqual({
      kind: "serve",
      host: "127.0.0.1",
      port: 4318,
    });
    expect(
      parseCliArgs(["watch", "--since", "L4", "--timeout", "2.5", "--all"])
        .command,
    ).toEqual({
      kind: "watch",
      since: "L4",
      timeoutSeconds: 2.5,
      all: true,
    });
    expect(parseCliArgs(["inspect", "#001", "--layer", "L2"]).command).toEqual({
      kind: "inspect",
      asset: "#001",
      layer: "L2",
    });
    expect(parseCliArgs(["--connect", "token"]).command).toEqual({
      kind: "connect",
      target: "token",
    });
    expect(parseCliArgs(["open", "L4"]).command).toEqual({
      kind: "open",
      layer: "L4",
    });
    expect(parseCliArgs(["open", "--layer", "L4"]).command).toEqual({
      kind: "open",
      layer: "L4",
    });
    expect(() => parseCliArgs(["open", "L4", "--layer", "L5"])).toThrow(
      HumanBoardError,
    );
  });

  test("parses optional SKILL.md injection during init", () => {
    expect(parseCliArgs(["init", "--skill"]).command).toEqual({
      kind: "init",
      injectSkill: true,
    });
    expect(parseCliArgs(["init"]).command).toEqual({
      kind: "init",
      injectSkill: false,
    });
  });
});

test("serve --stop is local management and rejects conflicting host/port flags", () => {
  expect(parseCliArgs(["serve", "--stop"]).command).toMatchObject({
    kind: "serve",
    stop: true,
  });
  expect(() => parseCliArgs(["serve", "--stop", "--port", "4318"])).toThrow(
    "cannot be combined",
  );
  expect(
    parseCliArgs(["--connect", "http://127.0.0.1:4317", "--json"]).command,
  ).toEqual({ kind: "connect", target: "http://127.0.0.1:4317" });
});
