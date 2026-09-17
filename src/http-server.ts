import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolBackend } from "./backend/types.js";
import type { FullTrace } from "./full-trace.js";
import type { RequestLedger } from "./request-ledger.js";
import { createMcpProtocolServer } from "./server.js";

export type HttpMcpServerOptions = {
  backend: LocalToolBackend;
  ledger?: RequestLedger;
  trace?: FullTrace;
  sessionIdleTtlMs?: number;
  sessionSweepIntervalMs?: number;
  maxSessions?: number;
  sessionMode?: "stateful" | "stateless";
};

type SessionEntry = {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpProtocolServer>;
  lastSeenAt: number;
  activeRequests: number;
  closing: boolean;
};

export type HttpMcpServer = {
  server: http.Server;
  sessionCount(): number;
  close(): Promise<void>;
};

const DEFAULT_SESSION_IDLE_TTL_MS = 20 * 60_000;
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 16;
const MAX_INITIALIZE_BODY_BYTES = 1_048_576;

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function writeMcpError(res: ServerResponse, statusCode: number, message: string): void {
  writeJson(res, statusCode, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_INITIALIZE_BODY_BYTES) {
      throw new Error("initialize request body too large");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("empty request body");
  return JSON.parse(text);
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (Array.isArray(value)) return value[0];
  return value?.trim() || undefined;
}

export function createHttpMcpServer(options: HttpMcpServerOptions): HttpMcpServer {
  const idleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = options.sessionSweepIntervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionMode = options.sessionMode ?? "stateful";
  const sessions = new Map<string, SessionEntry>();
  const statelessConnections = new Set<{
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createMcpProtocolServer>;
  }>();
  let closing = false;

  const closeEntry = async (entry: SessionEntry, reason: string) => {
    if (entry.closing) return;
    entry.closing = true;
    sessions.delete(entry.id);
    options.ledger?.record({
      phase: "mcp_http_session_closed",
      metadata: { sessionId: entry.id, reason, activeRequests: entry.activeRequests },
    });
    await Promise.allSettled([entry.transport.close(), entry.server.close()]);
  };

  const prune = async () => {
    const now = Date.now();
    const idle = [...sessions.values()]
      .filter((entry) => entry.activeRequests === 0 && now - entry.lastSeenAt >= idleTtlMs)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const entry of idle) await closeEntry(entry, "idle_ttl");

  };

  const makeCapacity = async () => {
    const inactive = [...sessions.values()]
      .filter((entry) => entry.activeRequests === 0)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (sessions.size >= maxSessions && inactive.length > 0) {
      const entry = inactive.shift();
      if (entry) await closeEntry(entry, "session_cap_lru");
    }
  };

  const sweepTimer = setInterval(() => void prune(), sweepIntervalMs);
  sweepTimer.unref();

  const handleExisting = async (
    entry: SessionEntry,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ) => {
    const leasesSession = req.method !== "GET";
    if (leasesSession) {
      entry.lastSeenAt = Date.now();
      entry.activeRequests += 1;
    }
    try {
      await entry.transport.handleRequest(req, res, parsedBody);
    } finally {
      if (leasesSession) {
        entry.activeRequests -= 1;
        entry.lastSeenAt = Date.now();
      }
    }
  };

  const nodeServer = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname === "/healthz") {
        writeJson(res, 200, { ok: true, mode: sessionMode, sessions: sessions.size });
        return;
      }
      if (requestUrl.pathname === "/readyz") {
        writeJson(res, closing ? 503 : 200, { ok: !closing, mode: sessionMode, sessions: sessions.size });
        return;
      }
      if (requestUrl.pathname !== "/mcp") {
        writeJson(res, 404, { error: "not found" });
        return;
      }
      if (closing) {
        writeMcpError(res, 503, "MCP server is shutting down");
        return;
      }

      if (sessionMode === "stateless") {
        if (req.method !== "POST") {
          writeMcpError(res, 405, "Stateless MCP accepts POST requests only");
          return;
        }
        const protocolServer = createMcpProtocolServer(options.backend, options.ledger, options.trace);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const connection = { transport, server: protocolServer };
        statelessConnections.add(connection);
        let cleaned = false;
        const cleanup = async () => {
          if (cleaned) return;
          cleaned = true;
          statelessConnections.delete(connection);
          await Promise.allSettled([transport.close(), protocolServer.close()]);
        };
        res.once("close", () => void cleanup());
        try {
          await protocolServer.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          await cleanup();
          throw error;
        }
        return;
      }

      const sessionId = sessionIdFrom(req);
      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          writeMcpError(res, 404, "Unknown or expired MCP session");
          return;
        }
        await handleExisting(entry, req, res);
        return;
      }

      if (req.method !== "POST") {
        writeMcpError(res, 400, "Mcp-Session-Id is required after initialization");
        return;
      }

      const body = await parseJsonBody(req);
      if (!isInitializeRequest(body)) {
        writeMcpError(res, 400, "Expected MCP initialize request without a session id");
        return;
      }

      if (sessions.size >= maxSessions) {
        await prune();
        await makeCapacity();
      }
      if (sessions.size >= maxSessions) {
        writeMcpError(res, 503, "Too many active MCP sessions");
        return;
      }

      let entry: SessionEntry | undefined;
      const protocolServer = createMcpProtocolServer(options.backend, options.ledger, options.trace);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (!entry) return;
          entry.id = id;
          sessions.set(id, entry);
          options.ledger?.record({
            phase: "mcp_http_session_initialized",
            metadata: { sessionId: id },
          });
        },
        onsessionclosed: async (id) => {
          const current = sessions.get(id);
          if (current) await closeEntry(current, "client_delete");
        },
      });
      entry = {
        id: "pending",
        transport,
        server: protocolServer,
        lastSeenAt: Date.now(),
        activeRequests: 0,
        closing: false,
      };
      transport.onclose = () => {
        if (!entry || entry.id === "pending") return;
        const current = sessions.get(entry.id);
        if (current === entry) sessions.delete(entry.id);
      };
      transport.onerror = (error) => {
        options.ledger?.record({
          phase: "mcp_http_transport_error",
          ok: false,
          errorKind: error instanceof Error ? error.name : typeof error,
          metadata: { sessionId: entry?.id ?? "pending" },
        });
      };

      try {
        await protocolServer.connect(transport);
        entry.activeRequests += 1;
        await transport.handleRequest(req, res, body);
        entry.activeRequests -= 1;
        entry.lastSeenAt = Date.now();
        if (entry.id === "pending") {
          await Promise.allSettled([transport.close(), protocolServer.close()]);
        }
      } catch (error) {
        if (entry.activeRequests > 0) entry.activeRequests -= 1;
        if (entry.id !== "pending") sessions.delete(entry.id);
        await Promise.allSettled([transport.close(), protocolServer.close()]);
        throw error;
      }
    } catch (error) {
      options.ledger?.record({
        phase: "mcp_http_request_failed",
        ok: false,
        errorKind: error instanceof Error ? error.name : typeof error,
      });
      writeMcpError(res, 500, "Internal MCP HTTP error");
    }
  });

  return {
    server: nodeServer,
    sessionCount: () => sessions.size,
    close: async () => {
      if (closing) return;
      closing = true;
      clearInterval(sweepTimer);
      await Promise.allSettled([
        ...[...sessions.values()].map((entry) => closeEntry(entry, "server_shutdown")),
        ...[...statelessConnections].map(async (connection) => {
          statelessConnections.delete(connection);
          await Promise.allSettled([connection.transport.close(), connection.server.close()]);
        }),
      ]);
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
    },
  };
}
