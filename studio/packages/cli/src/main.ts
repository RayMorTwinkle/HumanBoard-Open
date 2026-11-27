#!/usr/bin/env bun
import {
  humanHelp,
  humanVersion,
} from "@humanboard/application-service/cli-info";

import { configureLoopbackBypass } from "@humanboard/application-service/loopback-network";
configureLoopbackBypass();

import { fileURLToPath } from "node:url";

import {
  ensureManagedLocalServer,
  stopManagedLocalServer,
} from "@humanboard/application-service/local-server-launcher";
import { connectServer, openBoard } from "./client-actions";
import { executeConnectedCommand } from "@humanboard/application-service/command-client";
import { LocalAppService } from "./local-app-service";
import { exitCodeFor, renderError, renderResult } from "./output";
import { outputModeForCommand, parseCliArgs, type OutputMode } from "./parser";
import {
  captureLocalServer,
  runServe,
  watchLocalServer,
} from "./server-runtime";

const CLI_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

function errorMode(argv: readonly string[]): Exclude<OutputMode, "auto"> {
  if (argv.includes("--json")) {
    return "json";
  }
  if (argv.includes("--text")) {
    return "text";
  }
  const command = argv.find((arg) => !arg.startsWith("-"));
  return command === undefined ||
    command === "status" ||
    command === "layers" ||
    command === "serve"
    ? "text"
    : "json";
}

export async function runCli(
  argv: readonly string[],
  options: {
    readonly autoStart?: boolean;
    readonly cliCommand?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdout?: (value: string) => void;
    readonly stderr?: (value: string) => void;
    readonly platform?: NodeJS.Platform;
    readonly launchBrowser?: (url: string) => Promise<void> | void;
  } = {},
): Promise<number> {
  const stdout =
    options.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr =
    options.stderr ?? ((value: string) => process.stderr.write(value));
  let mode: Exclude<OutputMode, "auto"> = errorMode(argv);
  // Indentation roughly doubles what an agent reads, so only a terminal gets it.
  const pretty = options.stdout !== undefined || process.stdout.isTTY === true;
  const render = (result: Parameters<typeof renderResult>[0], m: typeof mode) =>
    renderResult(result, m, pretty);

  let service: LocalAppService | null = null;
  try {
    const parsed = parseCliArgs(argv);
    mode = outputModeForCommand(parsed);
    if (parsed.command.kind === "help" || parsed.command.kind === "version") {
      stdout(
        render(
          parsed.command.kind === "help" ? humanHelp() : humanVersion(),
          mode,
        ),
      );
      return 0;
    }
    if (parsed.command.kind === "serve") {
      if (parsed.command.stop) {
        const result = await stopManagedLocalServer({
          env: options.env ?? process.env,
          cwd: options.cwd ?? process.cwd(),
        });
        stdout(
          render(
            {
              data: result,
              text: result.stopped
                ? `Stopped local HumanBoard server (${result.pid})`
                : result.stopping
                  ? `Shutdown requested; local server is still cleaning up (${result.pid})`
                  : "No managed local server is running",
            },
            mode,
          ),
        );
        return 0;
      }
      return await runServe(
        {
          cwd: options.cwd ?? process.cwd(),
          env: options.env ?? process.env,
          host: parsed.command.host,
          port: parsed.command.port,
        },
        stdout,
        mode,
      );
    }
    if (
      options.autoStart &&
      !["help", "connect", "sync"].includes(parsed.command.kind) &&
      (options.env ?? process.env).HUMANBOARD_NO_AUTO_START !== "1"
    ) {
      await ensureManagedLocalServer({
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        command: options.cliCommand ?? [process.execPath, CLI_ENTRY],
      });
    }
    if (parsed.command.kind === "watch") {
      return await watchLocalServer({
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(parsed.global.project === undefined
          ? {}
          : { project: parsed.global.project }),
        ...(parsed.global.space === undefined
          ? {}
          : { space: parsed.global.space }),
        ...(parsed.command.since === undefined
          ? {}
          : { since: parsed.command.since }),
        all: parsed.command.all,
        timeoutSeconds: parsed.command.timeoutSeconds,
        stdout,
        stderr,
        autoStart: true,
        cliEntry: CLI_ENTRY,
        cliCommand: options.cliCommand,
      });
    }
    if (parsed.command.kind === "capture") {
      const result = await captureLocalServer({
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        ...(parsed.global.project === undefined
          ? {}
          : { project: parsed.global.project }),
        ...(parsed.global.space === undefined
          ? {}
          : { space: parsed.global.space }),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          result.error?.message ?? "capture failed without an error payload",
        );
      }
      const data = result.data as {
        readonly snapshot_id?: string;
        readonly based_on_layer?: string;
        readonly render?: { readonly url?: string };
      };
      stdout(
        render(
          {
            data: result.data,
            text: [
              `Captured ${data.snapshot_id ?? "snapshot"}`,
              `based on: ${data.based_on_layer ?? "unknown"}`,
              `render: ${data.render?.url ?? "none"}`,
            ].join("\n"),
          },
          mode,
        ),
      );
      return 0;
    }
    if (parsed.command.kind === "open") {
      const result = await openBoard({
        ...(parsed.command.layer === undefined
          ? {}
          : { layer: parsed.command.layer }),
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        ...(options.platform === undefined
          ? {}
          : { platform: options.platform }),
        ...(options.launchBrowser === undefined
          ? {}
          : { launchBrowser: options.launchBrowser }),
      });
      stdout(render(result, mode));
      return 0;
    }
    if (parsed.command.kind === "connect") {
      const result = await connectServer({
        target: parsed.command.target,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
      });
      stdout(render(result, mode));
      return 0;
    }
    {
      const connected =
        parsed.command.kind === "sync"
          ? null
          : await executeConnectedCommand(
              argv,
              parsed.command,
              options.cwd ?? process.cwd(),
              options.env ?? process.env,
            );
      if (connected) {
        stdout(
          render(
            {
              data: connected.data,
              text: connected.stdout ?? JSON.stringify(connected.data),
            },
            mode,
          ),
        );
        return 0;
      }
    }
    service = await LocalAppService.create({
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    });
    const result = await service.execute(parsed.command, parsed.global);
    stdout(render(result, mode));
    return 0;
  } catch (error) {
    stderr(renderError(error, mode));
    return exitCodeFor(error);
  } finally {
    service?.close();
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2), { autoStart: true });
  process.exitCode = exitCode;
}
