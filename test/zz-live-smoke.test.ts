import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { removeStore, startGrounded } from "./harness";

const OUT =
  "/private/tmp/claude-501/-Volumes-PROJE-DevProjects-grounded/209e0bf7-cbdb-4136-abfa-944f578095e1/scratchpad/live.txt";
const log = (...a: unknown[]) => appendFileSync(OUT, `${a.map(String).join(" ")}\n`);

const SITES: Array<[string, string[], string]> = (
  JSON.parse(process.env.LIVE_SITES ?? "[]") as Array<[string, string[], string]>
);

it.each(SITES)("live %s", async (library, urls, query) => {
  const g = await startGrounded((config) => {
    config.scraper.fetcher.maxRetries = 1;
    config.scraper.maxDepth = -1;
    config.scraper.fetcher.impersonate = true;
    config.scraper.fetcher.archiveBase = "https://web.archive.org/web/2id_/";
  });
  const started = Date.now();
  for (const url of urls) {
    log(await g.scrape({ url, library, maxPages: Number(process.env.LIVE_PAGES ?? 15) }));
  }
  log(`\n===== ${library} (${Math.round((Date.now() - started) / 1000)}s)`);
  log(await g.call("list_libraries"));
  log((await g.call("list_jobs")).split("\n").filter((l) => l.includes("Error")).join("\n"));
  log((await g.call("search_docs", { library, query, limit: 2 })).slice(0, 700));
  await g.stop();
  removeStore(g.storeDir);
}, 900_000);
