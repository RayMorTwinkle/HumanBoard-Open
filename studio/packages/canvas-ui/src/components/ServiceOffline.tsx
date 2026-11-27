import { useState } from "react";
import type { ConnectionState } from "../store/useBoardStore";

interface ServiceOfflineProps {
  readonly connection: ConnectionState;
  readonly error: string | null;
  readonly onRetry: () => void;
}

export function ServiceOffline({
  connection,
  error,
  onRetry,
}: ServiceOfflineProps) {
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState("");
  if (connection === "connected") {
    return null;
  }
  const checking = connection === "checking";
  const auth = error?.includes("E_AUTH");
  return (
    <div className="service-overlay" role="alert">
      <div className="service-card">
        <div className={`service-signal ${checking ? "is-checking" : ""}`}>
          <span />
          <span />
          <span />
        </div>
        <div className="panel-kicker">
          {checking ? "Connecting" : "Dependency unavailable"}
        </div>
        <h1>
          {checking
            ? "正在连接 HumanBoard"
            : auth
              ? "连接你的画板"
              : "服务未启动"}
        </h1>
        <p>
          {checking
            ? "检查 127.0.0.1:4317 的本地服务与项目绑定。"
            : "前端已经加载，但还没有拿到可用的后端状态。"}
        </p>
        {auth && (
          <form
            className="access-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await fetch("/api/auth", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-HumanBoard-Client": "1",
                  },
                  body: JSON.stringify({ token }),
                });
                if (!r.ok)
                  throw new Error(
                    "访问令牌不正确，或请求过于频繁。请稍后再试。",
                  );
                setToken("");
                setAuthError("");
                onRetry();
              } catch (e) {
                setAuthError(String(e));
              }
            }}
          >
            <input
              aria-label="访问令牌"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="current-password"
              placeholder="访问令牌"
              required
            />
            <button type="submit">连接</button>
            {authError && <p>{authError}</p>}
          </form>
        )}
        {!checking && !auth ? (
          <pre>
            <code>human serve</code>
          </pre>
        ) : null}
        {error ? <div className="service-error">{error}</div> : null}
        <button type="button" onClick={onRetry} disabled={checking}>
          {checking ? "检查中…" : "重新连接"}
        </button>
        <small>启动后点「重新连接」，你的画板会在这里恢复。</small>
      </div>
    </div>
  );
}
