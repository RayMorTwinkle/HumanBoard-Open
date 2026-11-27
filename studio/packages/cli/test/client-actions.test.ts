import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/main";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  readonly cwd: string;
  readonly home: string;
  readonly env: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "humanboard-client-actions-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  return {
    cwd: root,
    home,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HUMANBOARD_HOME: home,
    },
  };
}

async function unavailablePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("probe");
    },
  });
  const port = probe.port;
  if (port === undefined) {
    throw new Error("Probe server did not expose a port");
  }
  await probe.stop(true);
  return port;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("human open", () => {
  test("opens the configured board URL with an encoded layer target", async () => {
    const fx = await fixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/health"
          ? Response.json({ ok: true, service: "humanboard" })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      let openedUrl = "";
      let stdout = "";
      let stderr = "";
      const exitCode = await runCli(["open", "L7", "--json"], {
        cwd: fx.cwd,
        env: {
          ...fx.env,
          HUMANBOARD_SERVER_URL: `http://127.0.0.1:${server.port}`,
        },
        platform: "darwin",
        launchBrowser: (url) => {
          openedUrl = url;
        },
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(new URL(openedUrl).searchParams.get("layer")).toBe("L7");
      expect(JSON.parse(stdout).url).toBe(openedUrl);
    } finally {
      await server.stop(true);
    }
  });

  test("returns E_CONNECT when the server is unavailable", async () => {
    const fx = await fixture();
    const port = await unavailablePort();
    let stderr = "";
    const exitCode = await runCli(["open", "--json"], {
      cwd: fx.cwd,
      env: {
        ...fx.env,
        HUMANBOARD_SERVER_URL: `http://127.0.0.1:${port}`,
      },
      platform: "darwin",
      launchBrowser: () => {
        throw new Error("browser must not launch");
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    expect(exitCode).toBe(6);
    expect(JSON.parse(stderr).error.code).toBe("E_CONNECT");
  });

  test("returns E_USAGE on non-macOS platforms", async () => {
    const fx = await fixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/health"
          ? Response.json({ ok: true, service: "humanboard" })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      let stderr = "";
      const exitCode = await runCli(["open", "--json"], {
        cwd: fx.cwd,
        env: {
          ...fx.env,
          HUMANBOARD_SERVER_URL: `http://127.0.0.1:${server.port}`,
        },
        platform: "linux",
        launchBrowser: () => {
          throw new Error("browser must not launch");
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(2);
      const error = JSON.parse(stderr).error;
      expect(error.code).toBe("E_USAGE");
      expect(error.details.reason).toBe("unsupported_platform");
    } finally {
      await server.stop(true);
    }
  });
});

describe("human connect", () => {
  test("writes server_url and an empty token after health succeeds", async () => {
    const fx = await fixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/health"
          ? Response.json({ ok: true, service: "humanboard" })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      let stdout = "";
      let stderr = "";
      const serverUrl = `http://127.0.0.1:${server.port}`;
      const exitCode = await runCli(["connect", serverUrl, "--json"], {
        cwd: fx.cwd,
        env: fx.env,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const data = JSON.parse(stdout) as {
        server_url: string;
        token_configured: boolean;
        warnings: unknown[];
      };
      expect(data.server_url).toBe(`${serverUrl}/`);
      expect(data.token_configured).toBe(false);
      expect(data.warnings).toEqual([]);

      const config = JSON.parse(
        await readFile(join(fx.home, "config.json"), "utf8"),
      ) as { server_url: string; token: string };
      expect(config).toEqual({ server_url: `${serverUrl}/`, token: "" });
    } finally {
      await server.stop(true);
    }
  });

  test("uses the configured server when the target is a token", async () => {
    const fx = await fixture();
    let expectedToken = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/health") {
          return new Response("not found", { status: 404 });
        }
        if (
          expectedToken.length > 0 &&
          request.headers.get("authorization") !== `Bearer ${expectedToken}`
        ) {
          return Response.json(
            { error: { code: "E_AUTH", message: "invalid token" } },
            { status: 401 },
          );
        }
        return Response.json({ ok: true, service: "humanboard" });
      },
    });
    try {
      const serverUrl = `http://127.0.0.1:${server.port}/`;
      const firstExit = await runCli(["connect", serverUrl, "--json"], {
        cwd: fx.cwd,
        env: fx.env,
        stdout: () => {},
        stderr: () => {},
      });
      expect(firstExit).toBe(0);

      expectedToken = "secret-token";
      let stderr = "";
      const exitCode = await runCli(["connect", expectedToken, "--json"], {
        cwd: fx.cwd,
        env: fx.env,
        stdout: () => {},
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const config = JSON.parse(
        await readFile(join(fx.home, "config.json"), "utf8"),
      ) as { server_url: string; token: string };
      expect(config).toEqual({
        server_url: serverUrl,
        token: "secret-token",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("maps authentication failures to E_AUTH", async () => {
    const fx = await fixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json(
          { error: { code: "E_AUTH", message: "invalid token" } },
          { status: 403 },
        );
      },
    });
    try {
      let stderr = "";
      const exitCode = await runCli(
        ["connect", `http://127.0.0.1:${server.port}`, "--json"],
        {
          cwd: fx.cwd,
          env: fx.env,
          stderr: (value) => {
            stderr += value;
          },
        },
      );
      expect(exitCode).toBe(5);
      expect(JSON.parse(stderr).error.code).toBe("E_AUTH");
    } finally {
      await server.stop(true);
    }
  });

  test("maps connection failures to E_CONNECT", async () => {
    const fx = await fixture();
    const port = await unavailablePort();
    let stderr = "";
    const exitCode = await runCli(
      ["connect", `http://127.0.0.1:${port}`, "--json"],
      {
        cwd: fx.cwd,
        env: fx.env,
        stderr: (value) => {
          stderr += value;
        },
      },
    );
    expect(exitCode).toBe(6);
    expect(JSON.parse(stderr).error.code).toBe("E_CONNECT");
  });
});
