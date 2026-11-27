import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HumanBoardError, type ModelProvider } from "@humanboard/core-engine";
import type { Environment } from "./config";
import {
  OpenAICompatibleModelProvider,
  publicModelConfiguration,
  resolveModelConfiguration,
  type ModelConfiguration,
  type ModelOverrides,
  type ModelRole,
} from "./model-provider";

const roles = ["agent", "vision", "text"] as const;
const usage = (message: string) => new HumanBoardError("E_USAGE", message);
export class ModelSettingsService {
  private overrides: ModelOverrides = {};
  private configuration!: ModelConfiguration;
  private providers: Partial<Record<ModelRole, ModelProvider>> = {};
  private writes: Promise<void> = Promise.resolve();
  private constructor(
    private readonly home: string,
    private readonly env: Environment,
    private readonly injected: Partial<Record<ModelRole, ModelProvider>>,
  ) {}
  static async create(
    home: string,
    env: Environment,
    injected: Partial<Record<ModelRole, ModelProvider>> = {},
  ) {
    const service = new ModelSettingsService(home, env, injected);
    try {
      const raw = JSON.parse(await readFile(service.file, "utf8"));
      service.overrides = service.validateFile(raw);
      await chmod(service.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw usage("Saved model settings are invalid or unreadable");
    }
    service.apply(service.overrides);
    return service;
  }
  private get file() {
    return join(this.home, "model-settings.json");
  }
  private validateFile(value: unknown): ModelOverrides {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw usage("Invalid model settings file");
    const source = value as Record<string, unknown>;
    if (
      source.version !== 1 ||
      !source.roles ||
      typeof source.roles !== "object" ||
      Array.isArray(source.roles)
    )
      throw usage("Invalid model settings version");
    const result: ModelOverrides = {};
    for (const [role, patch] of Object.entries(source.roles)) {
      if (!roles.includes(role as ModelRole))
        throw usage("Invalid saved model role");
      result[role as ModelRole] = this.validatePatch(patch);
      if (role === "agent" && result.agent?.follow_agent)
        throw usage("Agent cannot follow itself");
    }
    return result;
  }
  private validatePatch(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw usage("Model settings must be an object");
    const patch = value as Record<string, unknown>;
    if (
      Object.keys(patch).some(
        (key) =>
          !["model", "base_url", "api_key", "enabled", "follow_agent"].includes(
            key,
          ),
      )
    )
      throw usage("Unknown model setting");
    const result: NonNullable<ModelOverrides[ModelRole]> = {};
    for (const key of ["model", "base_url", "api_key"] as const) {
      if (patch[key] === undefined) continue;
      if (
        typeof patch[key] !== "string" ||
        patch[key].length > (key === "api_key" ? 8192 : 2048) ||
        /[\r\n\0]/.test(patch[key])
      )
        throw usage(`Invalid ${key}`);
      result[key] = patch[key].trim();
    }
    if (patch.follow_agent !== undefined) {
      if (typeof patch.follow_agent !== "boolean")
        throw usage("follow_agent must be a boolean");
      result.follow_agent = patch.follow_agent;
    }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean")
        throw usage("enabled must be a boolean");
      result.enabled = patch.enabled;
    }
    if (result.base_url) {
      let url: URL;
      try {
        url = new URL(result.base_url);
      } catch {
        throw usage("Model endpoint must be an HTTP or HTTPS URL");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw usage(
          "Model endpoint must use HTTP(S), with credentials in the API Key field",
        );
      result.base_url = url.href.replace(/\/+$/, "");
    }
    return result;
  }
  private apply(overrides: ModelOverrides) {
    const configuration = resolveModelConfiguration(this.env, overrides);
    const providers: Partial<Record<ModelRole, ModelProvider>> = {};
    for (const role of roles) {
      const config = configuration[role];
      if (config.source === "saved" && !config.enabled) continue;
      const injected = this.injected[config.follow_agent ? "agent" : role];
      if (injected) providers[role] = injected;
      else if (config.configured)
        providers[role] = new OpenAICompatibleModelProvider({
          ...config,
          timeoutMs:
            role === "agent" ? 60_000 : role === "vision" ? 20_000 : 10_000,
        });
    }
    this.configuration = configuration;
    this.providers = providers;
    this.overrides = overrides;
  }
  publicConfiguration() {
    return publicModelConfiguration(this.configuration);
  }
  provider(role: ModelRole) {
    return this.providers[role];
  }
  routingProvider(role: ModelRole): ModelProvider {
    const snapshot = () => {
      const provider = this.provider(role);
      if (!provider)
        throw new HumanBoardError(
          "E_USAGE",
          `HUMAN_${role.toUpperCase()}_MODEL is not configured`,
          {
            feature: role === "agent" ? "agent_chat" : `${role}_model`,
            env: `HUMAN_${role.toUpperCase()}_MODEL`,
            model_unconfigured: true,
            missing_env: this.configuration[role].missingEnv,
          },
        );
      return provider;
    };
    return { snapshot, generate: (input) => snapshot().generate(input) };
  }
  async waitForWrites(): Promise<void> {
    await this.writes;
  }
  async update(value: unknown): Promise<void> {
    // Serialize read-modify-write, so simultaneous role edits cannot lose one another.
    const operation = this.writes.then(async () => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw usage("Model settings must be an object");
      const body = value as Record<string, unknown>;
      const role = body.role as ModelRole;
      if (!roles.includes(role)) throw usage("Unknown model role");
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "role",
              "model",
              "base_url",
              "api_key",
              "enabled",
              "reset",
              "clear_api_key",
              "follow_agent",
            ].includes(key),
        )
      )
        throw usage("Unknown model setting");
      if (body.reset !== undefined && typeof body.reset !== "boolean")
        throw usage("reset must be a boolean");
      if (
        body.clear_api_key !== undefined &&
        typeof body.clear_api_key !== "boolean"
      )
        throw usage("clear_api_key must be a boolean");
      const next = structuredClone(this.overrides);
      if (body.reset) {
        if (Object.keys(body).some((key) => !["role", "reset"].includes(key)))
          throw usage("Reset cannot include other model edits");
        delete next[role];
      } else {
        const { role: _role, reset: _reset, clear_api_key, ...fields } = body;
        const patch = this.validatePatch(fields);
        if (role === "agent" && patch.follow_agent)
          throw usage("Agent cannot follow itself");
        // Empty password input is not an instruction to erase an existing secret.
        if (patch.api_key === "") delete patch.api_key;
        if (clear_api_key) {
          if (patch.api_key)
            throw usage("Cannot replace and clear the API Key together");
          patch.api_key = "";
        }
        next[role] = { ...next[role], ...patch };
        const effective = resolveModelConfiguration(this.env, next)[role];
        if (effective.enabled)
          this.validatePatch({ base_url: effective.baseUrl });
        if (
          effective.enabled &&
          !effective.configured &&
          !effective.follow_agent
        )
          throw usage(
            "Enabled model requires a model name, endpoint and API Key",
          );
      }
      const temporary = this.file + "." + crypto.randomUUID() + ".tmp";
      await mkdir(this.home, { recursive: true });
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, roles: next }) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.apply(next);
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
}
