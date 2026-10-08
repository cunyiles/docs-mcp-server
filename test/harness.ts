/**
 * Drives Grounded the way a harness does: through the MCP tools, against fake
 * documentation sites and a fake embedding provider.
 *
 * Scenarios assert only on tool results, so they survive changes to how
 * collection works inside.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { EventBusService } from "../src/events";
import { createMcpServerInstance } from "../src/mcp/mcpServer";
import { initializeTools } from "../src/mcp/tools";
import { PipelineManager } from "../src/pipeline/PipelineManager";
import { PipelineJobStatus } from "../src/pipeline/types";
import { DocumentManagementService } from "../src/store/DocumentManagementService";
import { type AppConfig, loadConfig } from "../src/utils/config";
import { server } from "./mock-server";

/** One page of a fake site. */
export interface FakePage {
  body: string;
  type?: string;
  status?: number;
  headers?: Record<string, string>;
}

/** A page, or a function computing the response from the request. */
export type FakeRoute = FakePage | ((request: Request) => FakePage | Promise<FakePage>);

/** A fake documentation site; `requests` counts hits per path (with query). */
export interface FakeSite {
  origin: string;
  requests: Map<string, number>;
  /** Every request as seen by the site, in order. */
  log: Array<{ path: string; headers: Headers }>;
  routes: Record<string, FakeRoute>;
  hits(path: string): number;
}

/**
 * Serves a fake site at `origin`. Paths not in `routes` answer 404.
 * Routes can be changed afterwards through `site.routes`.
 */
