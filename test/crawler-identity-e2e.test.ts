/**
 * Collection approaches every site honestly: a configured crawler identity,
 * plain HTTP with compression, and a browser only for pages that cannot be
 * read as served (an empty JavaScript shell).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FakePage,
  fakeSite,
  type Grounded,
  html,
  removeStore,
  startGrounded,
} from "./harness";

const ORIGIN = "https://identity-docs.test";
const LONG = "This page explains how requests are configured and retried. ".repeat(4);

describe("Crawler identity and rendering", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const statusLine = async (library: string) => {
    const text = (await grounded?.call("list_libraries")) ?? "";
    return text.split("\n").find((line) => line.startsWith(`- ${library}`)) ?? "";
  };

  it("is served directly by a site that sends browser-looking clients to a login page", async () => {
    vi.stubEnv("DOCS_MCP_SCRAPER_FETCHER_USER_AGENT", "ExampleDocsBot/1.0 (+https://bot.test)");
    const page = (title: string, links: string[] = []) => (request: Request): FakePage => {
      const agent = request.headers.get("user-agent") ?? "";
      if (/Mozilla|Chrome|Safari/.test(agent)) {
        return { body: "", status: 302, headers: { location: `${ORIGIN}/login` } };
      }
      return html(title, `${title}. ${LONG}`, links);
    };
    const site = fakeSite(ORIGIN, {
      "/docs/": page("Overview", ["/docs/install", "/docs/usage"]),
      "/docs/install": page("Install"),
      "/docs/usage": page("Usage"),
      "/login": html("Sign in", "Sign in to continue to your account."),
    });
    grounded = await startGrounded();

    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "identity-lib" });

    expect(await statusLine("identity-lib")).toContain("3 pages collected");
    const search = await grounded.call("search_docs", {
      library: "identity-lib",
      query: "sign in account",
    });
    expect(search).not.toContain(`${ORIGIN}/login`);
    expect(site.hits("/login")).toBe(0);
    for (const request of site.log) {
      expect(request.headers.get("user-agent")).toBe("ExampleDocsBot/1.0 (+https://bot.test)");
      expect(request.headers.get("accept-encoding")).toContain("gzip");
    }
  });

  it("names the software, not a deployment, by default", async () => {
    const site = fakeSite(ORIGIN, { "/solo": html("Solo", LONG) });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/solo`, library: "identity-lib" });
    const agent = site.log[0]?.headers.get("user-agent") ?? "";
    expect(agent).toMatch(/^docs-mcp-server\b/);
  });

  it("collects a server-rendered site without starting a browser", async () => {
    const ssr = (title: string, links: string[] = []): FakePage => ({
      body: `<!doctype html><html><head><title>${title}</title><script src="/assets/app.js"></script></head><body><div id="__next" data-reactroot=""><main><h1>${title}</h1><p>${LONG}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</main></div><script>window.__DATA__={}</script></body></html>`,
    });
    fakeSite(ORIGIN, {
      "/docs/": ssr("Overview", ["/docs/a", "/docs/b"]),
      "/docs/a": ssr("Alpha"),
      "/docs/b": ssr("Beta"),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "ssr-lib" });

    const line = await statusLine("ssr-lib");
    expect(line).toContain("3 pages collected");
    expect(line).not.toContain("rendered in a browser");
  });

  it("renders an empty JavaScript shell in a browser and counts it", async () => {
    fakeSite(ORIGIN, {
      "/app/": {
        body: `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script>document.getElementById("root").innerHTML = "<main><h1>Widgets</h1><p>Hydrated guide to configuring widgets and gadgets for production use.</p></main>";</script></body></html>`,
      },
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/app/`, library: "shell-lib" });

    const search = await grounded.call("search_docs", {
      library: "shell-lib",
      query: "hydrated widgets",
    });
    expect(search).toContain(`${ORIGIN}/app`);
    expect(search).toContain("Hydrated guide");
    expect(await statusLine("shell-lib")).toContain("1 pages rendered in a browser");
  }, 60_000);
});
