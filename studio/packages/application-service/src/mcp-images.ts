import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Only load our own rendered cache files. Never fetch arbitrary URLs from tool data. */
export async function mcpImages(
  data: unknown,
  cacheDir: string,
): Promise<{ data: string; mimeType: "image/png" }[]> {
  const d = data as {
    render?: { url?: string };
    content?: { url?: string };
    preview_url?: string;
    visual?: {
      before?: { url?: string };
      after?: { url?: string };
      highlight?: { url?: string };
    };
  } | null;
  const urls = [
    d?.render?.url,
    d?.content?.url,
    d?.preview_url,
    d?.visual?.before?.url,
    d?.visual?.after?.url,
    d?.visual?.highlight?.url,
  ];
  const result: { data: string; mimeType: "image/png" }[] = [];
  for (const raw of [
    ...new Set(urls.filter((v): v is string => typeof v === "string")),
  ]) {
    const url = new URL(raw);
    let path: string;
    if (url.protocol === "file:") path = fileURLToPath(url);
    else if (/^\/render\/[A-Za-z0-9-]+\.png$/.test(url.pathname))
      path = join(cacheDir, "renders", url.pathname.split("/").at(-1)!);
    else continue;
    const actual = await realpath(path);
    const rel = relative(await realpath(cacheDir), actual);
    if (
      isAbsolute(rel) ||
      rel.startsWith("..") ||
      !/^(renders|inspect)[/\\][A-Za-z0-9-]+\.png$/.test(rel)
    )
      continue;
    const bytes = await readFile(actual);
    if (
      bytes.length > 20 * 1024 * 1024 ||
      bytes.subarray(1, 4).toString() !== "PNG"
    )
      continue;
    result.push({ data: bytes.toString("base64"), mimeType: "image/png" });
  }
  return result;
}
