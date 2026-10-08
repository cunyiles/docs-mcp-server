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
  const locs = [...text.matchAll(LOC)].map((match) => decodeXml(match[1]));
  return /<sitemapindex\b/i.test(text)
    ? { sitemaps: locs, urls: [] }
    : { sitemaps: [], urls: locs };
}

/** Sitemap URLs a robots.txt declares. */
export function sitemapsFromRobots(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]);
}
