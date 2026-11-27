import { describe, expect, test } from "bun:test";

import {
  buildToolInvocation,
  McpToolArgumentError,
} from "../src/tools";

describe("MCP tool command mapping", () => {
  test("maps read tools and global scope arguments", () => {
    expect(
      buildToolInvocation("get", {
        project: "demo",
        space: "main",
        layer: "L4",
        format: "both",
        with_strokes: true,
      }),
    ).toEqual({
      argv: [
        "--project",
        "demo",
        "--space",
        "main",
        "get",
        "L4",
        "--format",
        "both",
        "--with-strokes",
        "--json",
      ],
    });
    expect(buildToolInvocation("layers", { all: true })).toEqual({
      argv: ["layers", "--all", "--json"],
    });
    expect(buildToolInvocation("diff", { layers: ["L2", "L5"] })).toEqual({
      argv: ["diff", "L2", "L5", "--json"],
    });
    expect(buildToolInvocation("inspect", { asset: "001", layer: "L2" })).toEqual({
      argv: ["inspect", "001", "--layer", "L2", "--json"],
    });
  });

  test("maps draft scene and patch inputs to stdin", () => {
    expect(
      buildToolInvocation("draft", {
        parent: "L1",
        scene: { nodes: [], edges: [], strokes: [], assets: [] },
      }),
    ).toEqual({
      argv: ["draft", "--parent", "L1", "--stdin", "--json"],
      stdin: JSON.stringify({
        nodes: [],
        edges: [],
        strokes: [],
        assets: [],
      }),
    });

    expect(
      buildToolInvocation("draft", {
        patch: { add_strokes: [] },
      }),
    ).toEqual({
      argv: ["draft", "--merge", "-", "--json"],
      stdin: JSON.stringify({ add_strokes: [] }),
    });
  });

  test("maps admin tools and rejects mutually exclusive draft input", () => {
    expect(
      buildToolInvocation("space", {
        action: "create",
        value: "refund",
        from: "L2",
      }),
    ).toEqual({
      argv: ["space", "create", "refund", "--from", "L2", "--json"],
    });
    expect(
      buildToolInvocation("project", { action: "switch", value: "payments" }),
    ).toEqual({
      argv: ["project", "switch", "payments", "--json"],
    });
    expect(() =>
      buildToolInvocation("draft", {
        scene: {},
        patch: {},
      }),
    ).toThrow(McpToolArgumentError);
  });
});
