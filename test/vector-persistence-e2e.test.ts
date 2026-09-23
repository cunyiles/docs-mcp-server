/** Exercises vector persistence, required readiness, and atomic refresh failures. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "dotenv";
import { delay, http, HttpResponse } from "msw";
import * as sqliteVec from "sqlite-vec";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EventBusService } from "../src/events";
import { PipelineFactory } from "../src/pipeline/PipelineFactory";
import { PipelineManager } from "../src/pipeline/PipelineManager";
import { PipelineJobStatus } from "../src/pipeline/types";
import { ScrapeMode, type ScrapeResult } from "../src/scraper/types";
import { createLocalDocumentManagement } from "../src/store";
import { DocumentManagementService } from "../src/store/DocumentManagementService";
import { DocumentStore } from "../src/store/DocumentStore";
import {
  EmbeddingConfig,
  type EmbeddingModelConfig,
} from "../src/store/embeddings/EmbeddingConfig";
import { ScrapeTool } from "../src/tools/ScrapeTool";
import {
  type AppConfig,
  loadConfig,
  markVectorDimensionSource,
} from "../src/utils/config";
import { logger } from "../src/utils/logger";
import { server } from "./mock-server";

config();

describe("Vector persistence", () => {
  let tempDir: string;
  let pipeline: any;
  let docService: any;
  let scrapeTool: ScrapeTool;
  const appConfig = loadConfig();

  let prevOpenAiApiKey: string | undefined;
  let prevOpenAiApiBase: string | undefined;

  beforeAll(async () => {
    // Ensure vector search initializes in tests without requiring real credentials.
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    prevOpenAiApiBase = process.env.OPENAI_API_BASE;

    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
    delete process.env.OPENAI_API_BASE;

    tempDir = mkdtempSync(path.join(tmpdir(), "vector-persistence-e2e-"));
    const embeddingConfig: EmbeddingModelConfig = EmbeddingConfig.parseEmbeddingConfig(
      "openai:text-embedding-3-small",
    );

    appConfig.app.storePath = tempDir;
    appConfig.app.embeddingModel = embeddingConfig.modelSpec;

    // The test scrapes a real file under process.cwd(), which in CI/worktree
    // setups can live under a hidden segment (e.g. `.claude/worktrees/...`).
    // Loosen the local file policy for this e2e test so the path itself does
    // not become the thing under test.
    appConfig.scraper.security.fileAccess.mode = "unrestricted";
    appConfig.scraper.security.fileAccess.includeHidden = true;
    appConfig.scraper.security.fileAccess.followSymlinks = true;

    const eventBus = new EventBusService();
    docService = await createLocalDocumentManagement(eventBus, appConfig);

    pipeline = await PipelineFactory.createPipeline(docService, eventBus, {
      appConfig,
    });
    await pipeline.start();

    scrapeTool = new ScrapeTool(pipeline, appConfig.scraper);
  }, 30000);

  afterAll(async () => {
    if (pipeline) {
      await pipeline.stop();
    }
    if (docService) {
      await docService.shutdown();
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }

    if (prevOpenAiApiBase === undefined) {
      delete process.env.OPENAI_API_BASE;
    } else {
      process.env.OPENAI_API_BASE = prevOpenAiApiBase;
    }
  });

  it("persists embeddings into documents_vec", async () => {
    const readmePath = path.resolve(process.cwd(), "README.md");
    const fileUrl = `file://${readmePath}`;

    await scrapeTool.execute({
      library: "vector-persist-lib",
      version: "1.0.0",
      url: fileUrl,
      waitForCompletion: true,
    });

    const exists = await docService.exists("vector-persist-lib", "1.0.0");
    expect(exists).toBe(true);

    const dbPath = path.join(tempDir, "documents.db");
    const db = new Database(dbPath);
    sqliteVec.load(db);

    const { chunkCount } = db
      .prepare("SELECT COUNT(*) as chunkCount FROM documents WHERE embedding IS NOT NULL")
      .get() as { chunkCount: number };
    expect(chunkCount).toBeGreaterThan(0);

    const { vecCount } = db
      .prepare("SELECT COUNT(*) as vecCount FROM documents_vec")
      .get() as { vecCount: number };
    expect(vecCount).toBeGreaterThan(0);
    expect(vecCount).toBe(chunkCount);
  }, 60000);
});

/** Required readiness and replacement run through the real provider and SQLite. */
describe("Embedding readiness and atomic replacement", () => {
  let directory: string;
  let settings: AppConfig;
  const stores: DocumentStore[] = [];
  let service: DocumentManagementService | undefined;
  let manager: PipelineManager | undefined;
  let responseVector: unknown[];
  let rejectEmbedding = false;
  let requests = 0;
  let failRequest = 0;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "embedding-readiness-"));
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_BASE", "https://embeddings.example.com/v1");
    settings = loadConfig();
    settings.app.storePath = directory;
    settings.app.embeddingModel = "openai:text-embedding-3-small";
    settings.embeddings.required = true;
    settings.embeddings.initTimeoutMs = 100;
    settings.embeddings.requestTimeoutMs = 200;
    responseVector = Array(1536).fill(0.01);
    rejectEmbedding = false;
    requests = 0;
    failRequest = 0;
    vi.mocked(logger.info).mockClear();
    server.use(
      http.get(
        "https://docs.example.com/llms.txt",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.post("https://embeddings.example.com/v1/embeddings", async ({ request }) => {
        requests++;
        if (rejectEmbedding || requests === failRequest) {
          return HttpResponse.json(
            { error: { message: "provider unavailable" } },
            { status: 400 },
          );
        }
        const body = (await request.json()) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return HttpResponse.json({
          object: "list",
          model: "text-embedding-3-small",
          data: inputs.map((_, index) => ({
            object: "embedding",
            index,
            embedding: responseVector,
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }),
    );
  });

  afterEach(async () => {
    await manager?.stop();
    await service?.shutdown();
    manager = undefined;
    service = undefined;
    for (const store of stores.splice(0)) await store.shutdown();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function openStore(): DocumentStore {
    const store = new DocumentStore(path.join(directory, "documents.db"), settings);
    stores.push(store);
    return store;
  }

  function page(
    content = "previous searchable content",
    url = "https://docs.example.com/page.md",
  ): ScrapeResult {
    return {
      url,
      title: content,
      textContent: content,
      contentType: "text/markdown",
      sourceContentType: "text/markdown",
      etag: content,
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
      links: [],
      errors: [],
      chunks: [{ content, types: ["text"], section: { level: 0, path: [] } }],
    };
  }

  function snapshot() {
    const db = new Database(path.join(directory, "documents.db"));
    sqliteVec.load(db);
    try {
      return {
        pages: db.prepare("SELECT * FROM pages ORDER BY id").all(),
        chunks: db.prepare("SELECT * FROM documents ORDER BY id").all(),
        vectors: db
          .prepare("SELECT rowid, embedding FROM documents_vec ORDER BY rowid")
          .all(),
      };
    } finally {
      db.close();
    }
  }

  it.each(["model", "credentials"])(
    "rejects required startup without %s",
    async (missing) => {
      if (missing === "model") settings.app.embeddingModel = "";
      else vi.stubEnv("OPENAI_API_KEY", "");
      await expect(openStore().initialize()).rejects.toThrow();
    },
  );

  it("probes a known model once before declaring vector readiness", async () => {
    await openStore().initialize();
    expect(requests).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "✅ Vector search enabled: openai:text-embedding-3-small (1536d)",
    );
  });

  it("rejects an offline cached provider and preserves indexed vectors", async () => {
    const initial = openStore();
    await initial.initialize();
    await initial.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    rejectEmbedding = true;
    const next = openStore();
    await expect(next.initialize()).rejects.toThrow();
    expect(next.getActiveEmbeddingConfig()).toBeNull();
    expect(snapshot()).toEqual(previous);
  });

  it.each([
    { name: "empty", vector: [] },
    { name: "nonfinite", vector: Array(1536).fill(null) },
    { name: "wrong dimension", vector: [0.1, 0.2] },
  ])("rejects $name probe vectors", async ({ vector }) => {
    responseVector = vector;
    await expect(openStore().initialize()).rejects.toThrow();
  });

  it("bounds a required known-model startup probe by the initialization timeout", async () => {
    server.use(
      http.get(
        "https://docs.example.com/llms.txt",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.post("https://embeddings.example.com/v1/embeddings", async () => {
        await delay(200);
        return HttpResponse.json({ data: [{ embedding: Array(1536).fill(0.01) }] });
      }),
    );
    await expect(openStore().initialize()).rejects.toThrow(/timed out/);
  });

  it("keeps optional FTS available without credentials", async () => {
    settings.embeddings.required = false;
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    expect(await store.findByContent("library", "1.0", "searchable", 5)).toHaveLength(1);
    expect(requests).toBe(0);
  });

  it("rejects query transport failure rather than returning FTS success", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    rejectEmbedding = true;
    await expect(
      store.findByContent("library", "1.0", "searchable", 5),
    ).rejects.toThrow();
  });

  it("rolls back chunks, vectors and validators when an insert fails mid-replacement", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    const db = new Database(path.join(directory, "documents.db"));
    db.exec(
      "CREATE TRIGGER reject_replacement BEFORE INSERT ON documents WHEN NEW.sort_order = 1 BEGIN SELECT RAISE(ABORT, 'controlled insert failure'); END",
    );
    try {
      const replacement = page("replacement");
      replacement.chunks.push({
        content: "second chunk",
        types: ["text"],
        section: { level: 0, path: [] },
      });
      await expect(
        store.addDocuments("library", "1.0", 0, replacement),
      ).rejects.toThrow();
      expect(snapshot()).toEqual(previous);
    } finally {
      db.close();
    }
  });

  it("keeps the previous page after a later embedding batch fails", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    // A new store uses the configured batch boundary through its public constructor.
    settings.embeddings.batchSize = 1;
    const next = openStore();
    await next.initialize();
    const replacement = page("replacement");
    replacement.chunks.push({
      content: "second chunk",
      types: ["text"],
      section: { level: 0, path: [] },
    });
    failRequest = requests + 2;
    await expect(next.addDocuments("library", "1.0", 0, replacement)).rejects.toThrow();
    expect(snapshot()).toEqual(previous);
  });

  it("rejects invalid document embeddings before replacing searchable content", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    responseVector = [];
    await expect(
      store.addDocuments("library", "1.0", 0, page("replacement")),
    ).rejects.toThrow();
    expect(snapshot()).toEqual(previous);
  });

  it("rejects a missing batch embedding without replacing old content", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    server.use(
      http.get(
        "https://docs.example.com/llms.txt",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.post("https://embeddings.example.com/v1/embeddings", () =>
        HttpResponse.json({
          object: "list",
          data: [],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      ),
    );
    await expect(
      store.addDocuments("library", "1.0", 0, page("replacement")),
    ).rejects.toThrow();
    expect(snapshot()).toEqual(previous);
  });

  it("preserves vectors if the provider fails while resolving a model change", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    settings.app.embeddingModel = "openai:text-embedding-ada-002";
    const changed = openStore();
    await expect(changed.initialize()).rejects.toThrow();
    rejectEmbedding = true;
    await expect(changed.resolveModelChange()).rejects.toThrow();
    expect(snapshot()).toEqual(previous);
  });

  it("validates a cached model with an explicitly padded database dimension", async () => {
    settings.embeddings.vectorDimension = 3072;
    markVectorDimensionSource(settings, true);
    await openStore().initialize();
    await expect(openStore().initialize()).resolves.toBeUndefined();
    expect(requests).toBe(2);
  });

  it("recovers unknown native width after a fresh-module restart with explicit padding", async () => {
    const model = "unknown-padded-restart-model";
    settings.app.embeddingModel = `openai:${model}`;
    settings.embeddings.vectorDimension = 1536;
    markVectorDimensionSource(settings, true);
    responseVector = Array(384).fill(0.01);
    const first = openStore();
    await first.initialize();
    await first.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    const previousSearch = await first.findByContent("library", "1.0", "searchable", 5);
    await first.shutdown();
    stores.pop();

    // Reload the module graph as on process startup; no discovered dimension survives.
    vi.resetModules();
    const { DocumentStore: RestartedStore } = await import("../src/store/DocumentStore");
    const { EmbeddingConfig: RestartedEmbeddingConfig } = await import(
      "../src/store/embeddings/EmbeddingConfig"
    );
    const { markVectorDimensionSource: markRestartedDimension } = await import(
      "../src/utils/config"
    );
    expect(RestartedEmbeddingConfig.getKnownModelDimensions(model)).toBeNull();
    markRestartedDimension(settings, true);
    const restarted = new RestartedStore(path.join(directory, "documents.db"), settings);
    stores.push(restarted);
    requests = 0;
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(requests).toBe(1);
    expect(restarted.getEmbeddingMetadata()).toEqual({
      model: `openai:${model}`,
      dimension: "1536",
    });
    expect(snapshot()).toEqual(previous);
    expect(await restarted.findByContent("library", "1.0", "searchable", 5)).toEqual(
      previousSearch,
    );
  });

  it("accepts a known wrapped model padded to a larger explicit database width", async () => {
    settings.app.embeddingModel = "gemini:embedding-001";
    settings.embeddings.vectorDimension = 1536;
    markVectorDimensionSource(settings, true);
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    const values = Array(768).fill(0.01);
    let probes = 0;
    server.use(
      http.post(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/embedding-001:embedContent$/,
        () => {
          probes++;
          return HttpResponse.json({ embedding: { values } });
        },
      ),
      http.post(
        /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/embedding-001:batchEmbedContents$/,
        async ({ request }) => {
          const body = (await request.json()) as { requests: unknown[] };
          return HttpResponse.json({ embeddings: body.requests.map(() => ({ values })) });
        },
      ),
    );
    const store = openStore();
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(probes).toBe(1);
    expect(store.getEmbeddingMetadata()).toEqual({
      model: "gemini:embedding-001",
      dimension: "1536",
    });
    await store.addDocuments("library", "1.0", 0, page());
    expect(snapshot().vectors).toHaveLength(1);
    expect(await store.findByContent("library", "1.0", "searchable", 5)).toHaveLength(1);
  });

  it("reuses the successful unknown-model dimension probe", async () => {
    settings.app.embeddingModel = "openai:unknown-readiness-test-model";
    responseVector = Array(384).fill(0.01);
    const store = openStore();
    await store.initialize();
    expect(requests).toBe(1);
    await store.addDocuments("library", "1.0", 0, page());
    expect(snapshot().vectors).toHaveLength(1);
  });

  it("rolls back a redirected empty replacement when page insertion fails", async () => {
    const store = openStore();
    await store.initialize();
    await store.addDocuments("library", "1.0", 0, page());
    const previous = snapshot();
    const pageId = (previous.pages[0] as { id: number }).id;
    const db = new Database(path.join(directory, "documents.db"));
    db.exec(
      "CREATE TRIGGER reject_page BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT, 'controlled page failure'); END",
    );
    try {
      await expect(
        store.addEmptyPage(
          "library",
          "1.0",
          0,
          {
            url: "https://docs.example.com/redirected.md",
            title: "Empty",
            sourceContentType: "text/markdown",
            contentType: "text/markdown",
            etag: "empty",
            lastModified: null,
          },
          pageId,
        ),
      ).rejects.toThrow();
      expect(snapshot()).toEqual(previous);
      db.exec("DROP TRIGGER reject_page");
      await store.addEmptyPage(
        "library",
        "1.0",
        0,
        {
          url: "https://docs.example.com/redirected.md",
          title: "Empty",
          sourceContentType: "text/markdown",
          contentType: "text/markdown",
          etag: "empty",
          lastModified: null,
        },
        pageId,
      );
      const empty = snapshot();
      expect(empty.pages).toHaveLength(1);
      expect(empty.pages[0]).toMatchObject({
        url: "https://docs.example.com/redirected.md",
        etag: "empty",
      });
      expect(empty.chunks).toEqual([]);
      expect(empty.vectors).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails a child persistence error even when fetch errors are ignored", async () => {
    settings.scraper.maxConcurrency = 1;
    const eventBus = new EventBusService();
    service = new DocumentManagementService(eventBus, settings);
    await service.initialize();
    manager = new PipelineManager(service, eventBus, {
      appConfig: settings,
      recoverJobs: false,
    });
    await manager.start();
    server.use(
      http.get(
        "https://docs.example.com/root.md",
        () =>
          new HttpResponse("# Root\n\n[Child](./child.md)", {
            headers: { "content-type": "text/markdown" },
          }),
      ),
      http.get(
        "https://docs.example.com/child.md",
        () =>
          new HttpResponse("# Child\n\nChild content.", {
            headers: { "content-type": "text/markdown" },
          }),
      ),
    );
    failRequest = requests + 2;
    const id = await manager.enqueueScrapeJob("library", "1.0", {
      url: "https://docs.example.com/root.md",
      library: "library",
      version: "1.0",
      ignoreErrors: true,
      scope: "hostname",
      maxPages: 5,
      maxDepth: 1,
      scrapeMode: ScrapeMode.Fetch,
    });
    await expect(manager.waitForJobCompletion(id)).rejects.toThrow();
    expect((await manager.getJob(id))?.status).toBe(PipelineJobStatus.FAILED);
    expect(snapshot().pages).toHaveLength(1);
    expect(snapshot().pages[0]).toMatchObject({
      url: "https://docs.example.com/root",
      content_url: "https://docs.example.com/root.md",
    });
  });

  it.each(["progress", "completion", "terminal failure"])(
    "fails the job when %s cannot be persisted",
    async (stage) => {
      const eventBus = new EventBusService();
      service = new DocumentManagementService(eventBus, settings);
      await service.initialize();
      manager = new PipelineManager(service, eventBus, {
        appConfig: settings,
        recoverJobs: false,
      });
      await manager.start();
      server.use(
        http.get(
          "https://docs.example.com/page.md",
          () =>
            new HttpResponse("# Page\n\nSearchable text.", {
              headers: { "content-type": "text/markdown" },
            }),
        ),
      );
      const db = new Database(path.join(directory, "documents.db"));
      db.exec(
        stage === "progress"
          ? "CREATE TRIGGER reject_progress BEFORE UPDATE OF progress_pages ON versions BEGIN SELECT RAISE(ABORT, 'controlled progress failure'); END"
          : stage === "completion"
            ? "CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON versions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'controlled completion failure'); END"
            : "CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON versions WHEN NEW.status IN ('completed', 'failed') BEGIN SELECT RAISE(ABORT, 'controlled terminal failure'); END",
      );
      try {
        const id = await manager.enqueueScrapeJob("library", "1.0", {
          url: "https://docs.example.com/page.md",
          library: "library",
          version: "1.0",
          maxDepth: 0,
          scrapeMode: ScrapeMode.Fetch,
        });
        await expect(manager.waitForJobCompletion(id)).rejects.toThrow();
        expect((await manager.getJob(id))?.status).toBe(PipelineJobStatus.FAILED);
        expect(db.prepare("SELECT status FROM versions").get()).toEqual({
          status: stage === "terminal failure" ? "running" : "failed",
        });
      } finally {
        db.close();
      }
    },
  );

  it("settles cancellation without completing or replacing the stored page", async () => {
    const eventBus = new EventBusService();
    service = new DocumentManagementService(eventBus, settings);
    await service.initialize();
    await service.addScrapeResult("library", "1.0", 0, page());
    manager = new PipelineManager(service, eventBus, {
      appConfig: settings,
      recoverJobs: false,
    });
    await manager.start();
    const previous = snapshot();
    let markStarted = () => {};
    let releaseFetch = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    server.use(
      http.get("https://docs.example.com/page.md", async () => {
        markStarted();
        await release;
        return new HttpResponse("# Replacement", {
          headers: { "content-type": "text/markdown" },
        });
      }),
    );
    const id = await manager.enqueueScrapeJob("library", "1.0", {
      url: "https://docs.example.com/page.md",
      library: "library",
      version: "1.0",
      isRefresh: true,
      maxDepth: 0,
      scrapeMode: ScrapeMode.Fetch,
    });
    await started;
    await manager.cancelJob(id);
    releaseFetch();
    // Cancellation settles successfully by the public wait API contract.
    await expect(manager.waitForJobCompletion(id)).resolves.toBeUndefined();
    expect((await manager.getJob(id))?.status).toBe(PipelineJobStatus.CANCELLED);
    expect(snapshot()).toEqual(previous);
  });

  it("preserves a failed refresh and failed retry before replacing the page exactly once", async () => {
    const eventBus = new EventBusService();
    service = new DocumentManagementService(eventBus, settings);
    await service.initialize();
    manager = new PipelineManager(service, eventBus, {
      appConfig: settings,
      recoverJobs: false,
    });
    await manager.start();
    let body = "# Original\n\nPrevious searchable text.";
    let etag = "previous-validator";
    server.use(
      http.get(
        "https://docs.example.com/page.md",
        () =>
          new HttpResponse(body, {
            headers: { "content-type": "text/markdown", etag },
          }),
      ),
    );
    const initialId = await manager.enqueueScrapeJob("library", "1.0", {
      url: "https://docs.example.com/page.md",
      library: "library",
      version: "1.0",
      ignoreErrors: true,
      maxPages: 1,
      maxDepth: 0,
      scrapeMode: ScrapeMode.Fetch,
    });
    await manager.waitForJobCompletion(initialId);
    const previous = snapshot();
    const previousSearch = await service.searchStore("library", "1.0", "searchable");
    body = "# Replacement\n\nUpdated searchable text.";
    etag = "new-validator";
    rejectEmbedding = true;
    const failedId = await manager.enqueueRefreshJob("library", "1.0");
    await expect(manager.waitForJobCompletion(failedId)).rejects.toThrow();
    expect((await manager.getJob(failedId))?.status).toBe(PipelineJobStatus.FAILED);
    expect(snapshot()).toEqual(previous);
    const retryId = await manager.enqueueRefreshJob("library", "1.0");
    await expect(manager.waitForJobCompletion(retryId)).rejects.toThrow();
    expect((await manager.getJob(retryId))?.status).toBe(PipelineJobStatus.FAILED);
    expect(snapshot()).toEqual(previous);
    rejectEmbedding = false;
    expect(await service.searchStore("library", "1.0", "searchable")).toEqual(
      previousSearch,
    );
    const successId = await manager.enqueueRefreshJob("library", "1.0");
    await manager.waitForJobCompletion(successId);
    expect((await manager.getJob(successId))?.status).toBe(PipelineJobStatus.COMPLETED);
    const replacement = snapshot();
    expect(replacement.pages).toHaveLength(1);
    expect(replacement.pages[0]).toMatchObject({ etag: "new-validator" });
    expect(replacement.chunks).toHaveLength(1);
    expect(replacement.chunks[0]).toMatchObject({
      content: expect.stringContaining("Updated searchable"),
    });
    expect(replacement.vectors).toHaveLength(1);
  });
});
