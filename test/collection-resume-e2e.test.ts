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
