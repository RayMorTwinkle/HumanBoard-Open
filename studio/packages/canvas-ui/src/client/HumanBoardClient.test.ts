import { describe, expect, test } from "bun:test";

import {
  HumanBoardClient,
  HumanBoardClientError,
  renderUrlForBrowser,
} from "./HumanBoardClient";
import type { StatusData } from "./types";

const STATUS: StatusData = {
  project: { id: "p1", name: "demo", root: "/tmp/demo" },
  space: { id: "s1", name: "main" },
  active_layer: "l1",
  layers: [],
  layers_truncated: false,
  total_layers: 1,
  spaces: [],
  warnings: [],
};

describe("HumanBoardClient", () => {
  test("posts JSON with the client header and --json output mode", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new HumanBoardClient({
      baseUrl: "http://humanboard.test",
      project: "demo",
      space: "main",
      fetchImpl: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return Response.json({ exitCode: 0, data: STATUS });
      },
    });

    const result = await client.status();
    expect(result.project.name).toBe("demo");
    expect(capturedUrl).toBe("http://humanboard.test/api/command");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("X-HumanBoard-Client")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      argv: ["--project", "demo", "--space", "main", "status", "--json"],
    });
  });

  test("maps protocol errors to HumanBoardClientError", async () => {
    const client = new HumanBoardClient({
      fetchImpl: async () =>
        Response.json({
          exitCode: 3,
          error: {
            code: "E_PROJECT_REQUIRED",
            message: "No Project is selected",
            details: { reason: "missing_binding" },
          },
        }),
    });

    try {
      await client.status();
      throw new Error("expected status to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardClientError);
      const clientError = error as HumanBoardClientError;
      expect(clientError.code).toBe("E_PROJECT_REQUIRED");
      expect(clientError.exitCode).toBe(3);
      expect(clientError.details).toEqual({ reason: "missing_binding" });
    }
  });

  test("maps network failures to E_CONNECT", async () => {
    const client = new HumanBoardClient({
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    try {
      await client.health();
      throw new Error("expected health to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardClientError);
      expect((error as HumanBoardClientError).code).toBe("E_CONNECT");
    }
  });

  test("sends an inline merge patch through command stdin", async () => {
    const bodies: Array<{
      argv: string[];
      stdin?: string;
    }> = [];
    const client = new HumanBoardClient({
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          exitCode: 0,
          data: {
            draft_id: "draft-1",
            parent_id: "layer-1",
            space_id: "space-1",
            kind: "derive",
            redo_of: null,
            expires_at: "2026-10-22T08:30:00Z",
            preview_url: "/preview.png",
            overwritten: false,
            registered_assets: [],
            warnings: [],
          },
        });
      },
    });
    const patch = JSON.stringify({ add_strokes: [] });
    await client.draft({ parent: "L1", mergeStdin: patch });
    expect(bodies[0]?.argv).toEqual([
      "draft",
      "--parent",
      "L1",
      "--merge",
      "-",
      "--json",
    ]);
    expect(bodies[0]?.stdin).toBe(patch);
  });

  test("writes the active layer through the frontend endpoint", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new HumanBoardClient({
      baseUrl: "http://humanboard.test",
      fetchImpl: async (input, init) => {
        capturedUrl = input;
        capturedInit = init;
        return Response.json({
          space_id: "space-1",
          active_layer_id: "layer-2",
        });
      },
    });

    const result = await client.setActiveLayer("space-1", "layer-2");
    expect(result.active_layer_id).toBe("layer-2");
    expect(capturedUrl).toBe(
      "http://humanboard.test/api/frontend/active-layer",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("X-HumanBoard-Client")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      space_id: "space-1",
      layer_id: "layer-2",
    });
  });

  test("loads agent config and posts agent chat input", async () => {
    const calls: Array<{
      readonly url: string;
      readonly method: string;
      readonly body: unknown;
    }> = [];
    const client = new HumanBoardClient({
      baseUrl: "http://humanboard.test",
      fetchImpl: async (input, init) => {
        calls.push({
          url: input,
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        if (input.endsWith("/api/agent/config")) {
          return Response.json({
            agent: {
              configured: true,
              model: "agent-model",
              base_url_configured: true,
              api_key_configured: true,
              missing_env: [],
            },
            vision: {
              configured: false,
              model: null,
              base_url_configured: false,
              api_key_configured: false,
              missing_env: ["HUMAN_VISION_MODEL"],
            },
            text: {
              configured: false,
              model: null,
              base_url_configured: false,
              api_key_configured: false,
              missing_env: ["HUMAN_TEXT_MODEL"],
            },
          });
        }
        return Response.json({
          session_id: "session-1",
          message_id: "message-1",
          assistant_message: "done",
          base_layer_id: "layer-1",
          result_layer_id: "layer-2",
          kind: "derive",
          title: "迭代",
          diff: {
            mode: "ast",
            summary: "changed",
            base_layer_id: "layer-1",
            result_layer_id: "layer-2",
          },
        });
      },
    });

    expect((await client.agentConfig()).agent.model).toBe("agent-model");
    const result = await client.agentChat({
      project_id: "project-1",
      space_id: "space-1",
      base_layer_id: "layer-1",
      message: "继续",
    });
    expect(result.result_layer_id).toBe("layer-2");
    expect(calls.map((call) => call.url)).toEqual([
      "http://humanboard.test/api/agent/config",
      "http://humanboard.test/api/agent/chat",
    ]);
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: {
        project_id: "project-1",
        space_id: "space-1",
        base_layer_id: "layer-1",
        message: "继续",
      },
    });
  });

  test("loads persisted Agent history for the current Space", async () => {
    let capturedUrl = "";
    const client = new HumanBoardClient({
      baseUrl: "http://humanboard.test",
      fetchImpl: async (input) => {
        capturedUrl = input;
        return Response.json({
          session_id: "session-1",
          messages: [
            {
              id: "message-1",
              session_id: "session-1",
              seq: 1,
              role: "user",
              content: "继续",
              base_layer_id: "layer-1",
              result_layer_id: "layer-2",
              created_at: "2026-10-22T00:00:00.000Z",
            },
          ],
        });
      },
    });

    const history = await client.agentHistory("project-1", "space-1");
    expect(history.messages[0]?.content).toBe("继续");
    expect(capturedUrl).toBe(
      "http://humanboard.test/api/agent/history?project_id=project-1&space_id=space-1",
    );
  });

  test("rewrites cached render file URLs to the server route", () => {
    expect(
      renderUrlForBrowser(
        "file:///example/workspace/.humanboard/cache/renders/abc.png",
      ),
    ).toBe("/render/abc.png");
    expect(renderUrlForBrowser("https://example.com/renders/abc.png")).toBe(
      "https://example.com/renders/abc.png",
    );
    expect(
      renderUrlForBrowser(
        "file:///example/workspace/.humanboard/cache/inspect/asset-001.png",
      ),
    ).toBe("/inspect/asset-001.png");
  });
});
