/**
 * Each page comes from the cheapest representation that works, and what works
 * is learned per host: later pages skip the rungs that did not pay off.
 *
 * Empty JavaScript shells going to Chromium while server-rendered framework
 * pages do not is covered by crawler-identity-e2e.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, fakeSite, type Grounded, removeStore, startGrounded } from "./harness";

const ORIGIN = "https://ladder-docs.test";
const PAGES = 8;

const wantsMarkdown = (request: Request) =>
  (request.headers.get("accept") ?? "").startsWith("text/markdown");

const nav = (prefix = "") =>
  Array.from({ length: PAGES }, (_, i) => `<a href="/docs/p${i}${prefix}">P${i}</a>`).join("");

describe("Fetch ladder", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const search = (query: string) =>
    grounded?.call("search_docs", { library: "ladder", query }) ?? Promise.resolve("");

  it("collects a negotiating site from Markdown and stops reading its HTML navigation", async () => {
    let htmlResponses = 0;
    const routes: Record<string, FakeRoute> = {};
    for (const path of ["/docs/", ...Array.from({ length: PAGES }, (_, i) => `/docs/p${i}`)]) {
      const name = path === "/docs/" ? "Index" : path.slice(6);
      routes[path] = (request) => {
        if (wantsMarkdown(request)) {
          const links = Array.from({ length: PAGES }, (_, i) => `- [P${i}](/docs/p${i})`);
          return {
            body: `# ${name}\n\nMarkdownonly text for ${name}.\n\n${links.join("\n")}\n`,
            type: "text/markdown",
          };
        }
        htmlResponses++;
        return {
          body: `<html><body><nav>${nav()}</nav><main><h1>${name}</h1><p>Htmlonly text.</p></main></body></html>`,
        };
      };
    }
    fakeSite(ORIGIN, routes);
    grounded = await startGrounded((config) => {
      config.scraper.maxConcurrency = 1;
    });
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "ladder" });

    expect(await grounded.call("list_libraries")).toContain(`${PAGES + 1} pages collected`);
    expect(await search("markdownonly")).toContain(`Result 1: ${ORIGIN}/docs`);
    expect(await search("htmlonly")).toContain("No results");
    // Navigation is read beside the first pages only, then never again.
    expect(htmlResponses).toBe(2);
  });

  it("goes straight to a host's Markdown twins once it has declared one", async () => {
    const routes: Record<string, FakeRoute> = {};
    for (let i = 0; i < PAGES; i++) {
      routes[`/docs/p${i}`] = {
        body: `<html><head><link rel="alternate" type="text/markdown" href="/docs/p${i}.md"></head><body><main><h1>P${i}</h1><p>Html words.</p>${nav()}</main></body></html>`,
      };
      routes[`/docs/p${i}.md`] = {
        body: `# P${i}\n\nTwin text number ${i}.\n`,
        type: "text/markdown",
      };
    }
    routes["/docs/"] = { body: `<html><body><main><h1>Docs</h1>${nav()}</main></body></html>` };
    const site = fakeSite(ORIGIN, routes);
    grounded = await startGrounded((config) => {
      config.scraper.maxConcurrency = 1;
    });
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "ladder" });

    expect(await search("twin text number 6")).toContain(`Result 1: ${ORIGIN}/docs/p6`);
    // Pages after the first are not asked for their HTML content any more.
    const htmlContentRequests = site.log.filter(
      (entry) =>
        /^\/docs\/p\d$/.test(entry.path) && entry.headers.get("accept") !== "text/html",
    );
    expect(htmlContentRequests.length).toBeLessThanOrEqual(1);
    for (let i = 0; i < PAGES; i++) expect(site.hits(`/docs/p${i}.md`)).toBe(1);
  });

  it("asks a host without twins for its pages directly", async () => {
    const routes: Record<string, FakeRoute> = {
      "/docs/": { body: `<html><body><main><h1>Docs</h1>${nav()}</main></body></html>` },
    };
    for (let i = 0; i < PAGES; i++) {
      routes[`/docs/p${i}`] = {
        body: `<html><body><main><h1>P${i}</h1><p>Plain html page ${i}.</p></main></body></html>`,
      };
    }
    const site = fakeSite(ORIGIN, routes);
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "ladder" });
    expect(await grounded.call("list_libraries")).toContain(`${PAGES + 1} pages collected`);
    expect(site.log.filter((entry) => entry.path.endsWith(".md"))).toHaveLength(0);
    for (let i = 0; i < PAGES; i++) expect(site.hits(`/docs/p${i}`)).toBe(1);
  });
});
