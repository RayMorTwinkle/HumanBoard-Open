export interface ServerHealth {
  readonly instanceId?: string;
  readonly healthy: boolean;
  readonly status: number | null;
  readonly reason: "healthy" | "auth" | "http" | "network" | "invalid_response";
}

export async function checkServerHealth(
  serverBase: URL,
  options: {
    readonly token?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<ServerHealth> {
  const healthUrl = new URL("/health", serverBase);
  let response: Response;
  try {
    response = await fetch(healthUrl, {
      headers:
        options.token === undefined || options.token.length === 0
          ? {}
          : { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 1000),
    });
  } catch {
    return { healthy: false, status: null, reason: "network" };
  }

  if (response.status === 401 || response.status === 403) {
    return { healthy: false, status: response.status, reason: "auth" };
  }
  if (!response.ok) {
    return { healthy: false, status: response.status, reason: "http" };
  }

  try {
    const body = (await response.json()) as {
      ok?: unknown;
      service?: unknown;
      instance_id?: unknown;
    };
    if (body.ok === true && body.service === "humanboard") {
      return {
        healthy: true,
        status: response.status,
        reason: "healthy",
        ...(typeof body.instance_id === "string"
          ? { instanceId: body.instance_id }
          : {}),
      };
    }
  } catch {
    // The response shape below distinguishes a reachable non-HumanBoard server.
  }
  return {
    healthy: false,
    status: response.status,
    reason: "invalid_response",
  };
}
