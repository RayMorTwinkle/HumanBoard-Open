import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentConfigData,
  AgentRoleConfig,
  ModelRole,
  ModelSettingsUpdate,
} from "../client/types";
const labels: Record<ModelRole, string> = {
  agent: "内置 Agent",
  vision: "图片命名",
  text: "版本标题",
};
const descriptions: Record<ModelRole, string> = {
  agent:
    "用于多轮对话、按需读图和工具调用。请选择支持图片输入与工具调用的模型。",
  vision: "用于识别图片并生成简短标题。请选择支持图片输入的模型。",
  text: "为时间线中的每个 Layer（版本快照）取名，概括这次保存改了什么；不是画布内节点的标题。",
};
const roles: ModelRole[] = ["agent", "vision", "text"];
const formFrom = (config: AgentRoleConfig) => ({
  model: config.model ?? "",
  base_url: config.base_url ?? "",
  api_key: "",
  enabled: config.enabled ?? config.configured,
  clear_api_key: false,
  follow_agent: config.follow_agent ?? false,
});
export function ModelSettingsPanel({
  config,
  onSave,
  onClose,
}: {
  config: AgentConfigData;
  onSave: (value: ModelSettingsUpdate) => Promise<AgentConfigData>;
  onClose: () => void;
}) {
  const [role, setRole] = useState<ModelRole>("agent");
  const [forms, setForms] = useState(
    () =>
      Object.fromEntries(roles.map((r) => [r, formFrom(config[r])])) as Record<
        ModelRole,
        ReturnType<typeof formFrom>
      >,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current
      ?.querySelector<HTMLButtonElement>('button[aria-label="关闭模型设置"]')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const items = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
          ) ?? [],
        );
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  const form = forms[role];
  const update = (patch: Partial<typeof form>) => {
    setForms((old) => ({ ...old, [role]: { ...old[role], ...patch } }));
    setError(null);
    setNotice(null);
  };
  const save = async (reset = false) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await onSave(
        reset
          ? { role, reset: true }
          : role !== "agent" && form.follow_agent
            ? { role, follow_agent: true, enabled: form.enabled }
            : { role, ...form },
      );
      setForms((old) => ({ ...old, [role]: formFrom(next[role]) }));
      setNotice(
        reset
          ? "已恢复启动配置。"
          : "已保存，后续任务将使用新配置。正在运行的任务继续使用原配置。",
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const content = (
    <div className="model-settings-overlay">
      <div
        className="model-settings-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="model-settings-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
      >
        <header>
          <div>
            <h2 id="model-settings-title">模型设置</h2>
            <p>连接兼容 OpenAI 的 Chat Completions 服务</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭模型设置">
            ×
          </button>
        </header>
        <nav aria-label="模型用途">
          {roles.map((r) => (
            <button
              type="button"
              key={r}
              aria-pressed={role === r}
              disabled={busy}
              onClick={() => {
                setRole(r);
                setError(null);
                setNotice(null);
              }}
            >
              {labels[r]}
              <span>
                {config[r].configured
                  ? "已配置"
                  : config[r].enabled === false
                    ? "未启用"
                    : "未配置"}
              </span>
            </button>
          ))}
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="model-purpose">{descriptions[role]}</p>
          <label className="model-enable">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(event) =>
                update({ enabled: event.target.checked, clear_api_key: false })
              }
            />
            启用{labels[role]}
          </label>
          {role !== "agent" && (
            <label className="model-enable">
              <input
                type="checkbox"
                aria-label="跟随主 Agent 模型"
                checked={form.follow_agent}
                disabled={busy}
                onChange={(e) => update({ follow_agent: e.target.checked })}
              />
              跟随主 Agent 模型
            </label>
          )}
          {role !== "agent" && form.follow_agent && (
            <p className="model-key-note">
              使用主 Agent 的模型、服务地址和密钥。修改主 Agent
              配置后，后续命名任务自动跟随。
            </p>
          )}
          <fieldset
            disabled={busy || (role !== "agent" && form.follow_agent)}
            className="model-connection-fields"
          >
            <label>
              模型名称
              <input
                aria-label="模型名称"
                value={form.model}
                required={form.enabled}
                maxLength={2048}
                disabled={busy}
                autoComplete="off"
                placeholder="服务商提供的模型 ID"
                onChange={(event) => update({ model: event.target.value })}
              />
            </label>
            <label>
              服务地址
              <input
                aria-label="模型服务地址"
                type="url"
                value={form.base_url}
                required={form.enabled}
                maxLength={2048}
                disabled={busy}
                autoComplete="off"
                placeholder="https://api.example.com/v1"
                onChange={(event) => update({ base_url: event.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                aria-label="模型 API Key"
                type="password"
                value={form.api_key}
                maxLength={8192}
                disabled={busy}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  config[role].api_key_configured
                    ? "已配置 · 留空保留现有密钥"
                    : "输入 API Key"
                }
                onChange={(event) =>
                  update({ api_key: event.target.value, clear_api_key: false })
                }
              />
            </label>
            <p className="model-key-note">
              密钥仅保存在服务端，保存后不会回显。
            </p>
            {config[role].api_key_configured && (
              <label className="model-clear-key">
                <input
                  type="checkbox"
                  checked={form.clear_api_key}
                  disabled={busy}
                  onChange={(event) =>
                    update({
                      clear_api_key: event.target.checked,
                      ...(event.target.checked
                        ? { api_key: "", enabled: false }
                        : {}),
                    })
                  }
                />
                清除密钥并停用此模型
              </label>
            )}
          </fieldset>
          <div className="model-settings-source">
            当前配置：
            {config[role].source === "saved" ? "应用中保存" : "服务启动配置"} ·
            自动命名{config.titles?.enabled ? "已开启" : "已关闭"}
          </div>
          {error && (
            <p className="model-settings-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="model-settings-notice" role="status">
              {notice}
            </p>
          )}
          <footer>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              恢复启动配置
            </button>
            <button
              type="submit"
              className="model-settings-save"
              disabled={busy}
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : content;
}
