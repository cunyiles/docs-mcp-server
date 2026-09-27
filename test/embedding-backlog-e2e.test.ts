/**
 * Collection and embedding are separate layers: a library is searchable by
 * keyword as soon as it is collected, and vectors follow in the background at
 * the provider's pace, whatever the provider does meanwhile.
 */

import path from "node:path";
import Database from "better-sqlite3";
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

const ORIGIN = "https://backlog-docs.test";
const CAR_PAGE = "# Driving\n\nHow to park a sedan in a narrow garage.\n";
const DOG_PAGE = "# Pets\n\nTeaching a puppy to sit and stay.\n";

function serveDocs() {
  return fakeSite(ORIGIN, {
    "/docs/": {
      body: "# Docs\n\nStart here.\n\n- [Driving](/docs/driving)\n- [Pets](/docs/pets)\n",
      type: "text/markdown",
    },
    "/docs/driving": { body: CAR_PAGE, type: "text/markdown" },
    "/docs/pets": { body: DOG_PAGE, type: "text/markdown" },
  });
}

describe("Embedding backlog", () => {
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
    config.embeddings.required = true;
  };

  /** A question sharing no keyword with the page it should find. */
  const semanticHit = async (question: string, expectedPath: string) => {
    const text = await grounded?.call("search_docs", {
      library: "backlog-lib",
      query: question,
      limit: 1,
    });
    return text?.includes(`Result 1: ${ORIGIN}${expectedPath}`) ?? false;
  };

  it("collects and keyword-indexes a library while the provider answers 429", async () => {
    provider = fakeProvider("429");
    serveDocs();
    grounded = await startGrounded(withEmbeddings);

    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "backlog-lib" });
    const jobs = await grounded.call("list_jobs", {});
    expect(jobs).toContain("Status: completed");

    const found = await grounded.call("search_docs", {
      library: "backlog-lib",
      query: "garage",
    });
    expect(found).toContain(`${ORIGIN}/docs/driving`);
    expect(provider.requests).toBeGreaterThan(0);
  });

  it("drains the backlog by itself once the provider recovers", async () => {
    provider = fakeProvider("429");
    serveDocs();
    grounded = await startGrounded(withEmbeddings);
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "backlog-lib" });

    expect(await semanticHit("automobile", "/docs/driving")).toBe(false);

    provider.mode = "ok";
    await eventually(() => semanticHit("automobile", "/docs/driving"));
    await eventually(() => semanticHit("canine", "/docs/pets"));
  });

  it("resumes embedding after a restart without losing a chunk", async () => {
    provider = fakeProvider("429");
    serveDocs();
    grounded = await startGrounded(withEmbeddings);
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "backlog-lib" });

    provider.mode = "ok";
    grounded = await grounded.restart();

    await eventually(() => semanticHit("automobile", "/docs/driving"));
    await eventually(() => semanticHit("canine", "/docs/pets"));

    const db = new Database(path.join(grounded.storeDir, "documents.db"), {
      readonly: true,
    });
    try {
      const pending = db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE embedding IS NULL")
        .get() as { n: number };
      const total = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as {
        n: number;
      };
      expect(total.n).toBeGreaterThanOrEqual(3);
      expect(pending.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps each page's whole Markdown across a restart", async () => {
    serveDocs();
    grounded = await startGrounded();
    await grounded.scrape({ url: `${ORIGIN}/docs/`, library: "backlog-lib" });
    grounded = await grounded.restart();

    const db = new Database(path.join(grounded.storeDir, "documents.db"), {
      readonly: true,
    });
    try {
      const row = db
        .prepare("SELECT markdown FROM pages WHERE url = ?")
        .get(`${ORIGIN}/docs/driving`) as { markdown: string };
      expect(row.markdown).toContain("How to park a sedan in a narrow garage.");
      expect(row.markdown).toContain("# Driving");
    } finally {
      db.close();
    }
  });
});
