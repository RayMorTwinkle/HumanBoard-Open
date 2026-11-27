import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export function extractReadablePage(
  html: string,
  sourceUrl = "https://humanboard.invalid/",
): { title: string; markdown: string; description: string } {
  const dom = new JSDOM(html, { url: sourceUrl });
  try {
    const doc = dom.window.document;
    const meta = (...keys: string[]) =>
      keys
        .map((key) =>
          doc
            .querySelector(`meta[property="${key}"],meta[name="${key}"]`)
            ?.getAttribute("content")
            ?.trim(),
        )
        .find(Boolean) ?? "";
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const title = normalize(
      meta("og:title", "twitter:title") ||
        doc.title ||
        doc.querySelector("h1")?.textContent ||
        "",
    );
    const description = normalize(
      meta("og:description", "description", "twitter:description"),
    );
    const author = normalize(meta("author", "article:author")),
      published = normalize(
        meta("article:published_time", "date", "datepublished"),
      );
    doc
      .querySelectorAll(
        "script,style,noscript,template,svg,math,iframe,object,embed,canvas,nav,footer,aside,form,dialog,[hidden],[aria-hidden='true']",
      )
      .forEach((node) => node.remove());
    for (const node of doc.querySelectorAll<HTMLElement>(
      "[style],[class],[id]",
    )) {
      if (
        node.style.display === "none" ||
        node.style.visibility === "hidden" ||
        /(?:^|[-_\s])(cookie|consent|newsletter|advertisement|ads|sidebar|comments|subscribe)(?:$|[-_\s])/i.test(
          `${node.className} ${node.id}`,
        )
      )
        node.remove();
    }
    for (const a of doc.querySelectorAll("a[href]")) {
      try {
        const url = new URL(a.getAttribute("href")!, sourceUrl);
        if (["https:", "http:", "mailto:"].includes(url.protocol))
          a.setAttribute("href", url.href);
        else a.removeAttribute("href");
      } catch {
        a.removeAttribute("href");
      }
    }
    const article = new Readability(
      doc.cloneNode(true) as unknown as Document,
      { charThreshold: 0 },
    ).parse();
    const selected =
      article?.content ||
      doc.querySelector("main,article,[role='main']")?.innerHTML ||
      doc.body.innerHTML;
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    let body = turndown.turndown(selected).trim();
    const heading = /^#{1,6} +([^\n]+)\n*/.exec(body);
    if (heading && normalize(heading[1]!) === title)
      body = body.slice(heading[0].length);
    const summary =
      description ||
      normalize(
        article?.excerpt ?? article?.textContent ?? doc.body.textContent ?? "",
      );
    const pieces = [
      title ? `# ${title}` : "",
      description ? `> ${description}` : "",
      author ? `作者：${author}` : "",
      published ? `发布时间：${published}` : "",
      body,
    ].filter(Boolean);
    return {
      title,
      markdown: pieces.join("\n\n"),
      description: Array.from(summary).slice(0, 240).join(""),
    };
  } finally {
    dom.window.close();
  }
}
