/**
 * Website crawl -> data/website.json, consumed by `npm run ingest`.
 * Not optional: the CEO Roundtable and the cohort dates exist only on the site.
 *
 *   npm run ingest:crawl && npm run ingest
 *
 * In production the same crawl runs weekly through /api/cron/crawl, which
 * writes straight to Postgres instead of to disk.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { crawlSite, CRAWL_PATHS } from "@ingest/lib/crawl-core";

const OUT_DIR = process.env.OUT_DIR ?? new URL("../data", import.meta.url).pathname;

const site = process.env.SITE_URL ?? "https://skayle360.com";
console.log(`Crawling ${site}`);
const { pages, missing } = await crawlSite(site, (m) => console.log(m));
if (!pages.length) {
  console.error("crawl returned no pages - refusing to overwrite the cache");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "website.json"), JSON.stringify(pages, null, 2));
console.log(`\n${pages.length}/${CRAWL_PATHS.length} pages -> data/website.json`);
if (missing.length) console.warn(`WARNING: no content for ${missing.join(", ")}`);
