import { resolve } from "node:path";
import { createMcpApp } from "../../server-self-hosted/src/mcp-app";
import { revisionTools } from "../../server-self-hosted/src/revision-tools";
import { HumanBoardError } from "../../../packages/core-engine/src/domain/errors";
import { openWorkspace } from "./workspace";

export async function serveStudio(
  directory: string,
  dist: string,
  port: number,
) {
  const workspace = await openWorkspace(directory);
  const execute = (input: unknown, agent = false) =>
    workspace.service.execute(
      workspace.spaceId,
      input,
      agent ? { kind: "cli", name: "MCP" } : { kind: "human" },
    );
  let mcp: ReturnType<typeof createMcpApp>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url);
      const hosts = ["127.0.0.1:" + server.port, "localhost:" + server.port];
      if (
        !hosts.includes(req.headers.get("host") ?? "") ||
        (req.headers.has("origin") && req.headers.get("origin") !== url.origin)
      )
        return new Response("Local access only", { status: 403 });
      if (url.pathname === "/mcp") return mcp.fetch(req);
      if (req.method === "POST" && url.pathname === "/api/studio") {
        if (
          req.headers.get("content-type")?.split(";")[0] !== "application/json"
        )
          return new Response(null, { status: 415 });
        try {
          return Response.json(await execute(await req.json()));
        } catch (e) {
          const code =
            e instanceof HumanBoardError
              ? e.code
              : e instanceof SyntaxError
                ? "E_USAGE"
                : "E_INTERNAL";
          return Response.json(
            { code, message: e instanceof Error ? e.message : "读取失败" },
            {
              status:
                code === "E_REVISION_CONFLICT"
                  ? 409
                  : code === "E_INTERNAL"
                    ? 500
                    : 400,
            },
          );
        }
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/" ||
          /^\/assets\/[a-zA-Z0-9._-]+$/.test(url.pathname))
      ) {
        const file = Bun.file(
          resolve(
            dist,
            url.pathname === "/" ? "index.html" : url.pathname.slice(1),
          ),
        );
        if (await file.exists())
          return new Response(file, {
            headers: { "X-Content-Type-Options": "nosniff" },
          });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  mcp = createMcpApp({
    port: server.port,
    enabledTools: new Set(revisionTools.map((t) => t.name)),
    execute: async ({ argv, stdin }) => {
      try {
        // Studio serves exactly one workspace. An explicit scope must identify it.
        for (const [flag, id] of [
          ["--project", workspace.projectId],
          ["--space", workspace.spaceId],
        ] as const) {
          const index = argv.indexOf(flag);
          if (index >= 0 && argv[index + 1] !== id)
            throw new HumanBoardError("E_NOT_FOUND", "工作区标识不匹配");
        }
        return { exitCode: 0, data: await execute(JSON.parse(stdin!), true) };
      } catch (e) {
        return {
          exitCode: 1,
          error:
            e instanceof HumanBoardError
              ? e.toJSON().error
              : { code: "E_USAGE", message: String(e), details: {} },
        };
      }
    },
  });
  return {
    url: server.url,
    stop: async () => {
      await server.stop(true);
      workspace.close();
    },
  };
}

if (import.meta.main) {
  const app = await serveStudio(
    process.env.HUMANBOARD_STUDIO_DIR ?? resolve(".humanboard-studio"),
    resolve(import.meta.dir, "../dist"),
    Number(process.env.PORT ?? 4317),
  );
  console.log(
    "HumanBoard Studio · " + app.url + "  MCP · " + new URL("/mcp", app.url),
  );
  process.once("SIGINT", () => void app.stop());
  process.once("SIGTERM", () => void app.stop());
}
