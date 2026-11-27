import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelSettingsService } from "../../application-service/src/model-settings";
const directories: string[] = [];
const environment = {
  HUMAN_AGENT_MODEL: "agent-env",
  HUMAN_MODEL_BASE_URL: "http://127.0.0.1:12345/v1",
  HUMAN_MODEL_API_KEY: "PRIVATE_ENV_KEY",
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "humanboard-model-settings-"));
  directories.push(home);
  return {
    home,
    settings: await ModelSettingsService.create(home, environment),
  };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("persists role overrides privately, preserves a blank secret, and restores environment defaults", async () => {
  const { home, settings } = await fixture();
  await settings.update({
    role: "agent",
    model: "agent-saved",
    api_key: "PRIVATE_SAVED_KEY",
    enabled: true,
  });
  await settings.update({ role: "agent", model: "agent-renamed", api_key: "" });
  const publicConfig = settings.publicConfiguration();
  expect(publicConfig.agent).toMatchObject({
    model: "agent-renamed",
    enabled: true,
    configured: true,
    source: "saved",
  });
  expect(JSON.stringify(publicConfig)).not.toContain("PRIVATE_");
  const file = join(home, "model-settings.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toContain("PRIVATE_SAVED_KEY");
  const restarted = await ModelSettingsService.create(home, environment);
  expect(restarted.publicConfiguration()).toEqual(publicConfig);
  await restarted.update({
    role: "agent",
    enabled: false,
    clear_api_key: true,
  });
  expect(restarted.publicConfiguration().agent).toMatchObject({
    configured: false,
    enabled: false,
    api_key_configured: false,
  });
  await restarted.update({ role: "agent", reset: true });
  expect(restarted.publicConfiguration().agent).toMatchObject({
    configured: true,
    source: "environment",
    model: "agent-env",
    api_key_configured: true,
  });
});

test("serializes simultaneous role edits and rejects invalid updates without changing disk or memory", async () => {
  const { home, settings } = await fixture();
  await Promise.all([
    settings.update({ role: "vision", model: "vision-saved", enabled: true }),
    settings.update({ role: "text", model: "text-saved", enabled: true }),
  ]);
  const before = settings.publicConfiguration(),
    disk = await readFile(join(home, "model-settings.json"), "utf8");
  for (const body of [
    { role: "__proto__", model: "bad" },
    { role: "agent", base_url: "file:///tmp/PRIVATE_ENV_KEY" },
    { role: "agent", base_url: "https://u:PRIVATE_ENV_KEY@example.test/v1" },
    { role: "agent", api_key: 123 },
    { role: "agent", enabled: "true" },
    { role: "agent", unknown: "ignored?" },
    { role: "agent", reset: true, api_key: "PRIVATE_TEST" },
    { role: "agent", clear_api_key: true },
  ]) {
    await expect(settings.update(body)).rejects.toThrow();
    expect(settings.publicConfiguration()).toEqual(before);
    expect(await readFile(join(home, "model-settings.json"), "utf8")).toBe(
      disk,
    );
  }
  expect(before.vision.model).toBe("vision-saved");
  expect(before.text.model).toBe("text-saved");
  await settings.update({ role: "text", model: "text-next" });
  expect(settings.publicConfiguration().text.model).toBe("text-next");
});

test("a provider snapshot keeps a task on its original model after a setting change", async () => {
  const { settings } = await fixture();
  const routing = settings.routingProvider("agent");
  const original = routing.snapshot!();
  await settings.update({ role: "agent", model: "next-agent" });
  expect(routing.snapshot!()).not.toBe(original);
  await settings.update({ role: "agent", enabled: false });
  expect(() => routing.snapshot!()).toThrow("not configured");
});

test("does not expose credentials embedded in legacy endpoint URLs", async () => {
  const home = await mkdtemp(join(tmpdir(), "humanboard-model-settings-"));
  directories.push(home);
  const settings = await ModelSettingsService.create(home, {
    ...environment,
    HUMAN_MODEL_BASE_URL:
      "https://user:PRIVATE_ENV_KEY@example.test/v1?key=PRIVATE_ENV_KEY",
  });
  expect(settings.publicConfiguration().agent.base_url).toBeNull();
  expect(JSON.stringify(settings.publicConfiguration())).not.toContain(
    "PRIVATE_ENV_KEY",
  );
});

test("background roles may follow the Agent across edits and restarts without copying its secret", async () => {
  const { home, settings } = await fixture();
  await settings.update({ role: "vision", follow_agent: true, enabled: true });
  await settings.update({ role: "text", follow_agent: true, enabled: true });
  expect(settings.publicConfiguration().vision).toMatchObject({
    model: "agent-env",
    follow_agent: true,
    configured: true,
  });
  await settings.update({
    role: "agent",
    model: "next-agent",
    api_key: "PRIVATE_NEXT",
  });
  const restarted = await ModelSettingsService.create(home, environment);
  expect(restarted.publicConfiguration().text.model).toBe("next-agent");
  const disk = JSON.parse(
    await readFile(join(home, "model-settings.json"), "utf8"),
  );
  expect(disk.roles.text.api_key).toBeUndefined();
  await restarted.update({ role: "agent", enabled: false });
  expect(restarted.publicConfiguration().vision.configured).toBe(false);
  await expect(
    restarted.update({ role: "agent", follow_agent: true }),
  ).rejects.toThrow();
});
