import * as cheerio from "cheerio";

/** Shared by the CLI crawler and the weekly cron, so both fetch identically. */
export const CRAWL_PATHS = [
  "/", "/about", "/programs", "/grant-funding", "/roundtables",
  "/results", "/the-book", "/insights", "/training-videos",
] as const;

const UA = "Mozilla/5.0 (compatible; Skayle360Bot/1.0; +https://skayle360.com)";

export interface CrawledPage {
  url: string;
  path: string;
  title: string;
  text: string;
  fetchedAt: string;
}

function pageText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, svg, iframe, nav, header, footer, [role=navigation], [aria-hidden=true]").remove();

  // HTML has no whitespace between elements, so cheerio's .text() concatenates
  // them: a heading followed by a paragraph became "call.Ask a question". That
  // reads as a typo in the source quotes shown under an answer, and it also
  // welds two real words into one token that the search index can never match.
  // Appending a newline to every block-level element restores the boundary.
  $("p, div, li, h1, h2, h3, h4, h5, h6, br, tr, td, th, section, article, blockquote")
    .each((_, el) => { $(el).after("\n"); });

  const raw = $("main").length ? $("main").text() : $("body").text();
  return raw
    .replace(/ /g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Webflow repeats the same CTA blocks and menu labels on every page. Lines that
 * appear on a majority of pages are chrome, not content, and indexing them
 * makes every page look identical to a retriever.
 */
function stripSharedBoilerplate(pages: CrawledPage[]): CrawledPage[] {
  const counts = new Map<string, number>();
  for (const p of pages) for (const line of new Set(p.text.split("\n"))) counts.set(line, (counts.get(line) ?? 0) + 1);
  const threshold = Math.max(2, Math.ceil(pages.length * 0.6));
  const chrome = new Set([...counts].filter(([line, n]) => n >= threshold && line.length < 120).map(([l]) => l));
  return pages.map((p) => ({ ...p, text: p.text.split("\n").filter((l) => !chrome.has(l)).join("\n") }));
}

export async function crawlSite(
  site = process.env.SITE_URL ?? "https://skayle360.com",
  onPage?: (msg: string) => void,
): Promise<{ pages: CrawledPage[]; missing: string[] }> {
  const results: CrawledPage[] = [];
  for (const path of CRAWL_PATHS) {
    const url = `${site}${path}`;
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
      if (!res.ok) {
        onPage?.(`  ${path} -> HTTP ${res.status}`);
        continue;
      }
      const $ = cheerio.load(await res.text());
      const text = pageText($);
      const title = ($("title").first().text() || path).replace(/\s*[|\-–]\s*Skayle 360.*$/i, "").trim();
      onPage?.(`  ${path} -> ${text.length} chars  "${title}"`);
      results.push({ url, path, title: title || path, text, fetchedAt: new Date().toISOString() });
    } catch (err) {
      onPage?.(`  ${path} -> ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // be polite behind Cloudflare
  }
  const pages = results.length ? stripSharedBoilerplate(results) : [];
  const missing = CRAWL_PATHS.filter((p) => !pages.some((c) => c.path === p));
  return { pages, missing };
}
