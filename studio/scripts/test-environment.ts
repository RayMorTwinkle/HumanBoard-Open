import { configureLoopbackBypass } from "../packages/application-service/src/loopback-network";
configureLoopbackBypass();
// Tests must not inherit real provider credentials or public deployment settings from .env.
for (const key of Object.keys(process.env)) {
  if (
    /^HUMAN_(MODEL_|AGENT_|VISION_|TEXT_|AUTO_TITLE$|AUTH_TOKEN$|PUBLIC_URL$|ALLOWED_HOSTS$)/.test(
      key,
    ) ||
    key === "HUMANBOARD_SERVER_URL"
  )
    delete process.env[key];
}
