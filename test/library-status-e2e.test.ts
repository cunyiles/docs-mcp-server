/**
 * Harnesses see what a library covers and whether it is healthy in the tools
 * they already call: `list_libraries` shows each version's status on one line,
 * and `search_docs` adds a note when the searched version needs attention.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventually,
  type FakeProvider,
  fakeProvider,
  fakeSite,
  type Grounded,
  removeStore,
  startGrounded,
} from "./harness";

const ORIGIN = "https://status-docs.test";

const md = (body: string) => ({ body, type: "text/markdown" });

function serveDocs(pageCount = 6) {
  const routes: Record<string, { body: string; type: string }> = {};
  const links = Array.from({ length: pageCount }, (_, i) => `- [Page ${i}](/docs/p${i})`);
  routes["/docs/"] = md(`# Docs\n\nIndex of pages.\n\n${links.join("\n")}\n`);
  for (let i = 0; i < pageCount; i++) {
    routes[`/docs/p${i}`] = md(`# Page ${i}\n\nTopic number ${i} explained in detail.\n`);
  }
  return fakeSite(ORIGIN, routes);
}

describe("Library status and coverage", () => {
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

  const statusLine = async () => {
    const text = (await grounded?.call("list_libraries")) ?? "";
    return text.split("\n").find((line) => line.startsWith("- status-lib")) ?? "";
  };

  it("shows version, entry point, coverage and last result on one line", async () => {
    provider = fakeProvider("ok");
    serveDocs();
    grounded = await startGrounded(withEmbeddings);
    await grounded.scrape({
      url: `${ORIGIN}/docs/`,
      library: "status-lib",
      version: "2.0.0",
    });

    await eventually(async () => (await statusLine()).includes("7 of 7 embedded"));
    const line = await statusLine();
    expect(line).toMatch(/^- status-lib@2\.0\.0: 7 pages collected, 7 of 7 embedded/);
    expect(line).toContain(`from ${ORIGIN}/docs/`);
    expect(line).toMatch(/last collection \d{4}-\d{2}-\d{2} completed/);
    expect(line).not.toContain("suspiciously small");
  });

  it("shows embedded below collected while the backlog waits, equal once drained", async () => {
    provider = fakeProvider("429");
    serveDocs();
    grounded = await startGrounded(withEmbeddings);
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "status-lib" });

    expect(await statusLine()).toContain("7 pages collected, 0 of 7 embedded");
    const search = await grounded.call("search_docs", {
      library: "status-lib",
      query: "topic",
    });
    expect(search).toContain("Note: status-lib: only 0 of 7 pages embedded so far");

    provider.mode = "ok";
    await eventually(async () => (await statusLine()).includes("7 of 7 embedded"));
    const healthy = await grounded.call("search_docs", {
      library: "status-lib",
      query: "topic",
    });
    expect(healthy).not.toContain("Note:");
  });

  it("reports a failed refresh in the status and in search results", async () => {
    const site = serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "status-lib" });

    site.routes["/docs/"] = { body: "unavailable", status: 500, type: "text/plain" };
    await grounded.refresh({ library: "status-lib" });

    const line = await statusLine();
    expect(line).toMatch(/last collection \S+ completed/);
    expect(line).toMatch(/last refresh \S+ failed \(.+\)/);

    const search = await grounded.call("search_docs", {
      library: "status-lib",
      query: "topic",
    });
    expect(search).toContain(`${ORIGIN}/docs/p`);
    const noteLines = search.split("\n").filter((l) => l.startsWith("Note:"));
    expect(noteLines).toHaveLength(1);
    expect(noteLines[0]).toMatch(/^Note: status-lib: last refresh failed on \d{4}-\d{2}-\d{2}/);
  });

  it("flags a library collected from a single page as suspiciously small", async () => {
    fakeSite(ORIGIN, { "/single": md("# Only page\n\nNothing links anywhere.\n") });
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/single`, library: "status-lib" });

    const line = await statusLine();
    expect(line).toContain("1 pages collected (keyword search only)");
    expect(line).toContain("suspiciously small collection");
    const search = await grounded.call("search_docs", {
      library: "status-lib",
      query: "page",
    });
    expect(search).toContain("suspiciously few pages collected");
  });
});
