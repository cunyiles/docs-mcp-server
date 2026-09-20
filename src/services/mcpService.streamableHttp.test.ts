import http, { type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server as mockHttp } from "../../test/mock-server";
import { createMcpServerInstance } from "../mcp/mcpServer";
import type { IPipeline } from "../pipeline/trpc/interfaces";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { loadConfig } from "../utils/config";
import { cleanupMcpService, registerMcpService } from "./mcpService";

vi.mock("../mcp/tools", () => ({ initializeTools: vi.fn().mockResolvedValue({}) }));
vi.mock("../mcp/mcpServer", () => ({ createMcpServerInstance: vi.fn() }));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Streamable HTTP request lifetime", () => {
  let app: ReturnType<typeof Fastify>;
  let service: McpServer;
  let client: Client;
  let endpoint: string;
  let release: ReturnType<typeof deferred>;
  let started: ReturnType<typeof deferred>;
  let failTool: boolean;
  let activeResponse: ServerResponse | undefined;
  const instances: McpServer[] = [];

  beforeEach(async () => {
    // Real sockets are required: HTTP interception can buffer streaming responses.
    mockHttp.close();
    release = deferred();
    started = deferred();
    failTool = false;
    vi.spyOn(globalThis, "setInterval");
    vi.spyOn(globalThis, "clearInterval");
    vi.mocked(createMcpServerInstance).mockImplementation(() => {
      const server = new McpServer({ name: "request-lifetime-test", version: "1" });
      server.registerTool("delayed", { description: "Wait for release" }, async () => {
        started.resolve();
        await release.promise;
        if (failTool) throw new Error("controlled tool failure");
        return { content: [{ type: "text", text: "complete result" }] };
      });
      vi.spyOn(server, "close");
      instances.push(server);
      return server;
    });
    app = Fastify();
    app.addHook("onRequest", async (_request: FastifyRequest, reply: FastifyReply) => {
      activeResponse = reply.raw;
    });
    const config = loadConfig();
    config.server.heartbeatMs = 20;
    service = await registerMcpService(
      app,
      {} as IDocumentManagement,
      {} as IPipeline,
      config,
    );
    endpoint = `${await app.listen({ port: 0, host: "127.0.0.1" })}/mcp`;
    client = new Client({ name: "request-lifetime-test", version: "1" });
  });

  afterEach(async () => {
    release.resolve();
    await client.close();
    app.server.closeAllConnections();
    await app.close();
    await cleanupMcpService(service);
    instances.length = 0;
    vi.restoreAllMocks();
  });

  async function expectRequestsClosed() {
    await vi.waitFor(() => {
      for (const instance of instances.slice(1)) {
        expect(instance.close).toHaveBeenCalledTimes(1);
      }
    });
    const intervals = vi.mocked(setInterval).mock.results;
    expect(intervals.length).toBeGreaterThan(0);
    for (const result of intervals)
      expect(clearInterval).toHaveBeenCalledWith(result.value);
  }

  it("keeps a delayed SDK tool result alive through an idle-timeout proxy", async () => {
    let comments = 0;
    let idleClosures = 0;
    const proxy = http.createServer((request, response) => {
      const upstream = http.request(
        endpoint,
        {
          method: request.method,
          headers: request.headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 500, incoming.headers);
          response.flushHeaders();
          incoming.setTimeout(500, () => {
            idleClosures++;
            incoming.destroy(new Error("origin stream idle"));
          });
          incoming.on("data", (chunk: Buffer) => {
            comments += (chunk.toString().match(/: heartbeat/g) ?? []).length;
            if (comments >= 30) release.resolve();
          });
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Missing proxy port");
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/mcp`),
        ),
      );
      const callStartedAt = performance.now();
      const result = await client
        .callTool({ name: "delayed" }, undefined, { timeout: 3000 })
        .catch((error: unknown) => error);
      expect(idleClosures).toBe(0);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "complete result" }],
      });
      expect(comments).toBeGreaterThanOrEqual(30);
      expect(performance.now() - callStartedAt).toBeGreaterThan(500);
      await expectRequestsClosed();
    } finally {
      release.resolve();
      await client.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("cleans up after a client disconnects during a tool call", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const result = client.callTool({ name: "delayed" }).catch((error: unknown) => error);
    await started.promise;
    await client.close();
    expect(await result).toBeInstanceOf(Error);
    await expectRequestsClosed();
  });

  it("cleans up once when the response emits a connection error", async () => {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const result = client.callTool({ name: "delayed" }).catch((error: unknown) => error);
    await started.promise;
    if (!activeResponse) throw new Error("Missing active response");
    activeResponse.emit("error", new Error("controlled connection failure"));
    await expectRequestsClosed();
    await client.close();
    expect(await result).toBeInstanceOf(Error);
  });

  it("delivers tool errors and cleans up their stream", async () => {
    failTool = true;
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const result = client.callTool({ name: "delayed" }).catch((error: unknown) => error);
    await started.promise;
    release.resolve();
    expect(await result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "controlled tool failure" }],
    });
    await expectRequestsClosed();
  });

  it("leaves JSON errors and notification acknowledgments free of SSE comments", async () => {
    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(invalid.status).toBe(406);
    expect(invalid.headers.get("content-type")).toContain("application/json");
    expect(await invalid.json()).toMatchObject({ error: { code: -32000 } });
    const notification = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    await expectRequestsClosed();
  });
});
