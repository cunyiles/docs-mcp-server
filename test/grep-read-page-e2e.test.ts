/**
 * Besides `search_docs` (a question), harnesses get `grep_docs` (an exact name
 * or regex, answered with page and line) and `read_page` (one whole page).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSite, type Grounded, removeStore, startGrounded } from "./harness";

const ORIGIN = "https://grep-docs.test";

const md = (body: string) => ({ body, type: "text/markdown" });

function serveDocs() {
  return fakeSite(ORIGIN, {
    "/docs/": md(
      "# Docs\n\nStart here.\n\n- [Layout](/docs/layout)\n- [Errors](/docs/errors)\n- [Many](/docs/many)\n",
    ),
    "/docs/layout": md(
      "# Layout\n\nUse `Modifier.padding` to add space.\n\nAnother paragraph about margins.\n\n```kotlin\nBox(Modifier.padding(8.dp))\n```\n",
    ),
    "/docs/errors": md(
      "# Errors\n\nA `TimeoutError` is raised after thirty seconds.\n\nModifier.paddingFoo is not the same thing.\n",
    ),
    "/docs/many": md(
      `# Many\n\n${Array.from({ length: 40 }, (_, i) => `Line ${i} mentions widgetCount here.`).join("\n\n")}\n`,
    ),
  });
}

describe("grep_docs and read_page", () => {
  let grounded: Grounded | undefined;

  afterEach(async () => {
    await grounded?.stop();
    if (grounded) removeStore(grounded.storeDir);
    grounded = undefined;
    vi.unstubAllEnvs();
  });

  const collect = async (version?: string) => {
    serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "grep-lib", version });
    return grounded;
  };

  it("finds every page and line holding an exact identifier, and nothing else", async () => {
    const g = await collect();
    const text = await g.call("grep_docs", {
      library: "grep-lib",
      pattern: "Modifier.padding(",
    });
    const hits = text.split("\n").filter((line) => line.startsWith(ORIGIN));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(new RegExp(`^${ORIGIN}/docs/layout:\\d+: Box\\(Modifier\\.padding\\(8\\.dp\\)\\)$`));

    const word = await g.call("grep_docs", { library: "grep-lib", pattern: "Modifier.padding" });
    const pages = new Set(
      word
        .split("\n")
        .filter((line) => line.startsWith(ORIGIN))
        .map((line) => line.split(":").slice(0, 2).join(":")),
    );
    expect([...pages].sort()).toEqual([`${ORIGIN}/docs/errors`, `${ORIGIN}/docs/layout`]);
    expect(word).not.toContain("margins");
  });

  it("matches a regular expression", async () => {
    const g = await collect();
    const text = await g.call("grep_docs", {
      library: "grep-lib",
      pattern: "/[A-Z][a-z]+Error\\b/",
    });
    expect(text).toMatch(new RegExp(`${ORIGIN}/docs/errors:\\d+: .*TimeoutError`));
    expect(text).not.toContain("/docs/layout");
  });

  it("caps the matches with a clear note about the rest", async () => {
    const g = await collect();
    const text = await g.call("grep_docs", { library: "grep-lib", pattern: "widgetCount" });
    const hits = text.split("\n").filter((line) => line.startsWith(ORIGIN));
    expect(hits.length).toBeLessThan(40);
    expect(text).toMatch(/more matches not shown/);
  });

  it("rejects an invalid regular expression with a clear error", async () => {
    const g = await collect();
    const result = await g.callRaw("grep_docs", { library: "grep-lib", pattern: "/(unclosed/" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid regular expression/i);
  });

  it("returns the whole page that search found", async () => {
    const g = await collect();
    const search = await g.call("search_docs", { library: "grep-lib", query: "margins" });
    const url = search.match(/Result 1: (\S+)/)?.[1];
    expect(url).toBe(`${ORIGIN}/docs/layout`);

    const page = await g.call("read_page", { library: "grep-lib", url });
    expect(page).toContain("Use `Modifier.padding` to add space.");
    expect(page).toContain("Another paragraph about margins.");
    expect(page).toContain("Box(Modifier.padding(8.dp))");
  });

  it("answers an unknown page with a clear error", async () => {
    const g = await collect();
    const result = await g.callRaw("read_page", {
      library: "grep-lib",
      url: `${ORIGIN}/docs/nowhere`,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${ORIGIN}/docs/nowhere`);
    expect(result.text).toMatch(/not .*in grep-lib/i);
  });

  it("resolves versions like search_docs", async () => {
    const g = await collect("1.4.2");
    const grep = await g.call("grep_docs", {
      library: "grep-lib",
      version: "1.x",
      pattern: "TimeoutError",
    });
    expect(grep).toContain(`${ORIGIN}/docs/errors:`);
    const latest = await g.call("read_page", { library: "grep-lib", url: `${ORIGIN}/docs/errors` });
    expect(latest).toContain("TimeoutError");
  });

  it("describes which need each of the three tools serves in its first sentence", async () => {
    const g = await collect();
    const { tools } = await g.listTools();
    const first = (name: string) =>
      (tools.find((tool) => tool.name === name)?.description ?? "").split(". ")[0];
    expect(first("search_docs")).toMatch(/question/i);
    expect(first("grep_docs")).toMatch(/exact/i);
    expect(first("read_page")).toMatch(/whole page/i);
  });
});
