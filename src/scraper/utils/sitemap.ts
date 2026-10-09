import { gunzipSync } from "node:zlib";

/** What one sitemap file lists: child sitemaps (an index) or page URLs. */
export interface ParsedSitemap {
  sitemaps: string[];
  urls: string[];
}

const LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Reads a sitemap or sitemap index, gzipped or not.
 *
 * Sitemaps are machine-written and regular, so the `<loc>` elements are read
 * directly instead of through an XML parser.
 *
 * @param body The response body as fetched.
 * @returns The listed child sitemaps and page URLs; empty when the body is not a sitemap.
 */
export function parseSitemap(body: Buffer | string): ParsedSitemap {
  let text: string;
  if (Buffer.isBuffer(body) && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      text = gunzipSync(body).toString("utf8");
    } catch {
      return { sitemaps: [], urls: [] };
    }
  } else {
    text = body.toString();
  }
  if (!/<(urlset|sitemapindex)\b/i.test(text)) return { sitemaps: [], urls: [] };
  if (/<sitemapindex\b/i.test(text)) {
    return { sitemaps: [...text.matchAll(LOC)].map((m) => decodeXml(m[1])), urls: [] };
  }
  // A page published in several languages is listed once per language, each
  // entry naming the others as `hreflang` alternates. Only the entry that is
  // its own default (`x-default`) is the page; the rest are translations.
  const urls: string[] = [];
  for (const block of text.split(/<\/url>/i)) {
    LOC.lastIndex = 0;
    const loc = LOC.exec(block);
    if (!loc) continue;
    const url = decodeXml(loc[1]);
    const fallback =
      /hreflang=["']x-default["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*hreflang=["']x-default["']/i.exec(
        block,
      );
    const defaultUrl = fallback ? decodeXml(fallback[1] ?? fallback[2]) : undefined;
    if (defaultUrl === undefined || defaultUrl === url) urls.push(url);
  }
  return { sitemaps: [], urls };
}

/** Sitemap URLs a robots.txt declares. */
export function sitemapsFromRobots(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]);
}
