# Agent Access Tunnel

Vendor-neutral authenticated ingress for trusted private Agent services.

The first deployment exposes a dedicated WebAgentTools MCP frontend to MiniMax Code without changing or replacing OpenAI's Secure MCP Tunnel.

Architecture:

    MiniMax Code
      -> Agent Plugin stdio bridge
      -> HTTPS + short-lived access token
      -> Agent Access Gateway (Tencent Cloud 2)
      -> SSH reverse tunnel
      -> 127.0.0.1:18791
      -> WebAgentTools MCP frontend
      -> existing persistent exec runtime

Authentication is separate from transport. The MVP uses a device-style pairing grant:

- one manual pairing creates a revocable logical client grant;
- the plugin stores only its refresh credential under PLUGIN_DATA;
- normal MCP calls exchange it silently for short-lived access tokens;
- containers/runtimes can change without changing the server-side integration grant;
- future OAuth/OIDC providers can replace the pairing bootstrap without changing the tunnel or MCP.

The Agent never receives pairing, refresh, or access credentials as MCP tools or prompt context.

Components:

- gateway/agent_access_gateway.py - auth gateway and MCP reverse proxy, Python stdlib only.
- gateway/admin.py - local operator CLI for pairing approval and revocation.
- plugin/webagenttools-home/ - Agent Plugins V1 package recognized by MiniMax Code.
- ops/home/ - dedicated MCP frontend and outbound SSH reverse-tunnel units.
- ops/cloud/ - gateway service and Caddy route example.

Security properties:

- Home MCP remains loopback-only.
- Public Authorization, Cookie, Origin, Forwarded and Host headers are never forwarded to the home MCP.
- Refresh credentials are stored server-side only as SHA-256 hashes.
- Access tokens are HMAC-authenticated, short-lived, and checked against live client revocation state.
- Pairing device codes are stored only as hashes.
- Pairing is out-of-band and never appears in the model-visible MCP tool catalog.
- OpenAI Tunnel remains unchanged and continues using its existing 127.0.0.1:18790 frontend.

## Current deployment

The first live deployment uses:

- MiniMax WebAgentTools frontend: 127.0.0.1:18791 on the home WSL host.
- Public ingress: https://sites.axelhu.com/agent-access.
- Cloud gateway: 127.0.0.1:3250 on Tencent Cloud 2, behind the existing Caddy TLS endpoint.
- Home-to-cloud transport: an outbound OpenSSH reverse tunnel. The public gateway never connects
  inbound to the home network.
- Windows MiniMax Code plugin:
  C:\\Users\\admin\\.minimax\\plugins\\webagenttools-home.
- Persistent plugin credential data:
  C:\\Users\\admin\\.minimax\\v2\\plugin-data\\agent-plugins\\webagenttools-home.

OpenAI continues to use its existing official tunnel and 127.0.0.1:18790.

The Plugin uses platform-specific launch profiles because MiniMax's Windows
Desktop runtime and Linux/cloud runtime do not expose the same interpreter
names:

- Linux/cloud: the package-default mcp.json starts bridge-launcher.mjs with
  node; the launcher starts python3.
- Windows Desktop: install_plugin.py selects mcp.windows.json, which starts
  bridge.py with python. MiniMax Desktop's PATH contains Python, but does not
  necessarily contain a separately installed Node.js.

Install the appropriate package variant with:

    python3 plugin/install_plugin.py --data-dir ~/.minimax --platform posix

or, when installing into a mounted Windows MiniMax data directory:

    python3 plugin/install_plugin.py --data-dir /mnt/c/Users/admin/.minimax --platform windows

## Agent-visible behavior

Pairing is deliberately outside the MCP tool surface. After pairing, the Agent sees the ordinary
WebAgentTools MCP catalog (read, exec, process, apply_patch, Drive and Skills tools, etc.). It does
not see pairing, refresh-token, or access-token tools.

For every normal MCP process start the plugin:

1. reads the persistent refresh credential from PLUGIN_DATA;
2. obtains and caches a short-lived access token;
3. refreshes it automatically before expiry;
4. retries one MCP request after a 401 by refreshing the access token;
5. keeps the long-lived pairing credential unchanged across ordinary network/tunnel outages.

Therefore a normal connection loss does **not** require pairing again. Re-pairing is required only
after the server-side client grant is revoked, the persistent credential is deliberately removed,
or a runtime does not restore/inject its persistent Plugin data.

The Windows bridge forces UTF-8 MCP stdio independent of the Windows console code page.

## Pairing

Start pairing from the installed Plugin outside an Agent turn. On Linux/cloud
the launcher is the normal entrypoint:

    node bridge-launcher.mjs --pair

On Windows Desktop the selected package invokes the Python bridge directly:

    python bridge.py --pair

The bridge prints a short one-time user code. Approve it on the trusted gateway host:

    python3 admin.py approve XXXX-XXXX

The bridge then stores its refresh credential under PLUGIN_DATA. Future Agent sessions require no
pairing UI as long as that persistent data remains available and the grant is not revoked.

admin.py clients lists logical clients without exposing credentials. Revoke one with:

    python3 admin.py revoke <client-id>

## Failure behavior

- Public MCP calls without a valid access token return 401.
- Revocation is checked against live client state, so an already-issued access token stops working
  after the client is revoked.
- The gateway closes backend HTTP/1.1 connections after error responses. This prevents an
  unauthenticated request body from contaminating a reverse proxy's next keep-alive request.
- A temporarily unavailable home tunnel returns a retryable 503. It does not delete pairing state.
- The current MiniMax frontend is intentionally tools-only and does not expose the experimental
  WebAgentTools Events extension. The gateway currently buffers ordinary MCP responses rather than
  acting as a general long-lived event-stream relay.

## Verification

The live deployment has been verified end-to-end with the MCP 2026-07-28 protocol:

    MiniMax-compatible stdio client
      -> Windows Python bridge
      -> public HTTPS
      -> authenticated gateway
      -> SSH reverse tunnel
      -> 127.0.0.1:18791
      -> WebAgentTools

The test enumerated 14 WebAgentTools tools and successfully called read. MiniMax Code Desktop's own
runtime subsequently discovered the same local Plugin and recorded all 14 tools in its MCP runtime
catalog.

The final acceptance also used the real MiniMax Code Agent rather than only an
MCP SDK. A long-lived mcode 0.6.5 TUI was allowed to finish Plugin discovery
before the prompt was submitted. MiniMax M3.1 Flash then selected
webagenttools_home.read itself and read a one-line probe through the production
HTTPS gateway, reverse tunnel, and home 18791 frontend. The home request ledger
recorded the matching read call as successful.

One-shot mcode exec processes expose a startup race in 0.6.5: a turn may be
assembled before asynchronous Plugin MCP discovery finishes. That does not
occur in a long-lived Desktop/TUI runtime after discovery has completed. Do not
treat an immediate first-turn PLUGIN_FAILED from a fresh exec process as an
authentication failure; verify Plugin connection or keep the runtime alive
until discovery completes.
