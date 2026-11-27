import { configureLoopbackBypass } from "../packages/application-service/src/loopback-network";
configureLoopbackBypass();
import { resolve } from "node:path";
import { createServerRuntime } from "../packages/application-service/src/server-runtime";
import { LocalAppService } from "../packages/application-service/src/local-app-service";
const root = resolve(import.meta.dir, "..");
const env: Record<string, string | undefined> = {
  ...process.env,
  HUMANBOARD_HOME:
    process.env.HUMANBOARD_HOME || resolve(root, ".humanboard-data"),
};
const service = await LocalAppService.create({ cwd: root, env });
try {
  await service.execute(
    { kind: "init", injectSkill: false },
    { output: "json" },
  );
} finally {
  service.close();
}
const port = Number(process.env.HUMANBOARD_PORT || 4317);
const host = process.env.HUMANBOARD_HOST || "127.0.0.1";
const runtime = await createServerRuntime({ cwd: root, env, host, port });
console.log(
  `HumanBoard 已启动：${env.HUMAN_PUBLIC_URL || runtime.url}\n数据目录：${env.HUMANBOARD_HOME}\nMCP：${env.HUMAN_PUBLIC_URL || runtime.url}/mcp\n按 Ctrl+C 停止。`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
