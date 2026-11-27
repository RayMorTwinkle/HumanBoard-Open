/** A local-first app must not send its loopback API traffic through an environment proxy. */
export function configureLoopbackBypass(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = new Set(
      (env[key] ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"])
      entries.add(host);
    env[key] = [...entries].join(",");
  }
}
