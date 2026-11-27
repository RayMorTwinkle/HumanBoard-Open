import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { HumanBoardError } from "@humanboard/core-engine";

import { readImageMetadata } from "../src/image-metadata";
import {
  extractReadablePage,
  htmlToMarkdownFallback,
  inspectPublicUrl,
  isPublicNetworkAddress,
  truncateMarkdownContent,
} from "../src/url-inspector";

describe("inspect helpers", () => {
  test("reads PNG dimensions and rejects unsupported image bytes", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
      "base64",
    );
    expect(readImageMetadata(png)).toEqual({
      format: "png",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });

    try {
      readImageMetadata(Buffer.from("not an image"));
      throw new Error("expected readImageMetadata to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardError);
      expect((error as HumanBoardError).code).toBe("E_USAGE");
      expect((error as HumanBoardError).details.reason).toBe(
        "unsupported_image_format",
      );
    }
  });

  test("reads JPEG dimensions from the CLI fixture", async () => {
    const jpeg = await readFile(
      resolve(import.meta.dir, "../testdata/minimal.jpg"),
    );
    expect(readImageMetadata(jpeg)).toEqual({
      format: "jpeg",
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
    });
  });

  test("extracts readable content and metadata while removing page noise", async () => {
    const result = await htmlToMarkdownFallback(`
      <html>
        <head>
          <title>Fallback title</title>
          <meta property="og:title" content="Retry &amp; Recovery">
          <meta name="description" content="How retries should be bounded.">
          <meta name="author" content="Platform Team">
          <style>.hidden { display: none; }</style>
          <script>alert("ignore")</script>
        </head>
        <body>
          <header>
            <nav><a href="/docs">Documentation menu</a></nav>
          </header>
          <main>
            <article>
              <h1>Retry policy</h1>
              <p>Use <strong>three</strong> attempts.</p>
              <ul><li>Exponential backoff</li><li>Jitter</li></ul>
              <pre><code>retry(3)</code></pre>
            </article>
          </main>
          <div class="cookie-banner">Accept cookies</div>
          <aside>Sidebar navigation</aside>
          <footer>Footer links</footer>
        </body>
      </html>
    `);
    expect(result.title).toBe("Retry & Recovery");
    expect(result.markdown).toContain("# Retry & Recovery");
    expect(result.markdown).toContain("> How retries should be bounded.");
    expect(result.markdown).toContain("作者：Platform Team");
    expect(result.markdown).toContain("Retry policy");
    expect(result.markdown).toContain("Use **three** attempts.");
    expect(result.markdown).toMatch(/^-\s+Exponential backoff$/m);
    expect(result.markdown).toContain("```\nretry(3)\n```");
    expect(result.markdown).not.toContain("alert");
    expect(result.markdown).not.toContain("display: none");
    expect(result.markdown).not.toContain("Documentation menu");
    expect(result.markdown).not.toContain("Accept cookies");
    expect(result.markdown).not.toContain("Sidebar navigation");
    expect(result.markdown).not.toContain("Footer links");
  });

  test("rejects the SSRF forbidden address ranges", () => {
    const blocked = [
      "0.0.0.0",
      [10, 23, 0, 42].join("."),
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      [172, 20, 0, 42].join("."),
      [192, 168, 0, 42].join("."),
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ];
    for (const address of blocked) {
      expect(isPublicNetworkAddress(address), address).toBe(false);
    }
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isPublicNetworkAddress(address), address).toBe(true);
    }
  });

  test("rejects malformed and non-http URLs with E_URL_BLOCKED", async () => {
    for (const url of ["not a url", "file:///etc/passwd"]) {
      try {
        await inspectPublicUrl(url);
        throw new Error("expected inspectPublicUrl to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(HumanBoardError);
        expect((error as HumanBoardError).code).toBe("E_URL_BLOCKED");
      }
    }
  });

  test("fetches and extracts a page title after URL validation", async () => {
    const result = await inspectPublicUrl("https://example.com/article", {
      resolve: async () => ({ address: "93.184.216.34", family: 4 }),
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(
          "<html><head><title>Fetched title</title></head><body><main>Body</main></body></html>",
        ),
      }),
    });

    expect(result.title).toBe("Fetched title");
    expect(result.content_type).toBe("text/html");
    expect(result.markdown).toContain("# Fetched title");
    expect(result.untrusted).toBe(true);
  });

  test("revalidates every redirect before following it", async () => {
    try {
      await inspectPublicUrl("https://example.com/start", {
        resolve: async (url) =>
          url.hostname === "example.com"
            ? { address: "93.184.216.34", family: 4 }
            : { address: "127.0.0.1", family: 4 },
        request: async () => ({
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
          body: Buffer.alloc(0),
        }),
      });
      throw new Error("expected inspectPublicUrl to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HumanBoardError);
      expect((error as HumanBoardError).code).toBe("E_URL_BLOCKED");
      expect((error as HumanBoardError).details.reason).toBe("url_security");
    }
  });

  test("truncates oversized markdown by Unicode code point", () => {
    const result = truncateMarkdownContent("图".repeat(100), 40);
    expect(result.truncated).toBe(true);
    expect(Array.from(result.markdown).length).toBeLessThanOrEqual(40);
    expect(result.markdown.endsWith("[content truncated]")).toBe(true);
  });
});

test("Readability keeps nested article structure, resolves links, and does not execute embedded scripts", async () => {
  const page = await extractReadablePage(
    '<html><head><title>Article</title><meta name="description" content="A useful summary"></head><body><script>globalThis.__humanboard_untrusted_probe=1</script><main><article><h1>Article</h1><div><p>A <a href="../guide">guide</a> about retrying payments.</p><p>Details and evidence in a nested container.</p></div></article></main></body></html>',
    "https://example.test/docs/post",
  );
  expect(page.description).toBe("A useful summary");
  expect(page.markdown).toContain("[guide](https://example.test/guide)");
  expect(page.markdown).toContain("Details and evidence");
  expect(page.markdown).not.toContain("untrusted_probe");
  expect(
    (globalThis as unknown as Record<string, unknown>)
      .__humanboard_untrusted_probe,
  ).toBeUndefined();
});