export function fakeSite(origin: string, routes: Record<string, FakeRoute>): FakeSite {
  const site: FakeSite = {
    origin,
    requests: new Map(),
    log: [],
    routes,
    hits: (p) => site.requests.get(p) ?? 0,
  };
  server.use(
    http.all(`${origin}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const key = `${url.pathname}${url.search}`;
      site.requests.set(key, (site.requests.get(key) ?? 0) + 1);
      site.log.push({ path: key, headers: request.headers });
      const route = site.routes[key] ?? site.routes[url.pathname];
      if (!route) return new HttpResponse("Not found", { status: 404 });
      const page = typeof route === "function" ? await route(request) : route;
      return new HttpResponse(request.method === "HEAD" ? null : page.body, {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...page.headers },
      });
    }),
  );
  return site;
}

/** Simple HTML page with a title, body text and links. */
export function html(title: string, text: string, links: string[] = []): FakePage {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("\n");
  return {
    body: `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p>${anchors}</main></body></html>`,
  };
}

/** Words that mean the same thing to the fake embedding model. */
const CONCEPTS: Record<string, string> = {
  automobile: "car",
  vehicle: "car",
  car: "car",
  cars: "car",
  sedan: "car",
  canine: "dog",
  puppy: "dog",
  dog: "dog",
  dogs: "dog",
  hound: "dog",
};

/**
 * Deterministic toy embedding: synonyms share a dimension, so a query with no
 * keyword in common with a page can still be closest to it.
 */
export function fakeEmbedding(text: string, dimension = 1536): number[] {
  const vector = new Array(dimension).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPTS[word];
    if (!concept) continue;
    let hash = 0;
    for (const ch of concept) hash = (hash * 31 + ch.charCodeAt(0)) % dimension;
    vector[hash] += 1;
  }
  vector[dimension - 1] += 0.01; // never a zero vector
  const norm = Math.hypot(...vector);
  return vector.map((v) => v / norm);
}

/** Fake OpenAI-compatible embedding provider; `mode` can change at any time. */
export interface FakeProvider {
  mode: "ok" | "429";
  requests: number;
  inputs: number;
}

const PROVIDER_BASE = "https://embeddings.fake.test/v1";

/** Installs a fake embedding provider and points the OpenAI client at it. */
export function fakeProvider(mode: FakeProvider["mode"] = "ok"): FakeProvider {
  const provider: FakeProvider = { mode, requests: 0, inputs: 0 };
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_API_BASE", PROVIDER_BASE);
  server.use(
    http.post(`${PROVIDER_BASE}/embeddings`, async ({ request }) => {
      provider.requests++;
      if (provider.mode === "429") {
        return HttpResponse.json(
          { error: { message: "Rate limit reached", type: "rate_limit" } },
          { status: 429 },
        );
      }
      const body = (await request.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      provider.inputs += inputs.length;
      return HttpResponse.json({
        object: "list",
        model: "text-embedding-3-small",
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: fakeEmbedding(input),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }),
  );
  return provider;
}

/** A running Grounded instance and an MCP client connected to it. */
export interface Grounded {
  config: AppConfig;
  storeDir: string;
  /** Calls a tool; returns its text. Tool errors come back as text too, with `isError`. */
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  callRaw(
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
  /** `scrape_docs`, then waits until every job has finished. */
  scrape(args: Record<string, unknown>): Promise<string>;
  /** `refresh_version`, then waits until every job has finished. */
  refresh(args: Record<string, unknown>): Promise<string>;
  waitForJobs(): Promise<void>;
  /** The MCP server's initialize instructions. */
  instructions(): string | undefined;
  /** The tools the server offers, as a harness lists them. */
  listTools(): ReturnType<Client["listTools"]>;
  stop(): Promise<void>;
  /** Stops and starts again on the same store, as a container restart would. */
  restart(configure?: (config: AppConfig) => void): Promise<Grounded>;
}

/** Test defaults: FTS only, fake hosts allowed, fast retries. */
function testConfig(storeDir: string): AppConfig {
  const config = loadConfig();
  config.app.storePath = storeDir;
  config.app.embeddingModel = "";
  config.app.telemetryEnabled = false;
  config.scraper.security.network.allowPrivateNetworks = true;
  config.scraper.fetcher.maxRetries = 0;
  config.scraper.fetcher.baseDelayMs = 10;
  config.embeddings.retryBaseDelayMs = 50;
  return config;
}

/**
 * Starts Grounded in process with an MCP client over an in-memory transport.
 * @param configure Adjusts the configuration before start.
 * @param storeDir Existing store to open; a fresh temporary one by default.
 */
export async function startGrounded(
  configure?: (config: AppConfig) => void,
  storeDir = mkdtempSync(path.join(tmpdir(), "grounded-e2e-")),
): Promise<Grounded> {
  const config = testConfig(storeDir);
  configure?.(config);
  const eventBus = new EventBusService();
  const docService = new DocumentManagementService(eventBus, config);
  await docService.initialize();
  const pipeline = new PipelineManager(docService, eventBus, {
    recoverJobs: true,
    appConfig: config,
  });
  await pipeline.start();
  const tools = await initializeTools(docService, pipeline, config);
  const mcpServer = createMcpServerInstance(tools, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  await client.connect(clientTransport);

  const waitForJobs = async () => {
    for (;;) {
      const jobs = await pipeline.getJobs();
      const open = jobs.filter((job) =>
        [PipelineJobStatus.QUEUED, PipelineJobStatus.RUNNING].includes(job.status),
      );
      if (open.length === 0) return;
      await Promise.allSettled(open.map((job) => pipeline.waitForJobCompletion(job.id)));
    }
  };

  const callRaw = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return {
      text: content.map((part) => part.text ?? "").join("\n"),
      isError: result.isError === true,
    };
  };

  const stop = async () => {
    await client.close();
    await mcpServer.close();
    await pipeline.stop();
    await docService.shutdown();
  };

  const grounded: Grounded = {
    config,
    storeDir,
    callRaw,
    call: async (tool, args) => (await callRaw(tool, args)).text,
    scrape: async (args) => {
      const text = (await callRaw("scrape_docs", args)).text;
      await waitForJobs();
      return text;
    },
    refresh: async (args) => {
      const text = (await callRaw("refresh_version", args)).text;
      await waitForJobs();
      return text;
    },
    waitForJobs,
    instructions: () => client.getInstructions(),
    listTools: () => client.listTools(),
    stop,
    restart: async (reconfigure) => {
      await stop();
      return startGrounded((next) => {
        configure?.(next);
        reconfigure?.(next);
      }, storeDir);
    },
  };
  return grounded;
}

/** Removes a store created by {@link startGrounded}. */
export function removeStore(storeDir: string): void {
  rmSync(storeDir, { recursive: true, force: true });
}

/** Retries `check` until it returns true or the timeout passes. */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
