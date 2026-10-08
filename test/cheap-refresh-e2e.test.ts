/**
 * Refresh asks each page whether it changed, downloads only what did, and
 * sends only changed chunks back to the embedding provider.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventually,
  type FakePage,
  type FakeProvider,
  fakeProvider,
  fakeSite,
  type Grounded,
  html,
  removeStore,
  startGrounded,
} from "./harness";

const ORIGIN = "https://refresh-docs.test";

/** Long enough that each section of a page becomes a chunk of its own. */
const section = (heading: string, words: string) =>
  `<h2>${heading}</h2><p>${`${words} `.repeat(120)}</p>`;

function page(title: string, sections: string[], links: string[] = []): FakePage {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  return {
    body: `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${sections.join("")}${anchors}</main></body></html>`,
  };
}

/**
 * Serves a page with an ETag and answers a matching If-None-Match with 304.
 * `served` counts responses that carried a body.
 */
function conditional(get: () => FakePage, served: Map<string, number>, key: string) {
  return (request: Request): FakePage => {
    const current = get();
    const etag = `"${createHash("sha1").update(current.body).digest("hex").slice(0, 12)}-df"`;
    const plain = etag.replace(/-df"$/, '"');
    // Like a server that compresses on the fly: it hands out the suffixed
    // ETag but compares the condition against the plain one.
    if ((request.headers.get("if-none-match") ?? "").includes(plain)) {
      return { body: "", status: 304, headers: { etag } };
    }
    served.set(key, (served.get(key) ?? 0) + 1);
    return { ...current, headers: { etag } };
  };
}

describe("Cheap refresh", () => {
  let grounded: Grounded | undefined;
  let provider: FakeProvider;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const withEmbeddings = (config: Grounded["config"]) => {
    config.app.embeddingModel = "openai:text-embedding-3-small";
  };

  async function collect() {
    provider = fakeProvider("ok");
    const served = new Map<string, number>();
    const pages: Record<string, FakePage> = {
      "/docs/": page("Docs", [section("Start", "welcome")], ["/docs/a", "/docs/b", "/docs/c"]),
      "/docs/a": page("Alpha", [section("Setup", "install alpha"), section("Usage", "call alpha")]),
      "/docs/b": page("Beta", [section("Setup", "install beta")]),
      "/docs/c": page("Gamma", [section("Setup", "install gamma")]),
    };
    const routes = Object.fromEntries(
      Object.keys(pages).map((path) => [path, conditional(() => pages[path], served, path)]),
    );
    const site = fakeSite(ORIGIN, routes);
    grounded = await startGrounded(withEmbeddings);
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "fresh-lib" });
    const g = grounded;
    await eventually(async () =>
      (await g.call("list_libraries")).includes("4 of 4 embedded"),
    );
    served.clear();
    return { site, pages, served, g };
  }

  it("transfers no page body and embeds nothing when nothing changed", async () => {
    const { served, g } = await collect();
    const inputsBefore = provider.inputs;
    await g.refresh({ library: "fresh-lib" });
    expect([...served.values()].reduce((a, b) => a + b, 0)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.inputs).toBe(inputsBefore);
    expect(await g.call("list_libraries")).toContain("4 pages collected, 4 of 4 embedded");
  });

  it("re-embeds only the chunk whose text changed", async () => {
    const { pages, served, g } = await collect();
    const inputsBefore = provider.inputs;
    pages["/docs/a"] = page("Alpha", [
      section("Setup", "install alpha"),
      section("Usage", "call omega"),
    ]);
    await g.refresh({ library: "fresh-lib" });
    expect(served.get("/docs/a")).toBe(1);
    expect(served.get("/docs/b") ?? 0).toBe(0);
    await eventually(async () =>
      (await g.call("list_libraries")).includes("4 of 4 embedded"),
    );
    expect(provider.inputs - inputsBefore).toBe(1);
    const search = await g.call("search_docs", { library: "fresh-lib", query: "omega" });
    expect(search).toContain(`${ORIGIN}/docs/a`);
  });

  it("re-embeds nothing when a page is served again with the same text", async () => {
    const { pages, g } = await collect();
    const inputsBefore = provider.inputs;
    // New bytes (so a new ETag and a full download), same content.
    pages["/docs/b"] = {
      body: pages["/docs/b"].body.replace("<main>", "<main><!-- rebuilt -->"),
    };
    await g.refresh({ library: "fresh-lib" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.inputs).toBe(inputsBefore);
  });

  it("removes a page the site no longer serves", async () => {
    const { site, g } = await collect();
    delete site.routes["/docs/c"];
    await g.refresh({ library: "fresh-lib" });
    expect(await g.call("list_libraries")).toContain("3 pages collected");
    const search = await g.call("search_docs", { library: "fresh-lib", query: "gamma" });
    expect(search).not.toMatch(/Result \d+: \S+\/docs\/c\n/);
  });

  it("revalidates with If-Modified-Since when a page has no ETag", async () => {
    let bodies = 0;
    fakeSite(ORIGIN, {
      "/docs/": (request) => {
        if (request.headers.get("if-modified-since") === "Wed, 01 Jan 2025 00:00:00 GMT") {
          return { body: "", status: 304 };
        }
        bodies++;
        return {
          ...html("Docs", "Dated page."),
          headers: { "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
        };
      },
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "fresh-lib" });
    expect(bodies).toBe(1);
    await grounded.refresh({ library: "fresh-lib" });
    expect(bodies).toBe(1);
  });
});
