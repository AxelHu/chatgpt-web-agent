#!/usr/bin/env python3
"""Explicitly authorized live Claude connector smoke; all credentials stay in memory.

Run from the home WSL host after deployment. Public HTTPS requests always use
the selected HTTP proxy. Redirects are never followed, including Claude's OAuth
callback. The trusted admin wrapper approves only this run's exact request and
revokes its grant in finally. No Drive or messaging tool is invoked.
"""

import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE = "https://sites.axelhu.com/agent-access-claude"
DEFAULT_WORKSPACE = "/home/axelhu/.openclaw/workspace-chatgpt-web-agent"
CALLBACK = "https://claude.ai/api/mcp/auth_callback"
PROTOCOL = "2025-11-25"


class SmokeError(Exception):
    """Messages are fixed, credential-free diagnostics safe for the receipt."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(value, message):
    if not value:
        raise SmokeError(message)


def json_body(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise SmokeError("invalid_json_response") from None


class LiveSmoke:
    def __init__(self, args):
        self.args = args
        self.base = args.base_url.rstrip("/")
        self.resource = self.base + "/mcp"
        require(self.base == DEFAULT_BASE, "admin_wrapper_is_bound_to_the_production_claude_base")
        parsed_proxy = urllib.parse.urlparse(args.proxy)
        require(parsed_proxy.scheme == "http" and parsed_proxy.hostname and parsed_proxy.port
                and not parsed_proxy.username and not parsed_proxy.password, "explicit_http_proxy_required")
        # urllib's ProxyHandler otherwise honors ambient NO_PROXY even when a
        # proxy dictionary was supplied explicitly.
        os.environ.update(HTTP_PROXY=args.proxy, HTTPS_PROXY=args.proxy,
                          http_proxy=args.proxy, https_proxy=args.proxy, NO_PROXY="", no_proxy="")
        self.cookies = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": args.proxy, "https": args.proxy}),
            urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect())
        self.admin_path = Path(__file__).resolve().parents[1] / "ops/home/claude-access-admin.py"
        self.started = int(time.time())
        self.run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(6)
        self.fixture_root = Path(args.workspace).resolve() / "scratch/claude-connector-20261111"
        self.fixture_dir = self.fixture_root / ("live-" + self.run_id)
        self.fixture = self.fixture_dir / "probe.txt"
        self.marker = "claude-live-smoke:" + self.run_id
        self.client_id = None
        self.user_code = None
        self.grant_id = None
        self.access = None
        self.refresh_token = None
        self.session = None
        self.rpc_id = 0
        self.protocol = PROTOCOL
        self.receipt = {"run_id": self.run_id, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "endpoint": self.resource, "proxy": args.proxy, "success": False,
                        "steps": [], "cleanup": {"fixture_removed": False, "grant_revoked": False}}
        self.stage = "initialization"

    def record(self, step, **values):
        self.receipt["steps"].append({"step": step, "ok": True, **values})

    def request(self, method, url, body=None, headers=None):
        # No URL supplied by a response may take us outside this fixed gateway.
        target = urllib.parse.urlparse(url)
        expected = urllib.parse.urlparse(self.base)
        require(target.scheme == "https" and target.netloc == expected.netloc
                and target.path.startswith(expected.path + "/"), "request_outside_gateway_refused")
        request = urllib.request.Request(url, data=body, method=method,
                                         headers={"User-Agent": "WebAgentTools-Claude-Smoke/1", **(headers or {})})
        try:
            response = self.http.open(request, timeout=45)
        except urllib.error.HTTPError as exc:
            response = exc  # Includes the deliberately intercepted OAuth 302.
        except (urllib.error.URLError, OSError):
            raise SmokeError("gateway_request_failed_through_required_proxy") from None
        with response:
            raw = response.read(8 * 1024 * 1024 + 1)
            require(len(raw) <= 8 * 1024 * 1024, "response_too_large")
            return response.code, response.headers, raw

    def post_json(self, path, value, token=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if token:
            headers["Authorization"] = "Bearer " + token
        return self.request("POST", self.base + path, json.dumps(value).encode(), headers)

    def post_form(self, path, values):
        return self.request("POST", self.base + path, urllib.parse.urlencode(values).encode(),
                            {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})

    def admin(self, action, value=None, allow_nonzero=False):
        command = [sys.executable, str(self.admin_path), action]
        if value is not None:
            command.append(value)
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=40, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise SmokeError("trusted_admin_operation_failed") from None
        require(allow_nonzero or result.returncode == 0, "trusted_admin_operation_rejected")
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            raise SmokeError("trusted_admin_returned_invalid_json") from None
        return payload

    def matching_pairing(self):
        rows = self.admin("pairings")
        require(isinstance(rows, list), "pairings_response_not_a_list")
        matches = [row for row in rows if row.get("user_code") == self.user_code
                   and row.get("oauth_client_id") == self.client_id and row.get("resource") == self.resource
                   and row.get("redirect_uri") == CALLBACK and row.get("created_at", 0) >= self.started - 30]
        require(len(matches) == 1, "exact_smoke_pairing_not_found")
        return matches[0]

    def rpc(self, method, params=None, notification=False):
        self.rpc_id += 1
        envelope = {"jsonrpc": "2.0", "method": method}
        if not notification:
            envelope["id"] = self.rpc_id
        if params is not None:
            envelope["params"] = params
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "Authorization": "Bearer " + self.access, "MCP-Protocol-Version": self.protocol}
        if self.session:
            headers["MCP-Session-Id"] = self.session
        status, returned_headers, raw = self.request("POST", self.resource, json.dumps(envelope).encode(), headers)
        require(status in (200, 202), "mcp_http_status_unexpected")
        self.session = returned_headers.get("MCP-Session-Id") or self.session
        if notification and not raw.strip():
            return {}
        if "text/event-stream" in returned_headers.get("Content-Type", ""):
            responses = []
            for block in raw.decode("utf-8").replace("\r\n", "\n").split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
                if data:
                    responses.append(json_body(data.encode()))
            matching = [item for item in responses if isinstance(item, dict) and item.get("id") == envelope.get("id")]
            require(len(matching) == 1, "mcp_sse_response_missing")
            response = matching[0]
        else:
            response = json_body(raw)
        require(isinstance(response, dict) and "error" not in response, "mcp_jsonrpc_error")
        if not notification:
            require(response.get("id") == envelope["id"] and "result" in response, "mcp_response_id_or_result_mismatch")
        return response.get("result", {})

    def call(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        require(isinstance(result, dict) and not result.get("isError"), "mcp_tool_failed_" + name)
        return result

    @staticmethod
    def tool_text(result):
        text = "\n".join(item.get("text", "") for item in result.get("content", []) if item.get("type") == "text")
        structured = result.get("structuredContent", {})
        if isinstance(structured, dict):
            text += "\n" + structured.get("aggregated", "")
        return text

    def run(self):
        self.stage = "unauthenticated_discovery"
        status, headers, _ = self.post_json("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        require(status == 401, "unauthenticated_mcp_was_not_401")
        metadata_url = self.base + "/.well-known/oauth-protected-resource"
        require('resource_metadata="' + metadata_url + '"' in headers.get("WWW-Authenticate", ""), "missing_resource_metadata_challenge")
        status, _, raw = self.request("GET", metadata_url)
        metadata = json_body(raw)
        require(status == 200 and metadata.get("resource") == self.resource
                and metadata.get("authorization_servers") == [self.base], "resource_metadata_mismatch")
        status, _, raw = self.request("GET", self.base + "/.well-known/oauth-authorization-server")
        metadata = json_body(raw)
        require(status == 200 and metadata.get("issuer") == self.base
                and metadata.get("token_endpoint") == self.base + "/oauth/token"
                and "S256" in metadata.get("code_challenge_methods_supported", []), "authorization_metadata_mismatch")
        self.record(self.stage)

        self.stage = "dcr_and_exact_operator_approval"
        status, _, raw = self.post_json("/oauth/register", {"client_name": "Claude live smoke " + self.run_id,
            "redirect_uris": [CALLBACK], "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"]})
        registration = json_body(raw)
        require(status == 201 and isinstance(registration.get("client_id"), str), "dcr_failed")
        self.client_id = registration["client_id"]
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(32)
        authorize_url = self.base + "/oauth/authorize?" + urllib.parse.urlencode({"response_type": "code",
            "client_id": self.client_id, "redirect_uri": CALLBACK, "resource": self.resource, "scope": "mcp",
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256"})
        status, headers, raw = self.request("GET", authorize_url)
        require(status == 200, "authorize_page_failed")
        match = re.search(rb"<code>([A-Z0-9]{4}-[A-Z0-9]{4})</code>", raw)
        require(match is not None, "authorize_pairing_code_missing")
        self.user_code = match.group(1).decode()
        require(any(cookie.secure for cookie in self.cookies), "secure_oauth_cookie_missing")
        request = self.matching_pairing()
        require(request.get("approval_status") == "pending" and not request.get("grant_id"), "smoke_pairing_not_pending")
        approved = self.admin("approve", self.user_code)
        require(isinstance(approved.get("client_id"), str), "operator_approval_failed")
        self.grant_id = approved["client_id"]
        require(self.matching_pairing().get("grant_id") == self.grant_id, "approved_grant_binding_mismatch")
        status, headers, _ = self.request("GET", authorize_url)
        require(status == 302, "authorized_request_did_not_redirect")
        location = urllib.parse.urlparse(headers.get("Location", ""))
        callback = urllib.parse.urlparse(CALLBACK)
        require((location.scheme, location.netloc, location.path) == (callback.scheme, callback.netloc, callback.path), "callback_target_mismatch")
        values = urllib.parse.parse_qs(location.query)
        require(values.get("state") == [state] and len(values.get("code", [])) == 1, "callback_state_or_code_mismatch")
        status, _, raw = self.post_form("/oauth/token", {"grant_type": "authorization_code", "client_id": self.client_id,
            "redirect_uri": CALLBACK, "resource": self.resource, "code": values["code"][0], "code_verifier": verifier})
        tokens = json_body(raw)
        require(status == 200 and tokens.get("access_token") and tokens.get("refresh_token"), "code_exchange_failed")
        self.access, self.refresh_token = tokens["access_token"], tokens["refresh_token"]
        self.record(self.stage, callback_followed=False)

        self.stage = "legacy_mcp_initialize_and_catalog"
        initialized = self.rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
            "clientInfo": {"name": "claude-connector-live-smoke", "version": "1"}})
        require(initialized.get("protocolVersion") == PROTOCOL, "legacy_protocol_not_negotiated")
        self.protocol = initialized["protocolVersion"]
        self.rpc("notifications/initialized", notification=True)
        listed = self.rpc("tools/list")
        names = sorted(tool["name"] for tool in listed.get("tools", []))
        require(len(names) == 16 and {"read", "exec", "process", "apply_patch", "skills_list", "skill_read"}.issubset(names),
                "expected_16_tool_catalog_missing")
        self.record(self.stage, protocol=self.protocol, tool_count=len(names), tools=names)

        self.stage = "patch_read_and_background_process"
        self.call("apply_patch", {"input": "*** Begin Patch\n*** Add File: " + str(self.fixture) + "\n+" + self.marker + "\n*** End Patch"})
        require(self.marker in self.tool_text(self.call("read", {"path": str(self.fixture)})), "fixture_read_mismatch")
        process_marker = "claude-background-ok:" + self.run_id
        command = shlex.join(["python3", "-c", "import time; time.sleep(2); print(" + repr(process_marker) + ")"])
        started = self.call("exec", {"command": command, "workdir": str(self.fixture_dir),
                                    "background": True, "yieldMs": 10, "timeoutSeconds": 15})
        process_id = started.get("structuredContent", {}).get("sessionId")
        require(isinstance(process_id, str) and process_id, "background_session_missing")
        completed = False
        for _ in range(5):
            polled = self.call("process", {"action": "poll", "sessionId": process_id, "timeout": 3000})
            structured = polled.get("structuredContent", {})
            if structured.get("status") == "completed":
                require(structured.get("exitCode") == 0 and process_marker in self.tool_text(polled), "background_result_mismatch")
                completed = True
                break
        require(completed, "background_process_did_not_complete")
        self.record(self.stage)

        self.stage = "refresh_and_read"
        previous_refresh = self.refresh_token
        status, _, raw = self.post_form("/oauth/token", {"grant_type": "refresh_token", "client_id": self.client_id,
            "resource": self.resource, "refresh_token": previous_refresh})
        tokens = json_body(raw)
        require(status == 200 and tokens.get("access_token") and tokens.get("refresh_token")
                and tokens["refresh_token"] != previous_refresh, "refresh_did_not_rotate")
        self.access, self.refresh_token = tokens["access_token"], tokens["refresh_token"]
        require(self.marker in self.tool_text(self.call("read", {"path": str(self.fixture)})), "refreshed_read_failed")
        self.record(self.stage)

        self.stage = "fixture_removal"
        self.call("apply_patch", {"input": "*** Begin Patch\n*** Delete File: " + str(self.fixture) + "\n*** End Patch"})
        remove_dir = shlex.join(["python3", "-c", "from pathlib import Path; Path(" + repr(str(self.fixture_dir)) + ").rmdir()"])
        removed = self.call("exec", {"command": remove_dir, "workdir": str(Path(self.args.workspace).resolve()),
                                    "timeoutSeconds": 10, "yieldMs": 1000})
        require(removed.get("structuredContent", {}).get("exitCode") == 0, "fixture_directory_removal_failed")
        require(not self.fixture_dir.exists(), "fixture_still_exists")
        self.receipt["cleanup"]["fixture_removed"] = True
        self.record(self.stage)

        self.stage = "revocation_and_401"
        status, _, _ = self.post_form("/oauth/revoke", {"client_id": self.client_id, "token": self.refresh_token})
        require(status == 200, "revoke_endpoint_failed")
        status, _, _ = self.post_json("/mcp", {"jsonrpc": "2.0", "id": 99, "method": "tools/list"}, self.access)
        require(status == 401, "revoked_access_was_not_rejected")
        self.record(self.stage)
        self.receipt["success"] = True

    def cleanup(self):
        # Operator-side cleanup still works if network/token exchange failed or
        # a token was already revoked. Recover an approval whose response was
        # lost by matching this run's unique pairing, never the whole queue.
        try:
            if not self.grant_id and self.client_id and self.user_code:
                self.grant_id = self.matching_pairing().get("grant_id")
            if self.grant_id:
                self.admin("revoke", self.grant_id, allow_nonzero=True)
                clients = self.admin("clients")
                exact = [row for row in clients if row.get("client_id") == self.grant_id]
                require(len(exact) == 1 and exact[0].get("revoked_at") is not None, "grant_revocation_not_verified")
                self.receipt["cleanup"]["grant_revoked"] = True
                self.receipt["grant_id"] = self.grant_id
            else:
                self.receipt["cleanup"]["grant_revoked"] = True  # No approved grant exists.
        except Exception:
            self.receipt["cleanup"]["grant_revoked"] = False
            self.receipt["cleanup"]["grant_cleanup_error"] = "trusted_admin_cleanup_requires_attention"
        try:
            # Only our unique marker file and its empty directory are eligible.
            require(not self.fixture_dir.is_symlink() and not self.fixture.is_symlink(), "fixture_symlink_refused")
            if self.fixture.exists():
                require(self.fixture.is_file() and self.fixture.read_text() == self.marker + "\n", "fixture_content_changed_cleanup_refused")
                self.fixture.unlink()
            if self.fixture_dir.exists():
                self.fixture_dir.rmdir()
            self.receipt["cleanup"]["fixture_removed"] = not self.fixture_dir.exists()
        except Exception:
            self.receipt["cleanup"]["fixture_removed"] = False
            self.receipt["cleanup"]["fixture_cleanup_error"] = "unique_smoke_fixture_requires_attention"
        if not all(self.receipt["cleanup"].get(key) for key in ("grant_revoked", "fixture_removed")):
            self.receipt["success"] = False
        self.access = self.refresh_token = None
        self.cookies.clear()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--proxy", default="http://127.0.0.1:1080")
    parser.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    parser.add_argument("--output", type=Path, help="Optional credential-free JSON receipt path")
    args = parser.parse_args()
    smoke = LiveSmoke(args)
    def interrupted(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        smoke.run()
    except (Exception, KeyboardInterrupt) as exc:
        smoke.receipt.update(success=False, failed_step=smoke.stage, error_type=type(exc).__name__,
                             error=str(exc) if isinstance(exc, SmokeError) else "unexpected_failure")
    finally:
        smoke.cleanup()
    smoke.receipt["duration_seconds"] = round(time.time() - smoke.started, 2)
    output = json.dumps(smoke.receipt, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")
    raise SystemExit(0 if smoke.receipt["success"] else 1)


if __name__ == "__main__":
    main()
