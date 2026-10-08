import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseSitemap, sitemapsFromRobots } from "./sitemap";

describe("sitemap", () => {
  it("reads page URLs, entities and CDATA from a urlset", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://a.test/x?y=1&amp;z=2</loc></url>
      <url><loc><![CDATA[https://a.test/b]]></loc><lastmod>2025-01-01</lastmod></url>
    </urlset>`;
    expect(parseSitemap(xml)).toEqual({
      sitemaps: [],
      urls: ["https://a.test/x?y=1&z=2", "https://a.test/b"],
    });
  });

  it("reads child sitemaps from a gzipped index", () => {
    const xml =
      "<sitemapindex><sitemap><loc>https://a.test/s1.xml.gz</loc></sitemap></sitemapindex>";
    expect(parseSitemap(gzipSync(xml))).toEqual({
      sitemaps: ["https://a.test/s1.xml.gz"],
      urls: [],
    });
  });

  it("ignores bodies that are not sitemaps", () => {
    expect(parseSitemap("<html><loc>x</loc></html>")).toEqual({ sitemaps: [], urls: [] });
  });

  it("finds sitemaps declared in robots.txt", () => {
    expect(
      sitemapsFromRobots("User-agent: *\nDisallow:\nSitemap: https://a.test/s.xml\n"),
    ).toEqual(["https://a.test/s.xml"]);
  });
});
