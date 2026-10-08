/**
 * A library is made complete by adding entry points: guides and API reference
 * live under one name, and the server tells harnesses how to do that.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSite, type Grounded, html, removeStore, startGrounded } from "./harness";

const ORIGIN = "https://entry-docs.test";

function serveDocs() {
  return fakeSite(ORIGIN, {
    "/guide/": html("Guide", "Getting started with gizmos.", ["/guide/install", "/blog/news"]),
    "/guide/install": html("Install", "Install the gizmo package.", ["/reference/"]),
    "/reference/": html("Reference", "API reference index.", ["/reference/Gizmo"]),
    "/reference/Gizmo": html("Gizmo", "The Gizmo class spins widgets.", ["/guide/"]),
    "/blog/news": html("News", "Unrelated blog post about llamas."),
  });
}

describe("Entry points", () => {
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
      .find((line) => line.startsWith("- gizmo")) ?? "";

  it("adds a second entry point to the library instead of replacing it", async () => {
    const site = serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/guide/`, library: "gizmo" });
    expect(await statusLine()).toContain("2 pages collected");

    await grounded.scrape({ url: `${ORIGIN}/reference/`, library: "gizmo" });
    const line = await statusLine();
    expect(line).toContain("4 pages collected");
    expect(line).toContain(`from ${ORIGIN}/guide/, ${ORIGIN}/reference/`);
    // The guide pages were already collected and are not fetched again.
    expect(site.hits("/guide/install")).toBe(1);

    const guide = await grounded.call("search_docs", { library: "gizmo", query: "install" });
    expect(guide).toContain(`${ORIGIN}/guide/install`);
    const reference = await grounded.call("search_docs", { library: "gizmo", query: "spins" });
    expect(reference).toContain(`${ORIGIN}/reference/Gizmo`);
  });

  it("collects nothing outside every entry point", async () => {
    const site = serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/guide/`, library: "gizmo" });
    await grounded.scrape({ url: `${ORIGIN}/reference/`, library: "gizmo" });
    expect(site.hits("/blog/news")).toBe(0);
    const search = await grounded.call("search_docs", { library: "gizmo", query: "llamas" });
    expect(search).not.toContain("/blog/");
  });

  it("re-collects from all entry points on refresh", async () => {
    const site = serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/guide/`, library: "gizmo" });
    await grounded.scrape({ url: `${ORIGIN}/reference/`, library: "gizmo" });
    site.routes["/reference/Widget"] = html("Widget", "Widgets wobble gently.");
    site.routes["/reference/"] = html("Reference", "API reference index.", [
      "/reference/Gizmo",
      "/reference/Widget",
    ]);
    await grounded.refresh({ library: "gizmo" });
    expect(await statusLine()).toContain("5 pages collected");
    const search = await grounded.call("search_docs", { library: "gizmo", query: "wobble" });
    expect(search).toContain(`${ORIGIN}/reference/Widget`);
  });

  it("teaches naming and entry-point rules on initialize", async () => {
    grounded = await startGrounded();
    const instructions = grounded.instructions() ?? "";
    expect(instructions).toMatch(/lowercase/);
    expect(instructions).toMatch(/no "-docs" suffix/);
    expect(instructions).toMatch(/API reference/);
    expect(instructions).toMatch(/entry point/);
    expect(instructions).toMatch(/OpenAPI/);
    expect(instructions).toMatch(/older version only when a project needs it/);
  });
});
