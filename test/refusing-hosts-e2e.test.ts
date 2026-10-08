/**
 * A host that refuses plain requests is reached another way: its www/apex
 * twin, a web archive, a reader proxy, browser impersonation. The way that
 * worked shows in the status, and so does a host nothing got into.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeRoute, fakeSite, type Grounded, html, removeStore, startGrounded } from "./harness";

const forbidden: FakeRoute = { body: "Forbidden", status: 403, type: "text/plain" };
const refuseAll = (origin: string) => fakeSite(origin, { "/docs/": forbidden, "/docs/a": forbidden });

describe("Refusing hosts", () => {
  let grounded: Grounded | undefined;
  let local: Server | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    await new Promise((resolve) => (local ? local.close(resolve) : resolve(undefined)));
    local = undefined;
    vi.unstubAllEnvs();
  });

  const status = async (library: string) =>
    ((await grounded?.call("list_libraries")) ?? "")
      .split("\n")
      .find((line) => line.startsWith(`- ${library}`)) ?? "";

  it("collects a refusing host from its www twin and keeps the host's own URLs", async () => {
    refuseAll("https://refuse-a.test");
    fakeSite("https://www.refuse-a.test", {
      "/docs/": html("Docs", "Alpha root.", ["https://www.refuse-a.test/docs/a"]),
      "/docs/a": html("A", "Ostrich facts from the twin."),
    });
    grounded = await startGrounded();
    await grounded.scrape({ url: "https://refuse-a.test/docs/", library: "alt" });

    const search = await grounded.call("search_docs", { library: "alt", query: "ostrich" });
    expect(search).toContain("Result 1: https://refuse-a.test/docs/a");
    expect(await status("alt")).toContain("reached refuse-a.test via alternate host www.refuse-a.test");
  });

  it("collects a refusing host from a web archive snapshot", async () => {
    refuseAll("https://refuse-b.test");
    const archive = fakeSite("https://archive.fake.test", {
      "/web/2id_/https://refuse-b.test/docs/": html("Docs", "Archived root.", [
        "https://refuse-b.test/docs/a",
      ]),
      "/web/2id_/https://refuse-b.test/docs/a": html("A", "Pelican facts from the archive."),
    });
    grounded = await startGrounded((config) => {
      config.scraper.fetcher.archiveBase = "https://archive.fake.test/web/2id_/";
    });
    await grounded.scrape({ url: "https://refuse-b.test/docs/", library: "arch" });

    const search = await grounded.call("search_docs", { library: "arch", query: "pelican" });
    expect(search).toContain("Result 1: https://refuse-b.test/docs/a");
    expect(await status("arch")).toContain("reached refuse-b.test via web archive");
    // Once known, later pages go straight to the archive.
    expect(archive.hits("/web/2id_/https://refuse-b.test/docs/a")).toBe(1);
  });

  it("uses a reader proxy only when one is configured", async () => {
    refuseAll("https://refuse-c.test");
    const reader = fakeSite("https://reader.fake.test", {
      "/https://refuse-c.test/docs/": {
        body: "# Docs\n\nRead through the proxy. [A](https://refuse-c.test/docs/a)\n",
        type: "text/plain",
      },
      "/https://refuse-c.test/docs/a": { body: "# A\n\nFlamingo facts.\n", type: "text/plain" },
    });
    grounded = await startGrounded();
    const failed = await grounded.callRaw("scrape_docs", {
      url: "https://refuse-c.test/docs/",
      library: "proxied",
    });
    await grounded.waitForJobs();
    expect(failed.isError).toBe(false);
    expect(reader.hits("/https://refuse-c.test/docs/")).toBe(0);
    await grounded.stop();
    removeStore(grounded.storeDir);

    grounded = await startGrounded((config) => {
      config.scraper.fetcher.readerProxy = "https://reader.fake.test/";
    });
    await grounded.scrape({ url: "https://refuse-c.test/docs/", library: "proxied" });
    const search = await grounded.call("search_docs", { library: "proxied", query: "flamingo" });
    expect(search).toContain("Result 1: https://refuse-c.test/docs/a");
    expect(await status("proxied")).toContain("via reader proxy");
  });

  it("names a host that refused every way in, while the library's other hosts collect", async () => {
    fakeSite("https://open-docs.test", {
      "/guide/": html("Guide", "Penguin guide.", ["/guide/b"]),
      "/guide/b": html("B", "More penguins."),
    });
    refuseAll("https://refuse-d.test");
    grounded = await startGrounded();
    await grounded.scrape({ url: "https://open-docs.test/guide/", library: "mixed" });
    await grounded.scrape({ url: "https://refuse-d.test/docs/", library: "mixed" });

    const line = await status("mixed");
    expect(line).toContain("2 pages collected");
    expect(line).toMatch(/refused by refuse-d\.test \(HTTP 403; no other way in worked\)/);
    const search = await grounded.call("search_docs", { library: "mixed", query: "penguin" });
    expect(search).toContain("not collected from refuse-d.test");
  });

  it("impersonates a browser only for a host that refused, and counts it", async () => {
    // A real local server, since impersonation does its own networking.
    local = createServer((request, response) => {
      const browserLike = /Chrome\//.test(request.headers["user-agent"] ?? "");
      if (!browserLike) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/docs/"
          ? '<html><body><main><h1>Docs</h1><p>Iguana root page with enough words to read.</p><a href="/docs/a">A</a></main></body></html>'
          : "<html><body><main><h1>A</h1><p>Iguana details behind a fingerprint check.</p></main></body></html>",
      );
    });
    await new Promise<void>((resolve) => local?.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    const normal = fakeSite("https://plain-docs.test", {
      "/docs/": html("Plain", "Gecko root.", ["/docs/a"]),
      "/docs/a": html("A", "Gecko page."),
    });

    grounded = await startGrounded((config) => {
      config.scraper.fetcher.impersonate = true;
    });
    await grounded.scrape({ url: `${origin}/docs/`, library: "fingerprint" });
    await grounded.scrape({ url: "https://plain-docs.test/docs/", library: "plain" });

    const guarded = await status("fingerprint");
    expect(guarded).toContain("2 pages collected");
    expect(guarded).toContain("via impersonation");
    expect(guarded).toContain("2 pages fetched with browser impersonation");
    const plain = await status("plain");
    expect(plain).not.toContain("impersonation");
    expect(plain).not.toContain("browser");
    expect(normal.hits("/docs/a")).toBe(1);
  });
});
