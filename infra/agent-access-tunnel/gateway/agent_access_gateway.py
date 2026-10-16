#!/usr/bin/env python3
"""Authenticated public ingress for a loopback MCP service.

Python 3.8+ stdlib only. TLS termination is expected to be provided by Caddy.
"""

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS pairings (
  device_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  profile TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  refresh_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pairings_user_code ON pairings(user_code);
CREATE INDEX IF NOT EXISTS idx_clients_refresh_hash ON clients(refresh_hash);
"""

PROFILE_RE = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
CLIENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,79}$")
USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ALLOWED_SCOPES = frozenset({"mcp"})


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compact_json(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def now_s():
    return int(time.time())


class GatewayState:
    def __init__(self, db_path, master_key_path, public_base, pair_ttl=600, access_ttl=900, allowed_profiles=None):
        self.db_path = db_path
        self.master_key_path = master_key_path
        self.public_base = public_base.rstrip("/")
        self.pair_ttl = pair_ttl
        self.access_ttl = access_ttl
        self.allowed_profiles = frozenset(allowed_profiles or {"minimax"})
        self._master_key = self._load_or_create_master_key()
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self):
        os.makedirs(os.path.dirname(self.db_path), mode=0o700, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _load_or_create_master_key(self):
        parent = os.path.dirname(self.master_key_path)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        try:
            with open(self.master_key_path, "rb") as f:
                key = f.read()
            if len(key) != 32:
                raise RuntimeError("master key must be exactly 32 bytes")
            return key
        except FileNotFoundError:
            key = secrets.token_bytes(32)
            fd = os.open(self.master_key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, key)
            finally:
                os.close(fd)
            return key

    def _hmac(self, label):
        return hmac.new(self._master_key, label.encode("utf-8"), hashlib.sha256).digest()

    def _new_user_code(self):
        chars = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(8))
        return chars[:4] + "-" + chars[4:]

    def start_pairing(self, client_name, profile, scopes):
        if not isinstance(client_name, str) or not CLIENT_NAME_RE.fullmatch(client_name):
            raise ValueError("invalid client_name")
        if not isinstance(profile, str) or not PROFILE_RE.fullmatch(profile) or profile not in self.allowed_profiles:
            raise ValueError("invalid profile")
        if not isinstance(scopes, list) or not scopes:
            raise ValueError("invalid scopes")
        scope_set = frozenset(scopes)
        if any(not isinstance(x, str) for x in scopes) or not scope_set.issubset(ALLOWED_SCOPES):
            raise ValueError("invalid scopes")

        device_code = "aad1_" + b64u(secrets.token_bytes(32))
        device_hash = sha256_text(device_code)
        created = now_s()
        expires = created + self.pair_ttl
        scopes_json = compact_json(sorted(scope_set))

        for _ in range(20):
            user_code = self._new_user_code()
            try:
                with self._connect() as conn:
                    conn.execute(
                        "INSERT INTO pairings(device_hash,user_code,client_name,profile,scopes_json,status,created_at,expires_at) "
                        "VALUES(?,?,?,?,?,'pending',?,?)",
                        (device_hash, user_code, client_name, profile, scopes_json, created, expires),
                    )
                return {
                    "device_code": device_code,
                    "user_code": user_code,
                    "verification_uri": self.public_base + "/pair",
                    "expires_in": self.pair_ttl,
                    "interval": 2,
                }
            except sqlite3.IntegrityError:
                continue
        raise RuntimeError("unable to allocate user code")

    def approve_pairing(self, user_code):
        code = user_code.strip().upper()
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM pairings WHERE user_code=?", (code,)).fetchone()
            if not row:
                raise KeyError("pairing not found")
            if row["expires_at"] <= now_s():
                conn.execute("UPDATE pairings SET status='expired' WHERE user_code=?", (code,))
                raise ValueError("pairing expired")
            if row["status"] == "approved":
                return row["client_id"]
            if row["status"] != "pending":
                raise ValueError("pairing is not pending")
            client_id = "aac_" + b64u(secrets.token_bytes(12))
            conn.execute(
                "INSERT INTO clients(client_id,client_name,profile,scopes_json,created_at) VALUES(?,?,?,?,?)",
                (client_id, row["client_name"], row["profile"], row["scopes_json"], now_s()),
            )
            conn.execute(
                "UPDATE pairings SET status='approved',client_id=? WHERE user_code=? AND status='pending'",
                (client_id, code),
            )
            return client_id

    def poll_pairing(self, device_code):
        if not isinstance(device_code, str) or not device_code.startswith("aad1_"):
            raise ValueError("invalid device_code")
        device_hash = sha256_text(device_code)
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM pairings WHERE device_hash=?", (device_hash,)).fetchone()
            if not row:
                raise KeyError("pairing not found")
            if row["expires_at"] <= now_s():
                conn.execute("UPDATE pairings SET status='expired' WHERE device_hash=?", (device_hash,))
                return {"status": "expired"}
            if row["status"] == "pending":
                return {"status": "pending"}
            if row["status"] != "approved" or not row["client_id"]:
                return {"status": row["status"]}
            refresh_secret = b64u(self._hmac("refresh:" + row["client_id"] + ":" + device_code))
            refresh_token = "aar1." + row["client_id"] + "." + refresh_secret
            refresh_hash = sha256_text(refresh_token)
            client = conn.execute("SELECT * FROM clients WHERE client_id=?", (row["client_id"],)).fetchone()
            if not client or client["revoked_at"] is not None:
                return {"status": "revoked"}
            if client["refresh_hash"] is None:
                conn.execute("UPDATE clients SET refresh_hash=? WHERE client_id=?", (refresh_hash, row["client_id"]))
            elif not hmac.compare_digest(client["refresh_hash"], refresh_hash):
                raise RuntimeError("pairing refresh identity mismatch")
            return {
                "status": "approved",
                "client_id": row["client_id"],
                "refresh_token": refresh_token,
                "profile": row["profile"],
                "scopes": json.loads(row["scopes_json"]),
            }

    def issue_access_token(self, refresh_token):
        if not isinstance(refresh_token, str) or not refresh_token.startswith("aar1."):
            raise PermissionError("invalid refresh token")
        refresh_hash = sha256_text(refresh_token)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM clients WHERE refresh_hash=? AND revoked_at IS NULL", (refresh_hash,)
            ).fetchone()
        if not row:
            raise PermissionError("invalid refresh token")
        issued = now_s()
        payload = {
            "v": 1,
            "sub": row["client_id"],
            "profile": row["profile"],
            "scopes": json.loads(row["scopes_json"]),
            "iat": issued,
            "exp": issued + self.access_ttl,
            "nonce": b64u(secrets.token_bytes(9)),
        }
        encoded = b64u(compact_json(payload).encode("utf-8"))
        sig = b64u(self._hmac("access:" + encoded))
        return {
            "access_token": "aat1." + encoded + "." + sig,
            "token_type": "Bearer",
            "expires_in": self.access_ttl,
            "client_id": row["client_id"],
            "profile": row["profile"],
            "scopes": payload["scopes"],
        }

    def verify_access_token(self, token, required_scope="mcp"):
        try:
            prefix, encoded, sig = token.split(".", 2)
            if prefix != "aat1":
                raise ValueError
            expected = b64u(self._hmac("access:" + encoded))
            if not hmac.compare_digest(sig, expected):
                raise ValueError
            payload = json.loads(b64u_decode(encoded).decode("utf-8"))
            if payload.get("v") != 1 or int(payload.get("exp", 0)) <= now_s():
                raise ValueError
            scopes = payload.get("scopes")
            if not isinstance(scopes, list) or required_scope not in scopes:
                raise ValueError
            client_id = payload.get("sub")
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT client_id,profile,scopes_json,revoked_at FROM clients WHERE client_id=?", (client_id,)
                ).fetchone()
            if not row or row["revoked_at"] is not None:
                raise ValueError
            live_scopes = json.loads(row["scopes_json"])
            if required_scope not in live_scopes or payload.get("profile") != row["profile"]:
                raise ValueError
            return {"client_id": client_id, "profile": row["profile"], "scopes": live_scopes}
        except Exception as exc:
            raise PermissionError("invalid access token") from exc

    def revoke_client(self, client_id):
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE clients SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL", (now_s(), client_id)
            )
            return cur.rowcount == 1

    def list_pairings(self):
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT user_code,client_name,profile,scopes_json,status,client_id,created_at,expires_at "
                "FROM pairings ORDER BY created_at DESC LIMIT 100"
            ).fetchall()
        return [dict(row) for row in rows]

    def list_clients(self):
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT client_id,client_name,profile,scopes_json,created_at,revoked_at "
                "FROM clients ORDER BY created_at DESC LIMIT 100"
            ).fetchall()
        return [dict(row) for row in rows]


class PairRateLimiter:
    def __init__(self, limit=12, window=60):
        self.limit = limit
        self.window = window
        self.lock = threading.Lock()
        self.events = {}

    def allow(self, key):
        now = time.time()
        with self.lock:
            entries = [t for t in self.events.get(key, []) if now - t < self.window]
            if len(entries) >= self.limit:
                self.events[key] = entries
                return False
            entries.append(now)
            self.events[key] = entries
            return True


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "AgentAccessGateway/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    @property
    def app(self):
        return self.server.app

    def _json(self, status, obj, extra_headers=None):
        data = compact_json(obj).encode("utf-8")
        # Error paths can intentionally reject a request before consuming its
        # body (for example an unauthenticated MCP call).  With HTTP/1.1 a
        # reverse proxy may otherwise reuse that backend connection and parse
        # the unread bytes as the next request method.  Close on every error;
        # successful requests remain keep-alive capable.
        close_after = status >= 400
        if close_after:
            self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if close_after:
            self.send_header("Connection", "close")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _text(self, status, text, content_type="text/plain; charset=utf-8"):
        data = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self, max_bytes=65536):
        length_text = self.headers.get("Content-Length")
        if not length_text:
            raise ValueError("missing content length")
        length = int(length_text)
        if length < 0 or length > max_bytes:
            raise ValueError("request too large")
        raw = self.rfile.read(length)
        obj = json.loads(raw.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("JSON body must be an object")
        return obj

    def _client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return self.client_address[0]

    def _bearer(self):
        value = self.headers.get("Authorization", "")
        if not value.startswith("Bearer "):
            raise PermissionError("missing bearer token")
        return value[7:].strip()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/healthz":
            upstream_ok = self.app.upstream_probe()
            self._json(200 if upstream_ok else 503, {"ok": upstream_ok, "service": "agent-access-gateway"})
            return
        if path == "/pair":
            body = ("<!doctype html><meta charset=utf-8><title>Agent Access pairing</title>"
                    "<style>body{font:16px system-ui;max-width:760px;margin:4rem auto;padding:0 1.5rem;line-height:1.5}</style>"
                    "<h1>Agent Access pairing</h1><p>This private integration uses a one-time pairing code.</p>"
                    "<p>Approve the code from the trusted Agent Access admin CLI. No account password is entered on this page.</p>")
            self._text(200, body, "text/html; charset=utf-8")
            return
        if path == "/mcp":
            self._proxy_mcp()
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/v1/pair/start":
            if not self.app.rate_limiter.allow(self._client_ip()):
                self._json(429, {"error": "rate_limited"}, {"Retry-After": "60"})
                return
            try:
                body = self._read_json()
                result = self.app.state.start_pairing(
                    body.get("client_name", ""), body.get("profile", ""), body.get("scopes", ["mcp"])
                )
                self._json(200, result)
            except (ValueError, TypeError, json.JSONDecodeError):
                self._json(400, {"error": "invalid_request"})
            return
        if path == "/v1/pair/poll":
            try:
                body = self._read_json()
                result = self.app.state.poll_pairing(body.get("device_code"))
                status = 200 if result.get("status") == "approved" else 202
                if result.get("status") in {"expired", "revoked"}:
                    status = 410
                self._json(status, result)
            except KeyError:
                self._json(404, {"error": "pairing_not_found"})
            except (ValueError, TypeError, json.JSONDecodeError):
                self._json(400, {"error": "invalid_request"})
            return
        if path == "/v1/auth/token":
            try:
                body = self._read_json()
                self._json(200, self.app.state.issue_access_token(body.get("refresh_token")))
            except PermissionError:
                self._json(401, {"error": "invalid_grant"}, {"WWW-Authenticate": "Bearer"})
            except (ValueError, TypeError, json.JSONDecodeError):
                self._json(400, {"error": "invalid_request"})
            return
        if path == "/mcp":
            self._proxy_mcp()
            return
        self._json(404, {"error": "not_found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/mcp":
            self._proxy_mcp()
            return
        self._json(404, {"error": "not_found"})

    def _proxy_mcp(self):
        try:
            principal = self.app.state.verify_access_token(self._bearer(), "mcp")
        except PermissionError:
            self._json(401, {"error": "unauthorized"}, {"WWW-Authenticate": "Bearer"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length < 0 or length > self.app.max_proxy_body:
            self._json(413, {"error": "request_too_large"})
            return
        body = self.rfile.read(length) if length else None

        request_headers = {}
        for name in (
            "Content-Type",
            "Accept",
            "MCP-Method",
            "MCP-Name",
            "MCP-Protocol-Version",
            "MCP-Session-Id",
            "Last-Event-ID",
            "User-Agent",
        ):
            value = self.headers.get(name)
            if value:
                request_headers[name] = value
        request_headers["X-Agent-Access-Client"] = principal["client_id"]
        request_headers["X-Agent-Access-Profile"] = principal["profile"]

        try:
            status, reason, headers, payload = self.app.proxy(self.command, "/mcp", body, request_headers)
        except (OSError, http.client.HTTPException, TimeoutError):
            self._json(503, {"error": "upstream_unavailable"}, {"Retry-After": "2"})
            return

        self.send_response(status, reason)
        allowed_response_headers = {
            "content-type", "cache-control", "mcp-session-id", "mcp-protocol-version", "retry-after", "etag", "last-modified"
        }
        for name, value in headers:
            if name.lower() in allowed_response_headers:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if payload:
            self.wfile.write(payload)


class GatewayApp:
    def __init__(self, state, upstream, timeout=180, max_proxy_body=16 * 1024 * 1024):
        parsed = urlparse(upstream)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("upstream must be loopback http")
        self.state = state
        self.upstream_host = parsed.hostname
        self.upstream_port = parsed.port or 80
        self.timeout = timeout
        self.max_proxy_body = max_proxy_body
        self.rate_limiter = PairRateLimiter()

    def upstream_probe(self):
        try:
            conn = http.client.HTTPConnection(self.upstream_host, self.upstream_port, timeout=2)
            conn.request("GET", "/healthz", headers={"Host": "127.0.0.1"})
            res = conn.getresponse()
            res.read(8192)
            conn.close()
            return res.status == 200
        except Exception:
            return False

    def proxy(self, method, path, body, headers):
        conn = http.client.HTTPConnection(self.upstream_host, self.upstream_port, timeout=self.timeout)
        out_headers = dict(headers)
        out_headers["Host"] = "127.0.0.1"
        conn.request(method, path, body=body, headers=out_headers)
        res = conn.getresponse()
        payload = res.read()
        out = (res.status, res.reason, list(res.getheaders()), payload)
        conn.close()
        return out


def parse_listen(value):
    host, port = value.rsplit(":", 1)
    return host, int(port)


def build_state_from_env():
    state_dir = os.environ.get("AGENT_ACCESS_STATE_DIR", "/var/lib/agent-access-gateway")
    profiles = [x.strip() for x in os.environ.get("AGENT_ACCESS_PROFILES", "minimax").split(",") if x.strip()]
    return GatewayState(
        db_path=os.path.join(state_dir, "state.sqlite3"),
        master_key_path=os.path.join(state_dir, "master.key"),
        public_base=os.environ.get("AGENT_ACCESS_PUBLIC_BASE", "https://sites.axelhu.com/agent-access"),
        pair_ttl=int(os.environ.get("AGENT_ACCESS_PAIR_TTL", "600")),
        access_ttl=int(os.environ.get("AGENT_ACCESS_ACCESS_TTL", "900")),
        allowed_profiles=profiles,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default=os.environ.get("AGENT_ACCESS_LISTEN", "127.0.0.1:3250"))
    parser.add_argument("--upstream", default=os.environ.get("AGENT_ACCESS_UPSTREAM", "http://127.0.0.1:18791"))
    args = parser.parse_args()

    state = build_state_from_env()
    app = GatewayApp(state, args.upstream)
    host, port = parse_listen(args.listen)
    server = ThreadingHTTPServer((host, port), GatewayHandler)
    server.app = app
    print("agent-access-gateway listening on {}:{} -> {}".format(host, port, args.upstream), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
