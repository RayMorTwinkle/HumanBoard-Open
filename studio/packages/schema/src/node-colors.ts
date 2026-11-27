/** A single authored color; theme-specific surfaces and ink are derived. */
export const NODE_COLORS = {
  slate: "#64748b",
  blue: "#5278c5",
  teal: "#29877f",
  green: "#58854b",
  amber: "#b47b27",
  purple: "#8b65b5",
  rose: "#b65d78",
} as const;
export function resolveNodeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return (
    NODE_COLORS[value as keyof typeof NODE_COLORS] ??
    (/^#[0-9a-f]{6}$/i.test(value) ? value : undefined)
  );
}
function mix(a: string, b: string, amount: number): string {
  return (
    "#" +
    [1, 3, 5]
      .map((i) =>
        Math.round(
          parseInt(a.slice(i, i + 2), 16) * (1 - amount) +
            parseInt(b.slice(i, i + 2), 16) * amount,
        )
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export function nodeColorPalette(value: unknown, dark: boolean) {
  const base = resolveNodeColor(value);
  if (!base) return;
  return {
    stroke: base,
    fill: mix(base, dark ? "#18181b" : "#ffffff", dark ? 0.82 : 0.91),
    text: mix(base, dark ? "#ffffff" : "#111827", dark ? 0.78 : 0.65),
  };
}
