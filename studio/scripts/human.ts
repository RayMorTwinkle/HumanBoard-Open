import { configureLoopbackBypass } from "../packages/application-service/src/loopback-network";
configureLoopbackBypass();
import { resolve } from "node:path";
import { runCli } from "../packages/cli/src/main";
const root = resolve(import.meta.dir, "..");
process.exitCode = await runCli(process.argv.slice(2), {
  autoStart: true,
  env: {
    ...process.env,
    HUMANBOARD_HOME:
      process.env.HUMANBOARD_HOME || resolve(root, ".humanboard-data"),
  },
});
