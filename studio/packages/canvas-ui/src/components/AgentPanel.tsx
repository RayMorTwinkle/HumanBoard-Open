import { submitAgentMessage } from "../agent-composer";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { ChatDiffCard } from "./ChatDiffCard";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AgentConfigData,
  ModelSettingsUpdate,
  AgentRunData,
  AgentToolTraceData,
} from "../client/types";

export interface AgentChatMessageView {
  readonly reasoning_steps?: readonly { step: number; content: string }[];
  readonly tool_trace?: readonly AgentToolTraceData[];
  readonly result_layer_id?: string | null;
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface AgentPanelProps {
  readonly onSaveModelSettings?: (
    value: ModelSettingsUpdate,
  ) => Promise<AgentConfigData>;
  readonly projectId?: string;
  readonly spaceId?: string;
  readonly run?: AgentRunData | null;
  readonly onCancel?: () => void;
  readonly onViewLayer?: (id: string) => void;
  readonly onCompare?: (id: string) => void;
  readonly config: AgentConfigData | null;
  readonly messages: readonly AgentChatMessageView[];
  readonly pending: boolean;
  readonly editingLocked?: boolean;
  readonly error: string | null;
  readonly rightPanelOpen: boolean;
  /** Kept mounted while closed so it can slide away and keep the typed draft. */
  readonly closed?: boolean;
  readonly onSend: (
    message: string,
  ) => void | boolean | Promise<void | boolean>;
  readonly onClose: () => void;
  readonly branchNotice?: string | null;
}

export function AgentPanel({
  projectId,
  spaceId,
  config,
  messages,
  pending,
  editingLocked = false,
  error,
  rightPanelOpen,
  closed = false,
  onSend,
  onClose,
  branchNotice,
  run,
  onCancel,
  onViewLayer,
  onCompare,
  onSaveModelSettings,
}: AgentPanelProps) {
  const [message, setMessage] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const resize = () => {
      if (!composerRef.current) return;
      composerRef.current.style.height = "auto";
      composerRef.current.style.height = `${Math.min(100, composerRef.current.scrollHeight)}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [message]);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [messages.length, pending, run?.partial_message, run?.step]);
  const configured = config?.agent.configured ?? false;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const value = message.trim();
    if (value.length === 0 || pending || editingLocked || !configured) {
      return;
    }
    const accepted = await submitAgentMessage(
      value,
      { configured, pending, editingLocked },
      onSend,
    );
    if (accepted)
      setMessage((current) => (current.trim() === value ? "" : current));
  };

  return (
    <aside
      className={`agent-panel ${rightPanelOpen ? "is-offset" : ""}`}
      aria-label="内置 Agent"
      inert={closed}
    >
      <div className="agent-panel-heading">
        <div className="agent-heading-text">
          <h2>内置 Agent</h2>
          <span>{configured ? config?.agent.model : "未连接模型"}</span>
        </div>
        {onSaveModelSettings && (
          <button
            type="button"
            className="agent-model-settings-trigger"
            aria-label="模型设置"
            disabled={!config}
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
        )}
        <button
          type="button"
          className="panel-collapse"
          onClick={onClose}
          aria-label="关闭 Agent 面板"
          title="关闭 Agent"
        >
          ×
        </button>
      </div>

      <details className="agent-settings">
        <summary>模型与自动命名状态</summary>

        <div className="agent-model-strip">
          <span className={configured ? "is-ready" : "is-missing"}>
            {config === null
              ? "读取模型配置…"
              : configured
                ? config.agent.model
                : "Agent 未配置"}
          </span>
          <span className="font-mono">HUMAN_AGENT_MODEL</span>
        </div>
        {config?.titles ? (
          <div className="agent-title-strip">
            <span>自动标题 {config.titles.enabled ? "开启" : "关闭"}</span>
            <span>
              完成 {config.titles.queue.completed} · 跳过{" "}
              {config.titles.queue.skipped} · 失败 {config.titles.queue.failed}
            </span>
          </div>
        ) : null}
      </details>
      {config !== null && !configured ? (
        <div className="agent-config-warning" role="status">
          <strong>聊天面板已置灰</strong>
          <span>
            {onSaveModelSettings
              ? "点击上方「模型设置」即可连接服务。也可在启动前设置："
              : "在启动 human serve 前配置："}
          </span>
          <code>{config.agent.missing_env.join("\n")}</code>
        </div>
      ) : null}

      {branchNotice && (
        <div className="agent-config-warning" role="status">
          {branchNotice}
        </div>
      )}
      {settingsOpen && config && onSaveModelSettings && (
        <ModelSettingsPanel
          config={config}
          onSave={onSaveModelSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <div className="agent-messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="agent-empty">
            <svg
              className="agent-empty-sketch"
              viewBox="0 0 176 64"
              aria-hidden="true"
            >
              <path
                className="sk-ink"
                d="M16 36c-1-13 17-22 31-17 12 4 13 19 1 26-12 7-31 3-32-9z"
              />
              <path className="sk-ink" d="M26 33c4-4 7 3 11-1s7 2 10-1" />
              <path className="sk-arrow" d="M68 32h30" />
              <path className="sk-arrow" d="M93 27l6 5-6 5" />
              <rect
                className="sk-node"
                x="114"
                y="8"
                width="50"
                height="18"
                rx="5"
              />
              <rect
                className="sk-node"
                x="114"
                y="40"
                width="50"
                height="18"
                rx="5"
              />
              <path className="sk-link" d="M139 26v14" />
            </svg>
            <strong>一起，把想法推演下去。</strong>
            <span>
              画几笔草图，放一张参考图，
              <br />
              或直接告诉我你想改哪里。
            </span>
            <small>每次修改都会留下新的一层。</small>
          </div>
        ) : (
          messages.map((item) => (
            <div className={`agent-message is-${item.role}`} key={item.id}>
              <span className="message-avatar">
                {item.role === "user" ? "你" : "AI"}
              </span>
              <div className="agent-message-body">
                {(!!item.reasoning_steps?.length ||
                  !!item.tool_trace?.length) && (
                  <AgentProcess
                    steps={item.reasoning_steps}
                    trace={item.tool_trace}
                  />
                )}
                {item.role === "assistant" ? (
                  <div className="agent-markdown">
                    <AgentMarkdown content={item.content} />
                  </div>
                ) : (
                  <p>{item.content}</p>
                )}
                {item.role === "assistant" && item.result_layer_id && (
                  <div>
                    <ChatDiffCard
                      layerId={item.result_layer_id}
                      projectId={projectId}
                      spaceId={spaceId}
                    />
                    <div className="agent-layer-actions">
                      <button
                        type="button"
                        onClick={() => onViewLayer?.(item.result_layer_id!)}
                      >
                        查看本轮结果
                      </button>
                      <button
                        type="button"
                        data-diff-trigger
                        onClick={() => onCompare?.(item.result_layer_id!)}
                      >
                        比较父层变化
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {pending &&
          (!!run?.reasoning_steps?.length || !!run?.tool_trace.length) && (
            <AgentProcess
              live
              steps={run.reasoning_steps}
              trace={run.tool_trace}
              activeStep={
                run.phase === "thinking" && !run.partial_message
                  ? run.step
                  : undefined
              }
            />
          )}
        {pending && run?.partial_message ? (
          <div
            className="agent-message is-assistant is-streaming"
            aria-label="正在生成的回复"
          >
            <span className="message-avatar">AI</span>
            <div className="agent-message-body agent-markdown">
              <AgentMarkdown content={run.partial_message} />
            </div>
          </div>
        ) : null}
        {pending ? (
          <div className="agent-pending" role="status">
            <span className="pulse-dot" />
            {run
              ? `${run.phase === "tool" ? "正在调用工具" : "思考中"} · 第 ${run.step} 步`
              : "生成中…"}
            {onCancel && (
              <button type="button" onClick={onCancel}>
                停止本轮
              </button>
            )}
          </div>
        ) : null}
        <div ref={messagesEnd} />
      </div>

      {error ? <div className="agent-error">{error}</div> : null}

      <form className="agent-composer" onSubmit={submit}>
        <div className="composer-suggestions">
          {["转化手绘为逻辑图", "补充遗漏的分支", "解释当前画板"].map(
            (suggestion) => (
              <button
                type="button"
                key={suggestion}
                disabled={!configured || pending || editingLocked}
                onClick={() => setMessage(suggestion)}
              >
                @{suggestion}
              </button>
            ),
          )}
        </div>
        <div className="composer-input-row">
          <textarea
            ref={composerRef}
            value={message}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={
              configured
                ? "和内置 Agent 对话，或描述要改的地方…"
                : "配置 HUMAN_AGENT_MODEL 后即可使用"
            }
            rows={1}
            disabled={!configured || pending || editingLocked}
            aria-label="发送给内置 Agent 的消息"
          />

          <button
            type="submit"
            className="agent-send"
            aria-label="发送消息"
            disabled={
              !configured ||
              pending ||
              editingLocked ||
              message.trim().length === 0
            }
          >
            <span aria-hidden="true">{pending ? "···" : "↑"}</span>
          </button>
        </div>
        <div className="agent-composer-foot">
          <span>AI 按需读取画板 · Enter 发送，Shift Enter 换行</span>
        </div>
      </form>
    </aside>
  );
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  humanboard_capture: "读取当前画板",
  humanboard_layers: "查看历史",
  humanboard_get: "读取画板",
  humanboard_diff: "比较变化",
  humanboard_inspect: "精读资产",
  humanboard_draft: "修改私有草稿",
  humanboard_preview: "查看草稿预览",
  humanboard_commit: "提交新层",
  humanboard_discard: "放弃草稿",
};
/**
 * Thoughts and tool calls in the order they happened: each model step thinks,
 * then calls its tools. Live runs stay expanded; finished ones fold into one line.
 */
function AgentProcess({
  steps = [],
  trace = [],
  live = false,
  activeStep,
}: {
  steps?: readonly { step: number; content: string }[];
  trace?: readonly AgentToolTraceData[];
  live?: boolean;
  activeStep?: number;
}) {
  const order = [
    ...new Set([...steps.map((s) => s.step), ...trace.map((t) => t.step)]),
  ].sort((a, b) => a - b);
  const timeline = (
    <ol className="agent-process-steps">
      {order.map((step) => {
        const thought = steps.find((s) => s.step === step);
        return (
          <li key={step}>
            {thought && (
              <ReasoningBlock
                content={thought.content}
                step={step}
                live={live && activeStep === step}
              />
            )}
            {trace
              .filter((event) => event.step === step)
              .map((event, index) => (
                <div
                  className="agent-tool-call"
                  key={`${event.id}:${index}`}
                  data-status={event.status}
                >
                  <span aria-hidden="true">
                    {event.status === "running"
                      ? "◌"
                      : event.status === "completed"
                        ? "✓"
                        : "!"}
                  </span>
                  <div>
                    <strong>{TOOL_LABELS[event.tool] ?? event.tool}</strong>
                    <small>{event.summary}</small>
                  </div>
                </div>
              ))}
          </li>
        );
      })}
    </ol>
  );
  if (live) return <div className="agent-process is-live">{timeline}</div>;
  return (
    <details className="agent-process">
      <summary>
        思考和工具调用过程 · {order.length} 步
        {trace.length ? ` · ${trace.length} 次调用` : ""}
      </summary>
      {timeline}
    </details>
  );
}

function ReasoningBlock({
  content,
  step,
  live,
}: {
  content: string;
  step: number;
  live: boolean;
}) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <details
      className="agent-reasoning"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {live ? "思考中" : "思考"} · 第 {step} 步
      </summary>
      <div className="agent-markdown">
        <AgentMarkdown content={content} />
      </div>
    </details>
  );
}

function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        img: ({ alt }) => (
          <span className="model-image-reference">
            {alt ? `[图片：${alt}]` : "[图片]"}
          </span>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
