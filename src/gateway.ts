import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

export type GatewayRequestOptions = {
  gatewayUrl: string;
  requestTimeoutMs: number;
  clientDisplayName: string;
  scopes: Array<"operator.read" | "operator.write">;
  method: string;
  params: unknown;
  signal?: AbortSignal;
};

export async function requestOpenClawGateway<T>(options: GatewayRequestOptions): Promise<T> {
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const settleReady = (error?: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    if (error) {
      readyReject?.(error);
    } else {
      readyResolve?.();
    }
  };
  const client = new GatewayClient({
    url: options.gatewayUrl,
    clientName: "gateway-client",
    clientDisplayName: options.clientDisplayName,
    mode: "backend",
    role: "operator",
    scopes: options.scopes,
    requestTimeoutMs: options.requestTimeoutMs,
    onHelloOk: () => settleReady(),
    onConnectError: (error) => settleReady(error),
    onReconnectPaused: (info) =>
      settleReady(new Error(`gateway reconnect paused: ${info.detailCode ?? info.reason}`)),
    onClose: (_code, reason, info) => {
      if (info?.phase === "pre-hello") {
        settleReady(new Error(`gateway closed before authentication: ${reason || "no reason"}`));
      }
    },
  });
  const timeout = setTimeout(
    () => settleReady(new Error(`gateway connection timed out after ${options.requestTimeoutMs}ms`)),
    options.requestTimeoutMs,
  );
  timeout.unref?.();
  const abort = () =>
    settleReady(Object.assign(new Error("gateway request aborted"), { name: "AbortError" }));
  options.signal?.addEventListener("abort", abort, { once: true });
  client.start();
  try {
    await ready;
    return await client.request<T>(options.method, options.params, {
      signal: options.signal,
      timeoutMs: options.requestTimeoutMs,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}
