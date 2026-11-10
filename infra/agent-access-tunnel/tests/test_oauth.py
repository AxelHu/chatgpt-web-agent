import base64
import concurrent.futures
import hashlib
import http.client
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlparse

from gateway.agent_access_gateway import GatewayApp, GatewayHandler, GatewayState
from gateway.oauth import COOKIE_NAME, OAuthError, OAuthService


REDIRECT = "https://claude.ai/api/mcp/auth_callback"
BASE = "https://sites.axelhu.com/agent-access-claude"


class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = GatewayState(os.path.join(self.tmp.name, "state.sqlite3"),
                                  os.path.join(self.tmp.name, "master.key"), BASE,
                                  pair_ttl=600, access_ttl=60, allowed_profiles={"claude", "minimax"})
        self.oauth = self.state.oauth = OAuthService(self.state, code_ttl=60, refresh_ttl=3600)
        self.client = self.oauth.register({"redirect_uris": [REDIRECT], "client_name": "Claude"})
        self.verifier = "q" * 64
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).rstrip(b"=").decode()
        self.params = {"response_type": "code", "client_id": self.client["client_id"],
                       "redirect_uri": REDIRECT, "resource": BASE + "/mcp", "scope": "mcp",
                       "code_challenge": challenge, "code_challenge_method": "S256", "state": "opaque-client-state"}

    def code(self):
        pending = self.oauth.authorize(self.params)
        grant = self.state.approve_pairing(pending["user_code"])
        approved = self.oauth.authorize(self.params, pending["cookie"])
        callback = parse_qs(urlparse(approved["redirect"]).query)
        self.assertEqual(callback["state"], [self.params["state"]])
        self.assertEqual(urlparse(approved["redirect"]).hostname, "claude.ai")
        return callback["code"][0], grant, pending["cookie"]

    def exchange(self, code, **changes):
        params = {"grant_type": "authorization_code", "code": code, "client_id": self.client["client_id"],
                  "redirect_uri": REDIRECT, "resource": BASE + "/mcp", "code_verifier": self.verifier}
        params.update(changes)
        return self.oauth.token(params)

    def refresh(self, token, **changes):
        params = {"grant_type": "refresh_token", "refresh_token": token,
                  "client_id": self.client["client_id"], "resource": BASE + "/mcp"}
        params.update(changes)
        return self.oauth.token(params)

    def server(self, handler, app=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        if app:
            server.app = app
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            conn.request(method, path, body, headers or {})
            result = conn.getresponse()
            return result.status, dict(result.getheaders()), result.read()
        finally:
            conn.close()

    def test_authorization_requires_matching_operator_approval_and_reuses_cookie(self):
        first = self.oauth.authorize(self.params)
        for _ in range(18):
            current = self.oauth.authorize(self.params, first["cookie"], allow_create=lambda: False)
            self.assertEqual(current["user_code"], first["user_code"])
            self.assertNotIn("redirect", current)
        self.assertEqual(len(self.oauth.list_requests()), 1)
        second = self.oauth.authorize(dict(self.params, state="another-request"), first["cookie"])
        self.assertNotEqual(second["user_code"], first["user_code"])
        self.state.approve_pairing(second["user_code"])
        self.assertNotIn("redirect", self.oauth.authorize(self.params, first["cookie"]))
        self.assertIn("redirect", self.oauth.authorize(dict(self.params, state="another-request"), second["cookie"]))
        with self.assertRaises(OAuthError):
            self.oauth.authorize(self.params, "invalid-cookie", allow_create=lambda: False)

    def test_dcr_and_authorize_reject_redirect_pkce_scope_and_resource_confusion(self):
        for redirect in ("https://claude.ai.evil.test/api/mcp/auth_callback", REDIRECT + "?next=evil",
                         "http://claude.ai/api/mcp/auth_callback", "https://example.test/callback"):
            with self.subTest(redirect=redirect), self.assertRaises(OAuthError):
                self.oauth.register({"redirect_uris": [redirect]})
        for change in ({"redirect_uri": "https://example.test/callback"}, {"resource": BASE},
                       {"code_challenge_method": "plain"}, {"code_challenge": "short"},
                       {"scope": "mcp admin"}, {"response_type": "token"}):
            with self.subTest(change=change), self.assertRaises(OAuthError):
                self.oauth.authorize(dict(self.params, **change))
        for change in ({"redirect_uris": REDIRECT}, {"redirect_uris": [None]},
                       {"client_name": []}, {"grant_types": "authorization_code"},
                       {"response_types": "code"}, {"token_endpoint_auth_method": "client_secret_post"}):
            with self.subTest(change=change), self.assertRaises(OAuthError):
                self.oauth.register(dict({"redirect_uris": [REDIRECT]}, **change))

    def test_code_binding_single_use_and_live_revocation(self):
        code, grant, _ = self.code()
        other = self.oauth.register({"redirect_uris": [REDIRECT]})
        for change in ({"client_id": other["client_id"]}, {"code_verifier": "z" * 64},
                       {"redirect_uri": REDIRECT + "/"}, {"resource": BASE + "/other"}):
            with self.subTest(change=change), self.assertRaises(OAuthError):
                self.exchange(code, **change)
        tokens = self.exchange(code)
        self.assertEqual(self.oauth.verify_access(tokens["access_token"])["client_id"], grant)
        with self.assertRaises(OAuthError):
            self.exchange(code)
        self.state.revoke_client(grant)
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(tokens["access_token"])
        with self.assertRaises(OAuthError):
            self.refresh(tokens["refresh_token"])

    def test_code_and_refresh_expiry(self):
        code, _, _ = self.code()
        with patch("gateway.oauth._now", return_value=2 ** 40), self.assertRaises(OAuthError):
            self.exchange(code)
        tokens = self.exchange(code)
        with patch("gateway.oauth._now", return_value=2 ** 40):
            with self.assertRaises(OAuthError):
                self.refresh(tokens["refresh_token"])
            with self.assertRaises(PermissionError):
                self.oauth.verify_access(tokens["access_token"])

    def test_refresh_rotates_and_replay_revokes_family(self):
        code, _, _ = self.code()
        original = self.exchange(code)
        rotated = self.refresh(original["refresh_token"])
        self.assertNotEqual(original["refresh_token"], rotated["refresh_token"])
        self.oauth.verify_access(rotated["access_token"])
        with self.assertRaises(OAuthError):
            self.refresh(original["refresh_token"])
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(rotated["access_token"])
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(original["access_token"])
        with self.assertRaises(OAuthError):
            self.refresh(rotated["refresh_token"])

    def test_parallel_code_exchange_has_exactly_one_winner(self):
        code, _, _ = self.code()
        def exchange_once():
            try:
                return self.exchange(code)
            except OAuthError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: exchange_once(), range(2)))
        winners = [result for result in results if result]
        self.assertEqual(len(winners), 1)
        self.oauth.verify_access(winners[0]["access_token"])

    def test_parallel_refresh_is_atomic_and_replay_revokes(self):
        code, _, _ = self.code()
        original = self.exchange(code)
        def refresh_once():
            try:
                return self.refresh(original["refresh_token"])
            except OAuthError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: refresh_once(), range(2)))
        winners = [result for result in results if result]
        self.assertEqual(len(winners), 1)
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(winners[0]["access_token"])

    def test_unknown_revoke_is_success_but_wrong_client_cannot_revoke(self):
        code, _, _ = self.code()
        tokens = self.exchange(code)
        other = self.oauth.register({"redirect_uris": [REDIRECT]})
        self.assertEqual(self.oauth.revoke({"client_id": other["client_id"], "token": tokens["refresh_token"]}), {})
        self.oauth.verify_access(tokens["access_token"])
        self.oauth.revoke({"client_id": self.client["client_id"], "token": tokens["access_token"]})
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(tokens["access_token"])

    def test_protocol_credentials_do_not_cross(self):
        pairing = self.state.start_pairing("minimax", "minimax", ["mcp"])
        self.state.approve_pairing(pairing["user_code"])
        legacy = self.state.issue_access_token(self.state.poll_pairing(pairing["device_code"])["refresh_token"])
        self.state.verify_access_token(legacy["access_token"])
        with self.assertRaises(PermissionError):
            self.oauth.verify_access(legacy["access_token"])
        code, _, _ = self.code()
        current = self.exchange(code)
        with self.assertRaises(PermissionError):
            self.state.verify_access_token(current["access_token"])
        with self.state._connect() as conn:
            db_contents = "\n".join(conn.iterdump())
        self.assertNotIn(current["access_token"], db_contents)
        self.assertNotIn(current["refresh_token"], db_contents)
        self.assertNotIn(code, db_contents)

    def test_http_discovery_consent_token_and_authenticated_mcp(self):
        observed = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                observed.append((dict(self.headers), raw))
                data = b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        upstream = self.server(Upstream)
        server = self.server(GatewayHandler, GatewayApp(self.state, "http://127.0.0.1:" + str(upstream.server_port)))
        status, headers, _ = self.request(server, "POST", "/mcp", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 401)
        self.assertIn('resource_metadata="' + self.oauth.metadata_url + '"', headers["WWW-Authenticate"])
        for path, key, value in (("/.well-known/oauth-protected-resource", "resource", BASE + "/mcp"),
                                 ("/.well-known/oauth-protected-resource/agent-access-claude/mcp", "resource", BASE + "/mcp"),
                                 ("/.well-known/oauth-authorization-server/agent-access-claude", "issuer", BASE)):
            status, _, raw = self.request(server, "GET", path)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)[key], value)
        status, _, raw = self.request(server, "POST", "/oauth/register", json.dumps({
            "redirect_uris": [REDIRECT], "client_name": "Claude <script>bad</script>"}), {"Content-Type": "application/json"})
        self.assertEqual(status, 201)
        registration = json.loads(raw)
        params = dict(self.params, client_id=registration["client_id"])
        path = "/oauth/authorize?" + urlencode(params)
        status, headers, raw = self.request(server, "GET", path)
        self.assertEqual(status, 200)
        self.assertIn(b"&lt;script&gt;", raw)
        self.assertNotIn(b"<script>", raw)
        for flag in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/agent-access-claude/oauth/"):
            self.assertIn(flag, headers["Set-Cookie"])
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        user_code = re.search(rb"<code>([A-Z0-9-]+)</code>", raw).group(1).decode()
        self.state.approve_pairing(user_code)
        status, headers, _ = self.request(server, "GET", path, headers={"Cookie": cookie})
        self.assertEqual(status, 302)
        code = parse_qs(urlparse(headers["Location"]).query)["code"][0]
        form = {"grant_type": "authorization_code", "code": code, "client_id": registration["client_id"],
                "redirect_uri": REDIRECT, "resource": BASE + "/mcp", "code_verifier": self.verifier}
        status, _, raw = self.request(server, "POST", "/oauth/token", urlencode(form),
                                     {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 200)
        tokens = json.loads(raw)
        status, _, raw = self.request(server, "POST", "/mcp", b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                                     {"Authorization": "Bearer " + tokens["access_token"], "Cookie": cookie,
                                      "Origin": "https://claude.ai", "Content-Type": "application/json", "Accept": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["result"], {"tools": []})
        self.assertEqual(len(observed), 1)
        self.assertNotIn("Authorization", observed[0][0])
        self.assertNotIn("Cookie", observed[0][0])
        self.assertNotIn("Origin", observed[0][0])
        self.assertEqual(observed[0][0]["X-Agent-Access-Profile"], "claude")
        status, _, _ = self.request(server, "POST", "/v1/pair/start", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 404)

    def test_http_rejects_duplicate_and_wrong_body_encoding(self):
        server = self.server(GatewayHandler, GatewayApp(self.state, "http://127.0.0.1:9"))
        for content_type, body in (("application/json", '{"grant_type":"refresh_token"}'),
                                   ("application/x-www-form-urlencoded", "client_id=a&client_id=b&grant_type=refresh_token")):
            status, headers, _ = self.request(server, "POST", "/oauth/token", body, {"Content-Type": content_type})
            self.assertEqual(status, 400)
            self.assertEqual(headers["Connection"], "close")


if __name__ == "__main__":
    unittest.main()
