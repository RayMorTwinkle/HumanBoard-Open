/** Deterministic text metrics shared by layout, browser SVG and server PNG. */
export function textWidth(text: string, fontSize: number): number {
  return (
    [...text].reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 1 : 0.55), 0) *
    fontSize
  );
}

export function wrapText(
  value: string,
  width: number,
  fontSize: number,
  maxLines = Infinity,
): string[] {
  if (maxLines <= 0 || !value.trim()) return [];
  const lines: string[] = [];
  for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    // Keep ordinary English words together; split only tokens wider than a whole line.
    const tokens =
      paragraph.trim().match(/[\p{Script=Latin}\p{N}_'’./:-]+|\s+|./gu) ?? [];
    for (const token of tokens) {
      const parts = textWidth(token, fontSize) > width ? [...token] : [token];
      for (const part of parts) {
        if (line && textWidth(line + part, fontSize) > width) {
          lines.push(line.trimEnd());
          line = "";
        }
        if (line || part.trim()) line += part;
      }
    }
    lines.push(line.trimEnd());
  }
  if (lines.length <= maxLines) return lines;
  const result = lines.slice(0, maxLines);
  let last = result[result.length - 1]!;
  while (last && textWidth(last + "…", fontSize) > width)
    last = [...last].slice(0, -1).join("");
  result[result.length - 1] = last.trimEnd() + "…";
  return result;
}

export function diagramNodeSize(
  title: string,
  sub: string | undefined,
  role: string,
) {
  const w = role === "decision" ? 260 : 220;
  const ratio = role === "decision" ? 0.5 : role === "terminal" ? 0.7 : 1;
  const width = w * ratio - 32;
  const titles = wrapText(title, width, 14);
  const descriptions = sub ? wrapText(sub, width, 12) : [];
  const contentHeight =
    30 +
    Math.max(0, titles.length - 1) * 18 +
    (descriptions.length ? 19 + (descriptions.length - 1) * 15 : 0) +
    14;
  return {
    w,
    h: Math.ceil(
      Math.max(role === "decision" ? 160 : 80, contentHeight / ratio),
    ),
  };
}
