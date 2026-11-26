import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { publicError } from "./board.mjs";
import { BoardError, invalid } from "./scene.mjs";

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

async function payload(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new BoardError(415, "CONTENT_TYPE", "请求须使用 application/json。");
  const chunks = [];
  let count = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    count += chunk.length;
    if (count > 512 * 1024) {
      req.resume();
      throw new BoardError(413, "BODY_TOO_LARGE", "请求超过大小上限。");
    }
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalid("无效的 JSON。");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    invalid("请求内容须为对象。");
  return result;
}

export function boardServer(board) {
  const handlers = new Map([
    ["/api/branch", (data) => board.branch(data)],
    ["/api/commit", (data) => board.commit(data)],
    ["/api/merge", (data) => board.merge(data)],
  ]);
  return createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(body));
    };
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      const port = req.socket.localPort;
      const suffix = port === 80 ? "" : ":" + port;
      const localNames = ["127.0.0.1" + suffix, "localhost" + suffix];
      if (
        !localNames.includes(req.headers.host) ||
        (req.headers.origin &&
          req.headers.origin !== "http://" + req.headers.host)
      ) {
        throw new BoardError(403, "LOCAL_ONLY", "请从本机画板地址访问。");
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET") {
        if (url.pathname === "/api/state")
          return json(
            200,
            board.state(url.searchParams.get("branch") ?? "main"),
          );
        if (url.pathname === "/api/version")
          return json(200, board.version(url.searchParams.get("id")));
        if (url.pathname === "/api/diff")
          return json(
            200,
            board.compare(
              url.searchParams.get("from"),
              url.searchParams.get("to"),
            ),
          );
        const item = staticFiles.get(url.pathname);
        if (item) {
          const bytes = await readFile(
            new URL("../public/" + item[0], import.meta.url),
          );
          res.writeHead(200, { "Content-Type": item[1] });
          return res.end(bytes);
        }
      }
      if (req.method === "POST" && handlers.has(url.pathname))
        return json(200, handlers.get(url.pathname)(await payload(req)));
      throw new BoardError(404, "NOT_FOUND", "找不到该路径。");
    } catch (error) {
      const { status, body } = publicError(error);
      if (status === 500) console.error(error);
      json(status, body);
    }
  });
}
