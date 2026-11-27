import { ZodError } from "zod";

/**
 * Validation failures as short lines an agent can act on, e.g.
 * `edges[0].to.side: required, one of top|right|bottom|left`.
 */
export function describeSchemaIssues(
  error: unknown,
  limit = 8,
  scene?: unknown,
): string[] {
  if (!(error instanceof ZodError)) return [String(error)];
  // An edge to a missing card also fails on its side; name the real cause instead.
  const dangling = danglingEnds(scene);
  const issues = error.issues.filter(
    (issue) =>
      !dangling.some(
        (d) =>
          issue.path[0] === "edges" &&
          issue.path[1] === d.index &&
          (issue.path[2] === "from" || issue.path[2] === "to"),
      ),
  );
  const lines = [
    ...dangling.map((d) => `edges[${d.index}].${d.end}: unknown node ${d.id}`),
    ...issues.slice(0, limit).map((issue) => {
      const path = issue.path.reduce<string>(
        (text, key) =>
          typeof key === "number"
            ? `${text}[${key}]`
            : text
              ? `${text}.${String(key)}`
              : String(key),
        "",
      );
      const at = path || "(root)";
      const raw = issue as unknown as {
        values?: readonly unknown[];
        keys?: readonly string[];
        expected?: string;
      };
      if (raw.values?.length)
        return `${at}: must be one of ${raw.values.map(String).join("|")}`;
      if (issue.code === "unrecognized_keys" && raw.keys)
        return `${at}: unknown key ${raw.keys.join(", ")}`;
      if (
        issue.code === "invalid_type" &&
        /received undefined/.test(issue.message)
      )
        return `${at}: required${raw.expected ? ` (${raw.expected})` : ""}`;
      return `${at}: ${issue.message}`;
    }),
  ];
  const more = issues.length - Math.min(issues.length, limit);
  return more > 0 ? [...lines, `…and ${more} more`] : lines;
}

function danglingEnds(scene: unknown) {
  const out: { index: number; end: "from" | "to"; id: string }[] = [];
  if (typeof scene !== "object" || scene === null) return out;
  const { nodes, edges } = scene as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return out;
  const ids = new Set(nodes.map((n) => (n as { id?: unknown })?.id));
  edges.forEach((edge, index) => {
    for (const end of ["from", "to"] as const) {
      const anchor = (edge as Record<string, unknown> | null)?.[end];
      const id = (anchor as { node_id?: unknown } | null)?.node_id;
      if (typeof id === "string" && !ids.has(id)) out.push({ index, end, id });
    }
  });
  return out;
}
