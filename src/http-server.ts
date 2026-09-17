import http from "node:http";
import {
  createMcpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { LocalToolBackend } from "./backend/types.js";
import type { FullTrace } from "./full-trace.js";
import type { RequestLedger } from "./request-ledger.js";
import { createMcpProtocolServer } from "./server.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

export type HttpMcpServerOptions = {
  backend: LocalToolBackend;
  ledger?: RequestLedger;
  trace?: FullTrace;
};

export type HttpMcpServer = {
  server: http.Server;
  close(): Promise<void>;
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

export function createHttpMcpServer(options: HttpMcpServerOptions): HttpMcpServer {
  const { backend, ledger, trace } = options;
  const reportHandlerError = (phase: string, error: unknown) => {
    ledger?.record({ phase, ok: false, errorKind: errorKind(error) });
    trace?.record({ phase, ok: false, error });
  };

  const handler = createMcpHandler(
    (context: McpRequestContext) => {
      ledger?.record({
        phase: "mcp_http_protocol_instance",
        ok: true,
        metadata: { era: context.era },
      });
      trace?.record({
        phase: "mcp_http_protocol_instance",
        ok: true,
        metadata: { era: context.era },
      });
      return createMcpProtocolServer(backend, ledger, trace);
    },
    {
      // Modern clients use the 2026-07-28 per-request/sessionless protocol.
      // Older 2025-era peers, including a tunnel-client that has not negotiated
      // the modern envelope yet, remain supported through the SDK's stateless
      // compatibility leg. Neither path creates protocol sessions.
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => reportHandlerError("mcp_http_handler_error", error),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => reportHandlerError("mcp_http_adapter_error", error),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let closing = false;

  const nodeServer = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz" || pathname === "/readyz") {
      res.writeHead(closing ? 503 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: !closing,
          mode: "sessionless",
          modernProtocol: MODERN_PROTOCOL_VERSION,
          legacyCompatibility: "stateless",
          sessions: 0,
        }),
      );
      return;
    }
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
  });

  return {
    server: nodeServer,
    close: async () => {
      if (closing) return;
      closing = true;
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        nodeServer.close((error) => (error ? reject(error) : resolve()));
        nodeServer.closeIdleConnections();
      });
    },
  };
}
