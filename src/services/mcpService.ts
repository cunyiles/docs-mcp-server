/**
 * MCP service that registers MCP protocol routes for AI tool integration.
 * Provides modular server composition for MCP endpoints.
 */

import type { OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProxyAuthManager } from "../auth";
import { createAuthMiddleware } from "../auth/middleware";
import { createMcpServerInstance } from "../mcp/mcpServer";
import { initializeTools } from "../mcp/tools";
import type { IPipeline } from "../pipeline/trpc/interfaces";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { telemetry } from "../telemetry";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";

/**
 * Register MCP protocol routes on a Fastify server instance.
 * This includes SSE endpoints for persistent connections and HTTP endpoints for stateless requests.
 *
 * @param server The Fastify server instance
 * @param docService The document management service
 * @param pipeline The pipeline instance
 * @param config The resolved configuration from the entrypoint
 * @param authManager Optional authentication manager
 * @returns The McpServer instance for cleanup
 */
export async function registerMcpService(
  server: FastifyInstance,
  docService: IDocumentManagement,
  pipeline: IPipeline,
  config: AppConfig,
  authManager?: ProxyAuthManager,
): Promise<McpServer> {
  // Initialize MCP server and tools
  const mcpTools = await initializeTools(docService, pipeline, config);
  const mcpServer = createMcpServerInstance(mcpTools, config);

  // Setup auth middleware if auth manager is provided
  const authMiddleware = authManager ? createAuthMiddleware(authManager) : null;

  // Track SSE transports for cleanup
  const sseTransports: Record<string, SSEServerTransport> = {};

  // Track SSE server instances for cleanup
  const sseServers: Record<string, McpServer> = {};

  // Track heartbeat intervals for cleanup
  const heartbeatIntervals: Record<string, NodeJS.Timeout> = {};

  // SSE endpoint for MCP connections
  server.route({
    method: "GET",
    url: "/sse",
    preHandler: authMiddleware ? [authMiddleware] : undefined,
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Handle SSE connection using raw response
        const transport = new SSEServerTransport("/messages", reply.raw);
        sseTransports[transport.sessionId] = transport;

        const sessionServer = createMcpServerInstance(mcpTools, config);
        sseServers[transport.sessionId] = sessionServer;

        // Log client connection (simple connection tracking without sessions)
        if (telemetry.isEnabled()) {
          logger.info(`🔗 MCP client connected: ${transport.sessionId}`);
        }

        // Start heartbeat to keep connection alive and prevent client timeouts
        // SSE comments (lines starting with ':') are ignored by clients but keep the connection active
        const heartbeatInterval = setInterval(() => {
          try {
            reply.raw.write(": heartbeat\n\n");
          } catch {
            // Connection likely closed, cleanup will happen in close handler
            clearInterval(heartbeatInterval);
            delete heartbeatIntervals[transport.sessionId];
          }
        }, config.server.heartbeatMs);
        heartbeatIntervals[transport.sessionId] = heartbeatInterval;

        // Cleanup function to handle both close and error scenarios
        const cleanupConnection = () => {
          const interval = heartbeatIntervals[transport.sessionId];
          if (interval) {
            clearInterval(interval);
            delete heartbeatIntervals[transport.sessionId];
          }

          const serverToClose = sseServers[transport.sessionId];
          if (serverToClose) {
            delete sseServers[transport.sessionId];
            void serverToClose.close().catch((error) => {
              logger.error(`❌ Failed to close SSE server instance: ${error}`);
            });
          }

          delete sseTransports[transport.sessionId];
          transport.close();

          // Log client disconnection
          if (telemetry.isEnabled()) {
            logger.info(`🔗 MCP client disconnected: ${transport.sessionId}`);
          }
        };

        reply.raw.on("close", cleanupConnection);

        // Handle stream errors (e.g., client disconnects abruptly)
        reply.raw.on("error", (error) => {
          logger.debug(`SSE connection error: ${error}`);
          cleanupConnection();
        });

        await sessionServer.connect(transport);
      } catch (error) {
        logger.error(`❌ Error in SSE endpoint: ${error}`);
        reply.code(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // SSE message handling endpoint
  server.route({
    method: "POST",
    url: "/messages",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? sseTransports[sessionId] : undefined;

        if (transport) {
          await transport.handlePostMessage(request.raw, reply.raw, request.body);
        } else {
          reply.code(400).send({ error: "No transport found for sessionId" });
        }
      } catch (error) {
        logger.error(`❌ Error in messages endpoint: ${error}`);
        reply.code(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // Streamable HTTP endpoint for stateless MCP requests
  server.route({
    method: "POST",
    url: "/mcp",
    preHandler: authMiddleware ? [authMiddleware] : undefined,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // In stateless mode, create a new instance of server and transport for each request
        const requestServer = createMcpServerInstance(mcpTools, config);
        const requestTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        let isEventStream = false;
        const writeHead = reply.raw.writeHead.bind(reply.raw);
        reply.raw.writeHead = function (
          statusCode: number,
          statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
          headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
        ) {
          const responseHeaders =
            typeof statusMessageOrHeaders === "string" ? headers : statusMessageOrHeaders;
          // Node does not expose headers passed directly to writeHead via getHeader.
          let contentType = this.getHeader("content-type");
          if (Array.isArray(responseHeaders)) {
            for (let index = 0; index < responseHeaders.length; index += 2) {
              if (String(responseHeaders[index]).toLowerCase() === "content-type") {
                contentType = responseHeaders[index + 1];
              }
            }
          } else if (responseHeaders) {
            for (const [name, value] of Object.entries(responseHeaders)) {
              if (name.toLowerCase() === "content-type") contentType = value;
            }
          }
          isEventStream = String(contentType).startsWith("text/event-stream");
          return typeof statusMessageOrHeaders === "string"
            ? writeHead(statusCode, statusMessageOrHeaders, headers)
            : writeHead(statusCode, statusMessageOrHeaders);
        };

        let cleanedUp = false;
        const cleanupRequest = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          clearInterval(heartbeatInterval);
          logger.debug("Streamable HTTP request closed");
          void Promise.all([requestTransport.close(), requestServer.close()]).catch(
            (error) => logger.debug(`Streamable HTTP cleanup error: ${error}`),
          );
        };
        const heartbeatInterval = setInterval(() => {
          // The SDK chooses SSE, JSON, or an empty acknowledgment after validation.
          // Only keep an established SSE response alive; never commit its headers here.
          if (
            !reply.raw.headersSent ||
            reply.raw.writableEnded ||
            reply.raw.destroyed ||
            !isEventStream
          )
            return;
          try {
            reply.raw.write(": heartbeat\n\n");
          } catch {
            cleanupRequest();
            reply.raw.destroy();
          }
        }, config.server.heartbeatMs);
        heartbeatInterval.unref();

        reply.raw.on("finish", cleanupRequest);
        reply.raw.on("close", cleanupRequest);
        reply.raw.on("error", (error) => {
          logger.debug(`Streamable HTTP connection error: ${error}`);
          cleanupRequest();
        });

        await requestServer.connect(requestTransport);
        await requestTransport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        logger.error(`❌ Error in MCP endpoint: ${error}`);
        reply.code(500).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  server.route({
    method: "GET",
    url: "/mcp",
    preHandler: authMiddleware ? [authMiddleware] : undefined,
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.code(405).header("Allow", "POST").send();
    },
  });

  // Store reference to SSE transports on the server instance for cleanup
  (
    mcpServer as unknown as {
      _sseTransports: Record<string, SSEServerTransport>;
      _sseServers: Record<string, McpServer>;
      _heartbeatIntervals: Record<string, NodeJS.Timeout>;
    }
  )._sseTransports = sseTransports;
  (
    mcpServer as unknown as {
      _sseServers: Record<string, McpServer>;
    }
  )._sseServers = sseServers;
  (
    mcpServer as unknown as {
      _heartbeatIntervals: Record<string, NodeJS.Timeout>;
    }
  )._heartbeatIntervals = heartbeatIntervals;

  return mcpServer;
}

/**
 * Clean up MCP service resources including SSE transports.
 */
export async function cleanupMcpService(mcpServer: McpServer): Promise<void> {
  try {
    // Clear all heartbeat intervals
    const heartbeatIntervals = (
      mcpServer as unknown as {
        _heartbeatIntervals: Record<string, NodeJS.Timeout>;
      }
    )._heartbeatIntervals;
    if (heartbeatIntervals) {
      for (const interval of Object.values(heartbeatIntervals)) {
        clearInterval(interval);
      }
    }

    // Close all SSE transports
    const sseTransports = (
      mcpServer as unknown as {
        _sseTransports: Record<string, SSEServerTransport>;
      }
    )._sseTransports;
    if (sseTransports) {
      for (const transport of Object.values(sseTransports)) {
        await transport.close();
      }
    }

    const sseServers = (
      mcpServer as unknown as {
        _sseServers: Record<string, McpServer>;
      }
    )._sseServers;
    if (sseServers) {
      for (const server of Object.values(sseServers)) {
        await server.close();
      }
    }

    // Close MCP server
    await mcpServer.close();
    logger.debug("MCP service cleaned up");
  } catch (error) {
    logger.error(`❌ Failed to cleanup MCP service: ${error}`);
    throw error;
  }
}
