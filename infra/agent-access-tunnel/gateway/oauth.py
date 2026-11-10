"""Narrow OAuth 2.0 adapter for the private, operator-approved MCP gateway.

The existing device-pairing protocol remains separate. This adapter supports
registered public clients, authorization code + S256 PKCE, and rotating refresh
tokens for exactly one configured MCP resource. It does not fetch client URLs
or implement a general identity provider.
"""

import base64
import hashlib
import hmac
import html
import json
import re
import secrets
import time
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode, urlparse


SCHEMA = """
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  request_id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state_value TEXT,
  device_hash TEXT NOT NULL REFERENCES pairings(device_hash),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  code_hash TEXT UNIQUE,
  code_expires_at INTEGER,
  grant_id TEXT REFERENCES clients(client_id)
);
CREATE TABLE IF NOT EXISTS oauth_refresh (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  grant_id TEXT NOT NULL REFERENCES clients(client_id),
  resource TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_requests_expiry ON oauth_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_grant ON oauth_refresh(grant_id);
"""

COOKIE_NAME = "__Secure-AAOAuth"
PKCE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
COOKIE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
DEFAULT_REDIRECTS = ("https://claude.ai/api/mcp/auth_callback",)


def _now():
    return int(time.time())


def _json(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _random(prefix=""):
    return prefix + _b64(secrets.token_bytes(32))


def _params(raw):
    if len(raw) > 16384:
        raise OAuthError("invalid_request")
    try:
        values = parse_qs(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=32)
    except (ValueError, UnicodeError):
        raise OAuthError("invalid_request") from None
    if any(len(value) != 1 for value in values.values()):
        raise OAuthError("invalid_request")
    return {name: value[0] for name, value in values.items()}


class OAuthError(Exception):
    def __init__(self, error, status=400):
        super().__init__(error)
        self.error = error
        self.status = status


class OAuthService:
    def __init__(self, state, profile="claude", allowed_redirects=DEFAULT_REDIRECTS,
                 refresh_ttl=2592000, code_ttl=120):
        self.state = state
        self.issuer = state.public_base
        parsed = urlparse(self.issuer)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
                parsed.password or parsed.query or parsed.fragment):
            raise ValueError("OAuth public base must be a canonical HTTPS URL")
        if profile not in state.allowed_profiles:
            raise ValueError("OAuth profile must be an allowed gateway profile")
        self.profile = profile
        self.base_path = parsed.path.rstrip("/")
        self.resource = self.issuer + "/mcp"
        self.allowed_redirects = frozenset(allowed_redirects)
        if not self.allowed_redirects:
            raise ValueError("OAuth needs at least one explicitly allowed redirect URI")
        for uri in self.allowed_redirects:
            target = urlparse(uri)
            if (target.scheme != "https" or not target.hostname or target.username or
                    target.password or target.fragment or target.query):
                raise ValueError("OAuth redirect allowlist must contain exact HTTPS URLs")
        if refresh_ttl < 60 or code_ttl < 10 or code_ttl > 600:
            raise ValueError("invalid OAuth token lifetime")
        self.refresh_ttl = refresh_ttl
        self.code_ttl = code_ttl
        self.metadata_url = self.issuer + "/.well-known/oauth-protected-resource"
        with state._connect() as conn:
            conn.executescript(SCHEMA)

    @property
    def challenge(self):
        return 'Bearer resource_metadata="{}", scope="mcp"'.format(self.metadata_url)

    def resource_metadata(self):
        return {"resource": self.resource, "authorization_servers": [self.issuer],
                "scopes_supported": ["mcp"], "bearer_methods_supported": ["header"],
                "resource_name": "WebAgentTools Home"}

    def authorization_metadata(self):
        return {"issuer": self.issuer,
                "authorization_endpoint": self.issuer + "/oauth/authorize",
                "token_endpoint": self.issuer + "/oauth/token",
                "registration_endpoint": self.issuer + "/oauth/register",
                "revocation_endpoint": self.issuer + "/oauth/revoke",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["mcp"]}

    def _prune(self, conn):
        # Keep recently used refresh hashes for replay detection. Never prune
        # another protocol's pairings or grant records.
        expired = conn.execute("SELECT device_hash FROM oauth_requests WHERE expires_at<?",
                               (_now() - 86400,)).fetchall()
        conn.execute("DELETE FROM oauth_requests WHERE expires_at<?", (_now() - 86400,))
        conn.executemany("DELETE FROM pairings WHERE device_hash=?", [(x[0],) for x in expired])
        conn.execute("DELETE FROM oauth_refresh WHERE expires_at<?", (_now() - 86400,))
        conn.execute("DELETE FROM oauth_clients WHERE created_at<? AND client_id NOT IN "
                     "(SELECT oauth_client_id FROM oauth_requests UNION SELECT oauth_client_id FROM oauth_refresh)",
                     (_now() - 604800,))

    def register(self, body):
        redirects = body.get("redirect_uris")
        if (not isinstance(redirects, list) or not 1 <= len(redirects) <= 8 or
                any(not isinstance(uri, str) or uri not in self.allowed_redirects for uri in redirects)):
            raise OAuthError("invalid_redirect_uri")
        if body.get("token_endpoint_auth_method", "none") != "none":
            raise OAuthError("invalid_client_metadata")
        grants = body.get("grant_types", ["authorization_code", "refresh_token"])
        responses = body.get("response_types", ["code"])
        if (not isinstance(grants, list) or "authorization_code" not in grants or
                any(x not in ("authorization_code", "refresh_token") for x in grants) or
                responses != ["code"]):
            raise OAuthError("invalid_client_metadata")
        name = body.get("client_name", "Claude")
        if (not isinstance(name, str) or not 1 <= len(name) <= 160 or
                any(ord(ch) < 32 or ord(ch) == 127 for ch in name)):
            raise OAuthError("invalid_client_metadata")
        client_id = _random("aao_client_")
        created = _now()
        redirects = list(dict.fromkeys(redirects))
        with self.state._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._prune(conn)
            if conn.execute("SELECT COUNT(*) FROM oauth_clients").fetchone()[0] >= 4096:
                raise OAuthError("temporarily_unavailable", 503)
            conn.execute("INSERT INTO oauth_clients VALUES(?,?,?,?)",
                         (client_id, name, _json(redirects), created))
        return {"client_id": client_id, "client_id_issued_at": created,
                "client_name": name, "redirect_uris": redirects,
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "scope": "mcp"}

    def _client(self, conn, client_id):
        if not isinstance(client_id, str) or len(client_id) > 256:
            raise OAuthError("invalid_client", 401)
        row = conn.execute("SELECT * FROM oauth_clients WHERE client_id=?", (client_id,)).fetchone()
        if not row:
            raise OAuthError("invalid_client", 401)
        return row

    def _resource(self, params):
        # A missing resource is unambiguous on this single-resource server;
        # an explicit resource must match exactly, including the /mcp path.
        value = params.get("resource", self.resource)
        if value != self.resource:
            raise OAuthError("invalid_target")
        return value

    def _validate_authorization(self, params):
        if params.get("response_type") != "code":
            raise OAuthError("unsupported_response_type")
        if params.get("code_challenge_method") != "S256" or not PKCE_RE.fullmatch(params.get("code_challenge", "")):
            raise OAuthError("invalid_request")
        if params.get("scope", "mcp").split() != ["mcp"]:
            raise OAuthError("invalid_scope")
        state_value = params.get("state")
        if state_value is not None and (len(state_value) > 4096 or any(ord(ch) < 32 for ch in state_value)):
            raise OAuthError("invalid_request")
        with self.state._connect() as conn:
            client = self._client(conn, params.get("client_id"))
        redirect = params.get("redirect_uri")
        if redirect not in json.loads(client["redirect_uris_json"]) or redirect not in self.allowed_redirects:
            raise OAuthError("invalid_redirect_uri")
        bound = {"client_id": client["client_id"], "redirect_uri": redirect,
                 "resource": self._resource(params), "code_challenge": params["code_challenge"],
                 "state": state_value}
        return client, bound, _hash(_json(bound))

    def authorize(self, params, browser_cookie=None, allow_create=None):
        client, bound, fingerprint = self._validate_authorization(params)
        cookie = browser_cookie if isinstance(browser_cookie, str) and COOKIE_RE.fullmatch(browser_cookie) else None
        request = None
        if cookie:
            with self.state._connect() as conn:
                request = conn.execute("SELECT * FROM oauth_requests WHERE browser_hash=? AND fingerprint=?",
                                       (_hash(cookie), fingerprint)).fetchone()
            if request and request["expires_at"] <= _now():
                raise OAuthError("authorization_expired")
        if not request:
            if allow_create is not None and not allow_create():
                raise OAuthError("temporarily_unavailable", 429)
            cookie = _random()
            pairing = self.state.start_pairing("Claude OAuth " + client["client_id"][-12:], self.profile, ["mcp"])
            with self.state._connect() as conn:
                conn.execute("INSERT INTO oauth_requests(request_id,browser_hash,fingerprint,oauth_client_id,"
                             "redirect_uri,resource,code_challenge,state_value,device_hash,created_at,expires_at) "
                             "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                             (_random("aao_request_"), _hash(cookie), fingerprint, bound["client_id"],
                              bound["redirect_uri"], bound["resource"], bound["code_challenge"], bound["state"],
                              _hash(pairing["device_code"]), _now(), _now() + self.state.pair_ttl))
        with self.state._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            request = conn.execute("SELECT * FROM oauth_requests WHERE browser_hash=?", (_hash(cookie),)).fetchone()
            pairing = conn.execute("SELECT * FROM pairings WHERE device_hash=?", (request["device_hash"],)).fetchone()
            if not pairing or request["expires_at"] <= _now() or pairing["expires_at"] <= _now():
                raise OAuthError("authorization_expired")
            result = {"cookie": cookie, "client_name": client["client_name"], "user_code": pairing["user_code"],
                      "resource": self.resource, "status": request["status"]}
            if request["status"] == "redeemed":
                return result
            if pairing["status"] == "pending":
                return result
            if pairing["status"] != "approved" or not pairing["client_id"]:
                raise OAuthError("access_denied")
            grant = conn.execute("SELECT * FROM clients WHERE client_id=?", (pairing["client_id"],)).fetchone()
            if not grant or grant["revoked_at"] is not None:
                raise OAuthError("access_denied")
            code = "aaoc1_" + _b64(self.state._hmac("oauth-code:" + request["request_id"] + ":" + cookie))
            if request["status"] == "pending":
                expiry = min(request["expires_at"], _now() + self.code_ttl)
                conn.execute("UPDATE oauth_requests SET status='issued',code_hash=?,code_expires_at=?,grant_id=? "
                             "WHERE request_id=? AND status='pending'",
                             (_hash(code), expiry, grant["client_id"], request["request_id"]))
            elif request["status"] != "issued" or request["code_expires_at"] <= _now():
                raise OAuthError("authorization_expired")
            callback = {"code": code}
            if request["state_value"] is not None:
                callback["state"] = request["state_value"]
            result["redirect"] = request["redirect_uri"] + "?" + urlencode(callback)
            return result

    def _grant(self, conn, grant_id):
        grant = conn.execute("SELECT * FROM clients WHERE client_id=?", (grant_id,)).fetchone()
        if (not grant or grant["revoked_at"] is not None or grant["profile"] != self.profile or
                "mcp" not in json.loads(grant["scopes_json"])):
            raise OAuthError("invalid_grant")
        return grant

    def _new_refresh(self, conn, client_id, grant_id, family_id=None):
        token = _random("aaor1_")
        conn.execute("INSERT INTO oauth_refresh(token_hash,family_id,oauth_client_id,grant_id,resource,issued_at,expires_at) "
                     "VALUES(?,?,?,?,?,?,?)",
                     (_hash(token), family_id or _random("aao_family_"), client_id, grant_id, self.resource,
                      _now(), _now() + self.refresh_ttl))
        return token

    def _tokens(self, client_id, grant_id, refresh):
        payload = {"v": 1, "iss": self.issuer, "sub": grant_id, "client_id": client_id,
                   "aud": self.resource, "scope": "mcp", "profile": self.profile,
                   "iat": _now(), "exp": _now() + self.state.access_ttl, "jti": _random()}
        encoded = _b64(_json(payload).encode("utf-8"))
        access = "aaot1." + encoded + "." + _b64(self.state._hmac("oauth-access:" + encoded))
        return {"access_token": access, "token_type": "Bearer", "expires_in": self.state.access_ttl,
                "refresh_token": refresh, "scope": "mcp"}

    def token(self, params):
        client_id = params.get("client_id")
        if params.get("client_secret"):
            raise OAuthError("invalid_client", 401)
        self._resource(params)
        with self.state._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._client(conn, client_id)
            if params.get("grant_type") == "authorization_code":
                code = params.get("code", "")
                if len(code) > 256:
                    raise OAuthError("invalid_grant")
                request = conn.execute("SELECT * FROM oauth_requests WHERE code_hash=?", (_hash(code),)).fetchone()
                verifier = params.get("code_verifier", "")
                if (not request or request["status"] != "issued" or request["code_expires_at"] <= _now() or
                        request["oauth_client_id"] != client_id or request["resource"] != self.resource or
                        params.get("redirect_uri") != request["redirect_uri"] or not VERIFIER_RE.fullmatch(verifier) or
                        not hmac.compare_digest(_b64(hashlib.sha256(verifier.encode("ascii")).digest()), request["code_challenge"])):
                    raise OAuthError("invalid_grant")
                self._grant(conn, request["grant_id"])
                conn.execute("UPDATE oauth_requests SET status='redeemed' WHERE request_id=?", (request["request_id"],))
                refresh = self._new_refresh(conn, client_id, request["grant_id"])
                return self._tokens(client_id, request["grant_id"], refresh)
            if params.get("grant_type") == "refresh_token":
                refresh = params.get("refresh_token", "")
                if len(refresh) > 256:
                    raise OAuthError("invalid_grant")
                previous = conn.execute("SELECT * FROM oauth_refresh WHERE token_hash=?", (_hash(refresh),)).fetchone()
                if (not previous or previous["oauth_client_id"] != client_id or previous["resource"] != self.resource or
                        previous["expires_at"] <= _now()):
                    raise OAuthError("invalid_grant")
                self._grant(conn, previous["grant_id"])
                if previous["used_at"] is not None:
                    # Commit the revocation even though the request is denied.
                    conn.execute("UPDATE clients SET revoked_at=? WHERE client_id=?", (_now(), previous["grant_id"]))
                    conn.commit()
                    raise OAuthError("invalid_grant")
                if params.get("scope", "mcp").split() != ["mcp"]:
                    raise OAuthError("invalid_scope")
                replacement = self._new_refresh(conn, client_id, previous["grant_id"], previous["family_id"])
                conn.execute("UPDATE oauth_refresh SET used_at=?,replaced_by_hash=? WHERE token_hash=?",
                             (_now(), _hash(replacement), previous["token_hash"]))
                return self._tokens(client_id, previous["grant_id"], replacement)
            raise OAuthError("unsupported_grant_type")

    def verify_access(self, token):
        try:
            if not isinstance(token, str) or len(token) > 4096:
                raise ValueError
            prefix, encoded, signature = token.split(".", 2)
            expected = _b64(self.state._hmac("oauth-access:" + encoded))
            if prefix != "aaot1" or not hmac.compare_digest(signature, expected):
                raise ValueError
            payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError
            if (payload.get("v") != 1 or payload.get("iss") != self.issuer or payload.get("aud") != self.resource or
                    payload.get("profile") != self.profile or payload.get("scope") != "mcp" or payload.get("exp", 0) <= _now()):
                raise ValueError
            with self.state._connect() as conn:
                self._client(conn, payload.get("client_id"))
                grant = self._grant(conn, payload.get("sub"))
            return {"client_id": grant["client_id"], "profile": self.profile, "scopes": ["mcp"],
                    "oauth_client_id": payload["client_id"]}
        except (ValueError, TypeError, KeyError, UnicodeError, OAuthError):
            raise PermissionError("invalid access token") from None

    def revoke(self, params):
        token = params.get("token", "")
        if len(token) > 4096:
            raise OAuthError("invalid_request")
        with self.state._connect() as conn:
            self._client(conn, params.get("client_id"))
            row = conn.execute("SELECT grant_id FROM oauth_refresh WHERE token_hash=? AND oauth_client_id=?",
                               (_hash(token), params["client_id"])).fetchone()
            if row:
                conn.execute("UPDATE clients SET revoked_at=? WHERE client_id=?", (_now(), row["grant_id"]))
        if not row and token.startswith("aaot1."):
            try:
                principal = self.verify_access(token)
                if principal["oauth_client_id"] == params["client_id"]:
                    self.state.revoke_client(principal["client_id"])
            except PermissionError:
                pass
        return {}

    def list_requests(self):
        with self.state._connect() as conn:
            rows = conn.execute("SELECT p.user_code,c.client_name,r.oauth_client_id,r.redirect_uri,r.resource,"
                                "r.status,p.status AS approval_status,r.created_at,r.expires_at,p.client_id AS grant_id "
                                "FROM oauth_requests r JOIN pairings p ON r.device_hash=p.device_hash "
                                "JOIN oauth_clients c ON r.oauth_client_id=c.client_id ORDER BY r.created_at DESC LIMIT 100").fetchall()
        return [dict(row) for row in rows]

    def _cookie(self, handler):
        try:
            values = SimpleCookie()
            values.load(handler.headers.get("Cookie", ""))
            item = values.get(COOKIE_NAME)
            return item.value if item else None
        except Exception:
            return None

    def _read_form(self, handler):
        if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/x-www-form-urlencoded":
            raise OAuthError("invalid_request")
        try:
            length = int(handler.headers.get("Content-Length", "-1"))
        except ValueError:
            raise OAuthError("invalid_request") from None
        if length < 0 or length > 16384 or handler.headers.get("Transfer-Encoding"):
            raise OAuthError("invalid_request")
        try:
            return _params(handler.rfile.read(length).decode("utf-8"))
        except UnicodeError:
            raise OAuthError("invalid_request") from None

    def _authorize_page(self, handler):
        result = self.authorize(_params(urlparse(handler.path).query), self._cookie(handler),
                                allow_create=lambda: handler.app.rate_limiter.allow("oauth-authorize:" + handler._client_ip()))
        headers = {"Set-Cookie": "{}={}; Path={}/oauth/; Max-Age={}; Secure; HttpOnly; SameSite=Lax".format(
                       COOKIE_NAME, result["cookie"], self.base_path, self.state.pair_ttl),
                   "Referrer-Policy": "no-referrer",
                   "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
                   "X-Frame-Options": "DENY"}
        if result.get("redirect"):
            headers["Location"] = result["redirect"]
            handler._text(302, "Returning to Claude.", extra_headers=headers)
            return
        completed = result["status"] == "redeemed"
        body = ("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                "<title>WebAgentTools · Claude</title>" + ("" if completed else "<meta http-equiv=refresh content=3>") +
                "<style>body{font:17px system-ui;max-width:680px;margin:7vh auto;padding:24px;line-height:1.7;color:#172b29;background:#faf9f5}"
                "code{font:600 32px ui-monospace;letter-spacing:.1em;background:#e6efea;padding:12px 18px;border-radius:10px;display:inline-block}"
                "small{overflow-wrap:anywhere;color:#53635f}</style><h1>连接 WebAgentTools</h1>" +
                ("<p>连接已完成。可以关闭此窗口，回到 Claude 使用工具。</p>" if completed else
                 "<p>正在为 <strong>{}</strong> 申请访问家中工作环境。</p>"
                 "<p>这项连接可以读取和修改文件、执行命令，并调用已启用的本地工具。</p>"
                 "<p>请在可信的本机管理终端批准下方代码。批准后，此页会自动返回 Claude。</p>"
                 "<p><code>{}</code></p><p><small>{}</small></p>"
                 "<p>只有你自己发起连接时才批准；这页不收集账号密码。</p>".format(
                     html.escape(result["client_name"]), html.escape(result["user_code"]), html.escape(self.resource))) + "</html>")
        handler._text(200, body, "text/html; charset=utf-8", extra_headers=headers)

    def handle(self, handler):
        """Handle the opt-in OAuth surface, returning whether a route matched."""
        path = urlparse(handler.path).path
        resource_paths = {"/.well-known/oauth-protected-resource",
                          "/.well-known/oauth-protected-resource" + self.base_path + "/mcp"}
        auth_paths = {"/.well-known/oauth-authorization-server",
                      "/.well-known/oauth-authorization-server" + self.base_path}
        endpoints = resource_paths | auth_paths | {"/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"}
        if path not in endpoints:
            return False
        try:
            if handler.command == "GET" and path in resource_paths:
                handler._json(200, self.resource_metadata())
            elif handler.command == "GET" and path in auth_paths:
                handler._json(200, self.authorization_metadata())
            elif handler.command == "GET" and path == "/oauth/authorize":
                self._authorize_page(handler)
            elif handler.command == "POST" and path == "/oauth/register":
                if not handler.app.rate_limiter.allow("oauth-register:" + handler._client_ip()):
                    raise OAuthError("temporarily_unavailable", 429)
                if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise OAuthError("invalid_request")
                handler._json(201, self.register(handler._read_json(16384)))
            elif handler.command == "POST" and path == "/oauth/token":
                handler._json(200, self.token(self._read_form(handler)), {"Pragma": "no-cache"})
            elif handler.command == "POST" and path == "/oauth/revoke":
                handler._json(200, self.revoke(self._read_form(handler)))
            else:
                raise OAuthError("invalid_request", 405)
        except OAuthError as exc:
            handler._json(exc.status, {"error": exc.error})
        except (ValueError, TypeError, json.JSONDecodeError):
            handler._json(400, {"error": "invalid_request"})
        return True
