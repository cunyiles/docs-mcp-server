/** Removal contracts exercised through the real service, tools, and SQLite store. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBusService } from "../src/events";
import { PipelineManager } from "../src/pipeline/PipelineManager";
import { DocumentManagementService } from "../src/store/DocumentManagementService";
import { LibraryNotFoundInStoreError, VersionNotFoundInStoreError } from "../src/store/errors";
import { dataRouter } from "../src/store/trpc/router";
import { RemoveTool } from "../src/tools/RemoveTool";
import { SearchTool } from "../src/tools/SearchTool";
import { loadConfig } from "../src/utils/config";

describe("Exact version removal", () => {
  let directory: string;
  let service: DocumentManagementService;
  let remove: RemoveTool;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "version-removal-"));
    const config = loadConfig();
    config.app.storePath = directory;
    config.app.embeddingModel = "";
    const events = new EventBusService();
    service = new DocumentManagementService(events, config);
    await service.initialize();
    const pipeline = new PipelineManager(service, events, { recoverJobs: false, appConfig: config });
    remove = new RemoveTool(service, pipeline);
  });

  afterEach(async () => {
    await service?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  async function seed(version: string) {
    await service.addScrapeResult("example", version, 0, {
      url: `https://example.com/${version || "unversioned"}`,
      title: "Documentation",
      contentType: "text/markdown",
      sourceContentType: "text/markdown",
      textContent: "Nebula documentation content",
      errors: [],
      links: [],
      chunks: [{ content: "Nebula documentation content", types: ["text"], section: { level: 0, path: [] } }],
    });
  }

  it("reports a missing version instead of successful removal", async () => {
    await seed("1.0.0");
    await expect(remove.execute({ library: "example", version: "2.0.0" })).rejects.toThrow("not found");
    expect(await service.listVersions("example")).toEqual(["1.0.0"]);
  });

  it("preserves intentional unversioned content when an explicit target is missing", async () => {
    await seed("");
    await expect(service.removeVersion("example", "missing")).rejects.toThrow(VersionNotFoundInStoreError);
    const results = await service.searchStore("example", "", "Nebula");
    expect(results.map(result => result.url)).toEqual(["https://example.com/unversioned"]);
  });

  it("omitted version removes only the unversioned bucket", async () => {
    await seed("");
    await seed("latest");
    await seed("2.0.0");
    await remove.execute({ library: "example" });
    expect(await service.listVersions("example")).toEqual(["2.0.0", "latest"]);
    expect(await service.searchStore("example", "", "Nebula")).toEqual([]);
  });

  it("rejects omitted version when only named versions exist", async () => {
    await seed("latest");
    await expect(remove.execute({ library: "example" })).rejects.toThrow("not found");
    expect(await service.listVersions("example")).toEqual(["latest"]);
  });

  it("propagates missing-target errors through the data RPC", async () => {
    await seed("1.0.0");
    await expect(dataRouter.createCaller({ docService: service }).removeVersion({ library: "example", version: "missing" })).rejects.toThrow("not found");
  });

  it("removes the library when its final version is removed", async () => {
    await seed("1.0.0");
    await remove.execute({ library: "example", version: "1.0.0" });
    await expect(service.validateLibraryExists("example")).rejects.toThrow(LibraryNotFoundInStoreError);
  });

  it("cleans up a genuinely empty library for an omitted target", async () => {
    const database = new Database(join(directory, "documents.db"));
    database.prepare("INSERT INTO libraries (name) VALUES (?)").run("example");
    database.close();
    await remove.execute({ library: "example" });
    await expect(service.validateLibraryExists("example")).rejects.toThrow(LibraryNotFoundInStoreError);
  });

  it("does not treat an explicit missing target as empty-library cleanup", async () => {
    const database = new Database(join(directory, "documents.db"));
    database.prepare("INSERT INTO libraries (name) VALUES (?)").run("example");
    database.close();
    await expect(service.removeVersion("example", "missing")).rejects.toThrow(VersionNotFoundInStoreError);
    await expect(service.validateLibraryExists("example")).resolves.toBeUndefined();
  });

  it("searches the intentional unversioned bucket with an explicit empty exact target", async () => {
    await seed("");
    await seed("latest");
    await seed("2.0.0");
    const result = await new SearchTool(service).execute({ library: "example", version: "", exactMatch: true, query: "Nebula" });
    expect(result.results.map(hit => hit.url)).toEqual(["https://example.com/unversioned"]);
  });
});
