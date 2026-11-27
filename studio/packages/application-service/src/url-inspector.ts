import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import {
  HumanBoardError,
  isPublicNetworkAddress,
} from "@humanboard/core-engine";

export { isPublicNetworkAddress };

export interface UrlInspectResult {
  readonly final_url: string;
  readonly markdown: string;
  readonly description?: string;
  readonly title: string;
  readonly content_type: "text/html" | "text/plain";
  readonly fetched_at: string;
  readonly truncated: boolean;
  readonly untrusted: true;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface UrlInspectDependencies {
  readonly resolve?: (url: URL) => Promise<ResolvedAddress>;
  readonly request?: (
    url: URL,
    resolved: ResolvedAddress,
    timeoutMs: number,
  ) => Promise<RawResponse>;
}

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_INSPECT_MARKDOWN_CODE_POINTS = 48_000;

function blocked(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  reason: "url_security" | "fetch_failed" = "url_security",
): HumanBoardError {
  return new HumanBoardError("E_URL_BLOCKED", message, {
    reason,
    ...details,
  });
}

function parseUrl(sourceUrl: string): URL {
  try {
    return new URL(sourceUrl);
  } catch {
    throw blocked("URL is malformed", { url: sourceUrl });
  }
}

function assertPublicAddress(resolved: ResolvedAddress): void {
  const publicAddress = isPublicNetworkAddress(resolved.address);
  if (!publicAddress) {
    throw blocked(
      "URL resolves to a private, loopback, link-local, or reserved address",
      {
        address: resolved.address,
        family: resolved.family,
      },
    );
  }
}

function networkHostname(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function assertHttpUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw blocked("Only http and https URLs are allowed", {
      protocol: url.protocol,
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw blocked("URL credentials are not allowed");
  }
}

async function resolvePublicAddress(url: URL): Promise<ResolvedAddress> {
  assertHttpUrl(url);

  const hostname = networkHostname(url);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw blocked("Cannot resolve URL hostname", {
      hostname,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (addresses.length === 0) {
    throw blocked("URL hostname resolved to no addresses", { hostname });
  }
  for (const address of addresses) {
    if (address.family !== 4 && address.family !== 6) {
      throw blocked("URL resolved to an unsupported address family", address);
    }
    assertPublicAddress({
      address: address.address,
      family: address.family,
    });
  }
  const first = addresses[0]!;
  return {
    address: first.address,
    family: first.family as 4 | 6,
  };
}

export async function validatePublicUrl(sourceUrl: string): Promise<URL> {
  const url = parseUrl(sourceUrl);
  await resolvePublicAddress(url);
  return url;
}

function headerValue(
  headers: RawResponse["headers"],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

function requestPinned(
  url: URL,
  resolved: ResolvedAddress,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
    const finishResolve = (response: RawResponse): void => {
      if (!settled) {
        settled = true;
        if (absoluteTimer !== null) {
          clearTimeout(absoluteTimer);
          absoluteTimer = null;
        }
        resolvePromise(response);
      }
    };
    const finishReject = (error: unknown): void => {
      if (!settled) {
        settled = true;
        if (absoluteTimer !== null) {
          clearTimeout(absoluteTimer);
          absoluteTimer = null;
        }
        rejectPromise(error);
      }
    };
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options = {
      protocol: url.protocol,
      hostname: resolved.address,
      port: url.port.length > 0 ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      headers: {
        Host: url.host,
        Accept: "text/html, text/plain;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "HumanBoard/0.0.0",
      },
      ...(url.protocol === "https:"
        ? {
            servername: networkHostname(url),
            checkServerIdentity: (
              _hostname: string,
              certificate: PeerCertificate,
            ) => checkServerIdentity(networkHostname(url), certificate),
          }
        : {}),
    };
    const request = transport(options, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        finishResolve({
          status,
          headers: response.headers,
          body: Buffer.alloc(0),
        });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          response.destroy();
          finishReject(
            blocked(
              "URL response exceeds 2 MB",
              {
                max_bytes: MAX_BODY_BYTES,
                size,
              },
              "fetch_failed",
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finishResolve({
          status,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.on("error", finishReject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        blocked(
          "URL request timed out",
          { timeout_ms: timeoutMs },
          "fetch_failed",
        ),
      );
    });
    absoluteTimer = setTimeout(() => {
      request.destroy(
        blocked(
          "URL request timed out",
          { timeout_ms: timeoutMs },
          "fetch_failed",
        ),
      );
    }, timeoutMs);
    request.on("error", finishReject);
    request.end();
  });
}

/** Parse fetched HTML only: JSDOM runs no scripts and loads no subresources. */
/** Load the HTML parser only when a caller actually inspects a web page. */
export async function extractReadablePage(html: string, sourceUrl?: string) {
  const extractor = await import("./webpage-extractor");
  return extractor.extractReadablePage(html, sourceUrl);
}
/** Legacy export kept for callers; extraction now uses Readability + Turndown. */
export const htmlToMarkdownFallback = extractReadablePage;

export function truncateMarkdownContent(
  markdown: string,
  maxCodePoints = MAX_INSPECT_MARKDOWN_CODE_POINTS,
): { readonly markdown: string; readonly truncated: boolean } {
  const characters = Array.from(markdown);
  if (characters.length <= maxCodePoints) {
    return { markdown, truncated: false };
  }
  const marker = "\n\n[content truncated]";
  const markerLength = Array.from(marker).length;
  const body = characters
    .slice(0, Math.max(0, maxCodePoints - markerLength))
    .join("")
    .trimEnd();
  return {
    markdown: `${body}${marker}`,
    truncated: true,
  };
}

function contentType(
  headers: RawResponse["headers"],
): "text/html" | "text/plain" {
  const raw = headerValue(headers, "content-type")?.toLowerCase() ?? "";
  const mime = raw.split(";")[0]!.trim();
  if (mime === "text/html" || mime === "text/plain") {
    return mime;
  }
  throw blocked(
    "URL response Content-Type is not text/html or text/plain",
    { content_type: raw || null },
    "fetch_failed",
  );
}

export async function inspectPublicUrl(
  sourceUrl: string,
  dependencies: UrlInspectDependencies = {},
): Promise<UrlInspectResult> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let current = parseUrl(sourceUrl);
  const resolve = dependencies.resolve ?? resolvePublicAddress;
  const request = dependencies.request ?? requestPinned;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    assertHttpUrl(current);
    const resolved = await resolve(current);
    assertPublicAddress(resolved);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw blocked(
        "URL request timed out",
        {
          timeout_ms: REQUEST_TIMEOUT_MS,
        },
        "fetch_failed",
      );
    }
    const response = await request(current, resolved, remaining);
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location) {
        throw blocked(
          "URL redirect is missing Location",
          { status: response.status },
          "fetch_failed",
        );
      }
      if (redirect === MAX_REDIRECTS) {
        throw blocked(
          "URL exceeded the redirect limit",
          { max_redirects: MAX_REDIRECTS },
          "fetch_failed",
        );
      }
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HumanBoardError(
        "E_NOT_FOUND",
        `URL returned HTTP ${response.status}`,
        { url: current.href, status: response.status },
      );
    }

    const mime = contentType(response.headers);
    const body = new TextDecoder("utf-8", { fatal: false }).decode(
      response.body,
    );
    const extracted =
      mime === "text/html"
        ? await extractReadablePage(body, current.href)
        : { title: "", markdown: body.trim() };
    const truncated = truncateMarkdownContent(extracted.markdown);
    return {
      final_url: current.href,
      markdown: truncated.markdown,
      title: extracted.title,
      description: "description" in extracted ? extracted.description : "",
      content_type: mime,
      fetched_at: new Date().toISOString(),
      truncated: truncated.truncated,
      untrusted: true,
    };
  }
  throw blocked(
    "URL exceeded the redirect limit",
    { max_redirects: MAX_REDIRECTS },
    "fetch_failed",
  );
}
