/**
 * A collection interrupted by a restart or deploy continues where it stopped:
 * pages collected before the restart are not fetched again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventually,
  type FakeRoute,
  fakeSite,
  type Grounded,
  html,
  removeStore,
  startGrounded,
} from "./harness";

const ORIGIN = "https://resume-docs.test";
const PAGES = 9;

describe("Collection resume", () => {
  let grounded: Grounded | undefined;
  let release: (() => void) | undefined;

  afterEach(async () => {
    release?.();
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  it("finishes after a restart without refetching collected pages", async () => {
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstRequest = true;
    const routes: Record<string, FakeRoute> = {
      "/docs/": html(
        "Docs",
        "Index.",
        Array.from({ length: PAGES }, (_, i) => `/docs/p${i}`),
      ),
    };
    for (let i = 0; i < PAGES; i++) {
      routes[`/docs/p${i}`] = html(`Page ${i}`, `Subject ${i} in depth.`);
    }
    routes["/sitemap.xml"] = {
      body: `<urlset>${Array.from({ length: PAGES }, (_, i) => `<url><loc>${ORIGIN}/docs/p${i}</loc></url>`).join("")}</urlset>`,
      type: "application/xml",
    };
    // The entry page names its generator, whose index the first run read.
    const root = routes["/docs/"] as { body: string };
    routes["/docs/"] = {
      body: root.body.replace(
        "<head>",
        '<head><meta name="generator" content="mkdocs-1.6.0">',
      ),
    };
    routes["/docs/search/search_index.json"] = {
      body: JSON.stringify({
        docs: Array.from({ length: PAGES }, (_, i) => ({ location: `p${i}` })),
      }),
      type: "application/json",
    };
    // The server "dies" while this page is in flight.
    routes["/docs/p5"] = async () => {
      if (firstRequest) {
        firstRequest = false;
        await hung;
      }
      return html("Page 5", "Subject 5 in depth.");
    };
    const site = fakeSite(ORIGIN, routes);

    grounded = await startGrounded((config) => {
      config.scraper.maxConcurrency = 2;
    });
    await grounded.call("scrape_docs", { url: `${ORIGIN}/docs/`, library: "resume-lib" });
    await eventually(async () => site.hits("/docs/p5") === 1 && site.hits("/docs/p4") === 1);
    // Let the sibling of the hung page finish and be stored.
    await new Promise((resolve) => setTimeout(resolve, 300));

    grounded = await grounded.restart();
    await grounded.waitForJobs();

    const status = await grounded.call("list_libraries");
    expect(status).toContain(`- resume-lib: ${PAGES + 1} pages collected`);
    expect(status).toMatch(/last collection \S+ completed/);
    // A resumed run reports coverage like an uninterrupted one.
    expect(status).toMatch(/witnesses links \d+, sitemap \d+/);
    expect(status).toMatch(/mkdocs index \d+/);
    for (const path of ["/docs/", ...Array.from({ length: 5 }, (_, i) => `/docs/p${i}`)]) {
      expect(site.hits(path), path).toBe(1);
    }
    expect(site.hits("/docs/p5")).toBe(2);
    for (let i = 6; i < PAGES; i++) expect(site.hits(`/docs/p${i}`)).toBe(1);

    const search = await grounded.call("search_docs", {
      library: "resume-lib",
      query: "Subject 8",
    });
    expect(search).toContain(`${ORIGIN}/docs/p8`);
  });

  it("continues an unfinished collection when it is requested again", async () => {
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstRequest = true;
    const routes: Record<string, FakeRoute> = {
      "/docs/": html(
        "Docs",
        "Index.",
        Array.from({ length: 6 }, (_, i) => `/docs/p${i}`),
      ),
    };
    for (let i = 0; i < 6; i++) routes[`/docs/p${i}`] = html(`Page ${i}`, `Topic ${i}.`);
    routes["/docs/p3"] = async () => {
      if (firstRequest) {
        firstRequest = false;
        await hung;
      }
      return html("Page 3", "Topic 3.");
    };
    const site = fakeSite(ORIGIN, routes);
    grounded = await startGrounded((config) => {
      config.scraper.maxConcurrency = 1;
    });
    await grounded.call("scrape_docs", { url: `${ORIGIN}/docs/`, library: "resume-lib" });
    await eventually(async () => site.hits("/docs/p3") === 1);

    // A server started without job recovery marks the run failed.
    grounded = await grounded.restart(undefined, false);
    expect(await grounded.call("list_libraries")).toMatch(/failed/);

    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "resume-lib" });
    const status = await grounded.call("list_libraries");
    expect(status).toContain("- resume-lib: 7 pages collected");
    expect(status).toMatch(/last collection \S+ completed/);
    for (const path of ["/docs/", "/docs/p0", "/docs/p1", "/docs/p2", "/docs/p4"]) {
      expect(site.hits(path), path).toBe(1);
    }
  });

  it("starts over when the same library is collected again after it finished", async () => {
    const site = fakeSite(ORIGIN, {
      "/docs/": html("Docs", "Index.", ["/docs/a"]),
      "/docs/a": html("A", "Alpha."),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "resume-lib" });
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "resume-lib" });
    expect(site.hits("/docs/a")).toBe(2);
    grounded = await grounded.restart();
    await grounded.waitForJobs();
    expect(site.hits("/docs/a")).toBe(2);
  });
});
