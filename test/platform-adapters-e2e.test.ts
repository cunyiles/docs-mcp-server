/**
 * Platform adapters turn what a documentation generator publishes (search
 * indexes, navigator indexes, page sources) into witnesses and clean pages.
 * Every fake site here hides some pages from links, so only the generator's
 * own index can find them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, fakeSite, type Grounded, html, removeStore, startGrounded } from "./harness";

const page = (title: string, text: string, head = "", links: string[] = []): FakePage => ({
  body: `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${text}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</main></body></html>`,
});
type FakePage = { body: string; type?: string };

describe("Platform adapters", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const collect = async (url: string) => {
    grounded = await startGrounded();
    await grounded.scrape({ url, library: "plat" });
    return grounded;
  };
  const status = async () =>
    ((await grounded?.call("list_libraries")) ?? "").split("\n").find((l) => l.startsWith("- plat")) ?? "";
  const top = async (query: string) =>
    ((await grounded?.call("search_docs", { library: "plat", query })) ?? "").match(
      /Result 1: (\S+)/,
    )?.[1];

  it("collects a MkDocs site and counts its search index as a witness", async () => {
    const origin = "https://mkdocs-site.test";
    const generator = '<meta name="generator" content="mkdocs-1.6.0, mkdocs-material-9.5">';
    fakeSite(origin, {
      "/": page("Home", "Welcome to the project.", generator),
      "/hidden/": page("Hidden", "Narwhal configuration explained.", generator),
      "/search/search_index.json": {
        body: JSON.stringify({
          config: { lang: ["en"] },
          docs: [
            { location: "", title: "Home", text: "Welcome" },
            { location: "hidden/", title: "Hidden", text: "Narwhal" },
            { location: "hidden/#options", title: "Options", text: "Narwhal options" },
          ],
        }),
        type: "application/json",
      },
    });
    await collect(`${origin}/`);
    expect(await top("narwhal")).toBe(`${origin}/hidden`);
    expect(await status()).toMatch(/mkdocs index 2/);
  });

  it("collects a Sphinx site's Markdown pages from their _sources text", async () => {
    const origin = "https://sphinx-site.test";
    const head =
      '<meta name="generator" content="Sphinx 7.2.6"><script src="_static/documentation_options.js?v=1"></script>';
    const routes: Record<string, FakeRoute> = {
      "/en/latest/index.html": page("Index", "Project index.", head),
      "/en/latest/guide.html": page("Guide", "Rendered html of the guide.", head),
      "/en/latest/api.html": page("API", "Axolotl reference rendered from rst.", head),
      "/en/latest/_static/documentation_options.js": {
        body: "const DOCUMENTATION_OPTIONS = { VERSION: '1.0', BUILDER: 'html', FILE_SUFFIX: '.html', SOURCELINK_SUFFIX: '.txt' };",
        type: "application/javascript",
      },
      "/en/latest/searchindex.js": {
        body: `Search.setIndex(${JSON.stringify({
          docnames: ["api", "guide", "index"],
          filenames: ["api.rst", "guide.md", "index.rst"],
          titles: ["API", "Guide", "Index"],
        })})`,
        type: "application/javascript",
      },
      "/en/latest/_sources/guide.md.txt": {
        body: "# Guide\n\nCapybara setup written in Markdown source.\n",
        type: "text/plain",
      },
    };
    const site = fakeSite(origin, routes);
    await collect(`${origin}/en/latest/index.html`);
    expect(await top("capybara")).toBe(`${origin}/en/latest/guide.html`);
    expect(await top("axolotl")).toBe(`${origin}/en/latest/api.html`);
    // The Markdown page came from its source, not from its rendered HTML.
    expect(site.hits("/en/latest/_sources/guide.md.txt")).toBe(1);
    expect(await grounded?.call("search_docs", { library: "plat", query: "rendered html guide" })).not.toContain(
      "Rendered html of the guide",
    );
    expect(await status()).toMatch(/sphinx index 3/);
  });

  it("collects a DocC framework from its navigator index", async () => {
    const origin = "https://docc-site.test";
    const shell = (path: string) => ({
      body: `<!doctype html><html><head><script defer src="/docs/js/chunk-vendors.123.js"></script><script defer src="/docs/js/index.456.js"></script></head><body><noscript><p>A Markdown version is available: <a href="${origin}${path}.md">View Markdown</a></p></noscript><div id="app"></div></body></html>`,
    });
    const md = (text: string) => ({ body: text, type: "text/markdown" });
    fakeSite(origin, {
      "/documentation/gizmokit": shell("/documentation/gizmokit"),
      "/documentation/gizmokit.md": md("# GizmoKit\n\nThe framework.\n"),
      "/documentation/gizmokit/sprocket": shell("/documentation/gizmokit/sprocket"),
      "/documentation/gizmokit/sprocket.md": md("# Sprocket\n\nA wombat-safe sprocket.\n"),
      "/documentation/gizmokit/cog": shell("/documentation/gizmokit/cog"),
      "/documentation/gizmokit/cog.md": md("# Cog\n\nCogs turn quietly.\n"),
      "/docs/data/index/gizmokit": {
        body: JSON.stringify({
          interfaceLanguages: {
            swift: [
              {
                path: "/documentation/gizmokit",
                children: [
                  { path: "/documentation/gizmokit/sprocket", type: "class" },
                  { path: "/documentation/gizmokit/cog", type: "struct" },
                  { path: "/documentation/otherkit/thing", type: "class" },
                ],
              },
            ],
          },
        }),
        type: "application/json",
      },
    });
    await collect(`${origin}/documentation/gizmokit`);
    expect(await top("wombat")).toBe(`${origin}/documentation/gizmokit/sprocket`);
    const line = await status();
    expect(line).toContain("3 pages collected");
    // The entry page itself is collected as the root; the index adds the rest.
    expect(line).toMatch(/docc index 2/);
    // The shells were read through their Markdown versions, not in a browser.
    expect(line).not.toContain("rendered in a browser");
  });

  it("collects every Dokka symbol page from its pages list", async () => {
    const origin = "https://dokka-site.test";
    const head = '<script>var pathToRoot = "../";</script><link href="../styles/style.css" rel="Stylesheet"><script src="../scripts/platform-content-handler.js"></script><!-- dokka -->';
    fakeSite(origin, {
      "/api/lib/index.html": page("lib", "Package overview.", head),
      "/api/lib/-gadget/index.html": page("Gadget", "Gadget emits llama events.", head),
      "/api/lib/-widget/index.html": page("Widget", "Widget holds alpaca state.", head),
      "/api/scripts/pages.json": {
        body: JSON.stringify([
          { name: "lib", location: "lib/index.html" },
          { name: "Gadget", location: "lib/-gadget/index.html" },
          { name: "Widget", location: "lib/-widget/index.html#123" },
        ]),
        type: "application/json",
      },
    });
    await collect(`${origin}/api/lib/index.html`);
    expect(await top("llama")).toBe(`${origin}/api/lib/-gadget`);
    expect(await top("alpaca")).toBe(`${origin}/api/lib/-widget`);
    expect(await status()).toMatch(/dokka index 3/);
  });

  it("collects every javadoc class from its type search index", async () => {
    const origin = "https://javadoc-site.test";
    const head = '<meta name="generator" content="javadoc/ClassWriter"><script>var pathtoroot = "./";</script>';
    fakeSite(origin, {
      "/javadoc/index.html": page("Overview", "All packages.", head),
      "/javadoc/com/example/Spanner.html": page("Spanner", "Spanner tightens yak bolts.", head),
      "/javadoc/com/example/Map.Entry.html": page("Map.Entry", "An entry holding a gnu.", head),
      "/javadoc/type-search-index.js": {
        body: `typeSearchIndex = ${JSON.stringify([
          { l: "All Classes and Interfaces", u: "allclasses-index.html" },
          { p: "com.example", l: "Spanner" },
          { p: "com.example", l: "Map.Entry" },
        ])};updateSearchResults();`,
        type: "application/javascript",
      },
    });
    await collect(`${origin}/javadoc/index.html`);
    expect(await top("yak")).toBe(`${origin}/javadoc/com/example/Spanner.html`);
    expect(await top("gnu")).toBe(`${origin}/javadoc/com/example/Map.Entry.html`);
    expect(await status()).toMatch(/javadoc index 2/);
  });

  it("collects a site no adapter recognises exactly as before", async () => {
    const origin = "https://plain-site.test";
    const site = fakeSite(origin, {
      "/docs/": html("Docs", "Plain docs.", ["/docs/a"]),
      "/docs/a": html("A", "Plain page."),
    });
    await collect(`${origin}/docs/`);
    expect(await status()).toContain("2 pages collected");
    expect(await status()).not.toMatch(/index \d/);
    expect(site.log.map((entry) => entry.path).filter((p) => /index\.js|pages\.json|search_index/.test(p))).toEqual([]);
  });
});
