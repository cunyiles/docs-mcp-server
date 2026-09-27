/**
 * Each page is indexed once under its canonical URL, whatever representations
 * a site publishes: Markdown twins (`.md.txt`, a declared Markdown alternate)
 * and query-string variants that serve the same content.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type FakePage,
  fakeSite,
  type Grounded,
  html,
  removeStore,
  startGrounded,
} from "./harness";

const ORIGIN = "https://identity-pages.test";
const FILLER = "Additional explanation keeps the page comfortably long. ".repeat(4);

const text = (body: string): FakePage => ({ body, type: "text/plain; charset=utf-8" });

describe("One page per page", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
  });

  const statusLine = async () => {
    const lines = ((await grounded?.call("list_libraries")) ?? "").split("\n");
    return lines.find((line) => line.startsWith("- pages-lib")) ?? "";
  };

  const resultUrls = (search: string) =>
    [...search.matchAll(/^Result \d+: (\S+)$/gm)].map((match) => match[1]);

  it("indexes a page once when it also exists as <page>.md.txt", async () => {
    const withTwin = (title: string, slug: string, links: string[] = []) =>
      html(title, `${title} rendered as HTML. ${FILLER}`, [...links, `/docs/${slug}.md.txt`]);
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", `Start here. ${FILLER}`, ["/docs/alpha", "/docs/beta"]),
      "/docs/alpha": withTwin("Alpha", "alpha"),
      "/docs/beta": withTwin("Beta", "beta"),
      "/docs/alpha.md.txt": text(`# Alpha\n\nAlpha twinmarker from the published Markdown.\n\n${FILLER}`),
      "/docs/beta.md.txt": text(`# Beta\n\nBeta twinmarker from the published Markdown.\n\n${FILLER}`),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "pages-lib" });

    expect(await statusLine()).toContain("3 pages collected");
    const search = await grounded.call("search_docs", {
      library: "pages-lib",
      query: "twinmarker",
      limit: 5,
    });
    const urls = resultUrls(search);
    expect(urls.sort()).toEqual([`${ORIGIN}/docs/alpha`, `${ORIGIN}/docs/beta`]);
    expect(search).toContain("from the published Markdown");
  });

  it("records a declared Markdown alternate under the page's own URL", async () => {
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", `Start here. ${FILLER}`, ["/docs/guide"]),
      "/docs/guide": {
        body: `<!doctype html><html><head><title>Guide</title><link rel="alternate" type="text/markdown" href="/exports/guide.md"></head><body><main><h1>Guide</h1><p>HTML rendering of the guide. ${FILLER}</p></main></body></html>`,
      },
      "/exports/guide.md": {
        body: `# Guide\n\nAlternatemarker text written by the site authors.\n\n${FILLER}`,
        type: "text/markdown",
      },
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "pages-lib" });

    const search = await grounded.call("search_docs", {
      library: "pages-lib",
      query: "alternatemarker",
    });
    expect(resultUrls(search)).toEqual([`${ORIGIN}/docs/guide`]);
    expect(search).toContain("written by the site authors");
    expect(await statusLine()).toContain("2 pages collected");
  });

  it("collapses query variants with identical content and keeps different ones", async () => {
    const same = html("Setup", `Setup samemarker instructions. ${FILLER}`);
    fakeSite(ORIGIN, {
      "/docs/": html("Docs", `Start here. ${FILLER}`, [
        "/docs/setup",
        "/docs/setup?rec=A",
        "/docs/setup?rec=B",
        "/docs/lang?tab=kotlin",
      ]),
      "/docs/setup": same,
      "/docs/setup?rec=A": same,
      "/docs/setup?rec=B": same,
      "/docs/lang": html("Languages", `Java variant of the langmarker page. ${FILLER}`),
      "/docs/lang?tab=kotlin": html(
        "Languages",
        `Kotlin variant of the langmarker page, other text entirely. ${FILLER}`,
      ),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "pages-lib" });

    const setup = await grounded.call("search_docs", {
      library: "pages-lib",
      query: "samemarker",
      limit: 5,
    });
    expect(resultUrls(setup)).toEqual([`${ORIGIN}/docs/setup`]);

    const lang = await grounded.call("search_docs", {
      library: "pages-lib",
      query: "langmarker",
      limit: 5,
    });
    expect(resultUrls(lang).sort()).toEqual([
      `${ORIGIN}/docs/lang`,
      `${ORIGIN}/docs/lang?tab=kotlin`,
    ]);
    // root, setup, lang, lang?tab=kotlin
    expect(await statusLine()).toContain("4 pages collected");
  });
});
