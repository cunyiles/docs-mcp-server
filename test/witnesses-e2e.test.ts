/**
 * Several witnesses list a library's pages; their union is collected, their
 * counts show as coverage, and gaps close on the next run.
 */

import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, fakeSite, type Grounded, html, removeStore, startGrounded } from "./harness";

const ORIGIN = "https://witness-docs.test";

const urlset = (paths: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
    .join("")}</urlset>`;

describe("Witnesses", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const statusLine = async () =>
    ((await grounded?.call("list_libraries")) ?? "")
      .split("\n")
      .find((line) => line.startsWith("- wit")) ?? "";

  const found = async (query: string, path: string) =>
    (await grounded?.call("search_docs", { library: "wit", query }))?.includes(
      `Result 1: ${ORIGIN}${path}`,
    );

  it("collects a page only a sitemap lists, through an index whose child needs gzip", async () => {
    const routes: Record<string, FakeRoute> = {
      "/docs/": html("Docs", "Home of the docs.", ["/docs/linked"]),
      "/docs/linked": html("Linked", "Reachable by a link."),
      "/docs/orphan": html("Orphan", "Zeppelin pages nobody links to."),
      "/elsewhere/page": html("Elsewhere", "Outside the entry point."),
      "/robots.txt": { body: `Sitemap: ${ORIGIN}/sitemap-index.xml\n`, type: "text/plain" },
      "/sitemap-index.xml": {
        body: `<sitemapindex><sitemap><loc>${ORIGIN}/child.xml.gz</loc></sitemap></sitemapindex>`,
        type: "application/xml",
      },
      // Answers only clients that accept gzip, like some large sites do.
      "/child.xml.gz": (request) =>
        (request.headers.get("accept-encoding") ?? "").includes("gzip")
          ? {
              body: gzipSync(
                urlset(["/docs/", "/docs/linked", "/docs/orphan", "/elsewhere/page"]),
              ) as unknown as string,
              type: "application/gzip",
            }
          : { body: "error", status: 500, type: "text/plain" },
    };
    const site = fakeSite(ORIGIN, routes);
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "wit" });

    expect(await found("zeppelin", "/docs/orphan")).toBe(true);
    // Sitemap entries outside the entry point are ignored.
    expect(site.hits("/elsewhere/page")).toBe(0);
    const line = await statusLine();
    expect(line).toContain("3 pages collected, 3 of 3 listed");
    expect(line).toMatch(/witnesses links \d+, sitemap 3/);
    expect(line).toContain("no llms.txt");
  });

  it("collects a page only llms.txt lists", async () => {
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", "Home of the docs."),
      "/docs/llms.txt": {
        body: `# Docs\n\n- [Hidden](${ORIGIN}/docs/hidden): a page\n`,
        type: "text/plain",
      },
      "/docs/hidden": html("Hidden", "Quokka facts only llms.txt mentions."),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "wit" });
    expect(await found("quokka", "/docs/hidden")).toBe(true);
    const line = await statusLine();
    expect(line).toMatch(/llms\.txt 1/);
    expect(line).toContain("no sitemap");
  });

  it("collects by links alone and says which witnesses were absent", async () => {
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", "Home.", ["/docs/a"]),
      "/docs/a": html("A", "Page a."),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "wit" });
    const line = await statusLine();
    expect(line).toContain("2 pages collected");
    expect(line).toContain("witnesses links 1");
    expect(line).toContain("no sitemap, llms.txt");
  });

  it("closes a gap on refresh when a listed page failed before", async () => {
    let up = false;
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", "Home."),
      "/sitemap.xml": { body: urlset(["/docs/", "/docs/flaky"]), type: "application/xml" },
      "/docs/flaky": () =>
        up ? html("Flaky", "Wombat content.") : { body: "down", status: 500, type: "text/plain" },
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "wit" });
    expect(await statusLine()).toContain("1 of 2 listed");

    up = true;
    await grounded.refresh({ library: "wit" });
    expect(await statusLine()).toContain("2 of 2 listed");
    expect(await found("wombat", "/docs/flaky")).toBe(true);
  });
});
