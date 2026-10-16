#!/usr/bin/env python3
"""MCP stdio to authenticated Agent Access HTTP bridge.

Pairing is an out-of-band setup operation. Once paired, the model sees only the proxied MCP tools.
Python 3.8+ stdlib only.
"""

import argparse
import json
import os
import stat
import sys
import threading
import time
import urllib.error
import urllib.request


def configure_stdio():
    # MCP stdio is UTF-8 JSON regardless of the host console code page.
    # Windows Python otherwise inherits a locale encoding such as GBK when
    # stdout is redirected by the Desktop runtime.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="strict")


configure_stdio()


BASE_URL = os.environ.get("AGENT_ACCESS_BASE_URL", "https://sites.axelhu.com/agent-access").rstrip("/")
PROFILE = os.environ.get("AGENT_ACCESS_PROFILE", "minimax")
CLIENT_NAME = os.environ.get("AGENT_ACCESS_CLIENT_NAME", "minimax-code")
PLUGIN_DATA = os.environ.get("PLUGIN_DATA")
STATE_PATH = os.environ.get(
    "AGENT_ACCESS_CREDENTIAL_FILE",
    os.path.join(PLUGIN_DATA, "credential.json")
    if PLUGIN_DATA
    else os.path.join(os.path.expanduser("~"), ".agent-access-minimax.json"),
)
WRITE_LOCK = threading.Lock()
ACCESS = {"token": None, "expires_at": 0}
PROTOCOL_VERSION = {"value": None}
PAIRING_REQUIRED_CODE = "AGENT_ACCESS_PAIRING_REQUIRED"
CREDENTIAL_REJECTED_CODE = "AGENT_ACCESS_CREDENTIAL_REJECTED"
PAIRING_REQUIRED_MESSAGE = (
    PAIRING_REQUIRED_CODE
    + ": the webagenttools-home Plugin is installed, but this MiniMax data environment "
      "has not been authorized yet. Run the Plugin pairing command once; after approval, "
      "future sessions authenticate automatically from persistent PLUGIN_DATA. "
      "This is not a Plugin-enable or MCP-registration failure."
)
CREDENTIAL_REJECTED_MESSAGE = (
    CREDENTIAL_REJECTED_CODE
    + ": the persisted Agent Access credential was rejected or revoked. "
      "Check Plugin status and pair this installation again only if it should remain authorized."
)


def request_json(path, body, bearer=None, timeout=30):
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            obj = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            obj = {"error": "http_{}".format(exc.code)}
        return exc.code, obj


def load_refresh_token():
    env_token = os.environ.get("AGENT_ACCESS_REFRESH_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
        token = obj.get("refresh_token")
        if isinstance(token, str) and token.startswith("aar1."):
            return token
    except (FileNotFoundError, ValueError, OSError):
        pass
    return None


def save_credential(result):
    parent = os.path.dirname(os.path.abspath(STATE_PATH))
    os.makedirs(parent, exist_ok=True)
    temp = STATE_PATH + ".tmp"
    payload = {
        "version": 1,
        "client_id": result["client_id"],
        "profile": result.get("profile", PROFILE),
        "refresh_token": result["refresh_token"],
        "base_url": BASE_URL,
    }
    with open(temp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
    try:
        os.chmod(temp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    os.replace(temp, STATE_PATH)


def get_access_token(force=False):
    now = time.time()
    if not force and ACCESS["token"] and ACCESS["expires_at"] - now > 30:
        return ACCESS["token"]
    refresh = load_refresh_token()
    if not refresh:
        raise RuntimeError(PAIRING_REQUIRED_MESSAGE)
    status, result = request_json("/v1/auth/token", {"refresh_token": refresh}, timeout=20)
    if status != 200 or not isinstance(result.get("access_token"), str):
        raise RuntimeError(CREDENTIAL_REJECTED_MESSAGE)
    ACCESS["token"] = result["access_token"]
    ACCESS["expires_at"] = now + int(result.get("expires_in", 300))
    return ACCESS["token"]


def pair():
    status, start = request_json(
        "/v1/pair/start",
        {"client_name": CLIENT_NAME, "profile": PROFILE, "scopes": ["mcp"]},
        timeout=20,
    )
    if status != 200:
        raise RuntimeError("pair start failed: {}".format(start.get("error", status)))
    print("Open: {}".format(start["verification_uri"]))
    print("Pairing code: {}".format(start["user_code"]))
    print("Approve this code from the trusted Agent Access admin CLI.")
    deadline = time.time() + int(start.get("expires_in", 600))
    interval = max(1, int(start.get("interval", 2)))
    while time.time() < deadline:
        time.sleep(interval)
        status, result = request_json("/v1/pair/poll", {"device_code": start["device_code"]}, timeout=20)
        if status == 200 and result.get("status") == "approved":
            save_credential(result)
            print("Paired as {}. Future Agent use is automatic.".format(result["client_id"]))
            return 0
        if status == 410:
            raise RuntimeError("pairing expired or was revoked")
        if status not in (200, 202):
            raise RuntimeError("pair poll failed: {}".format(result.get("error", status)))
    raise RuntimeError("pairing expired")


def status_cmd():
    refresh = load_refresh_token()
    if not refresh:
        print(
            json.dumps(
                {
                    "paired": False,
                    "state": "pairing_required",
                    "code": PAIRING_REQUIRED_CODE,
                    "base_url": BASE_URL,
                },
                indent=2,
            )
        )
        return 1
    try:
        token = get_access_token(force=True)
        print(
            json.dumps(
                {
                    "paired": True,
                    "state": "ready",
                    "base_url": BASE_URL,
                    "access_ready": bool(token),
                },
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "paired": True,
                    "state": "credential_rejected",
                    "code": CREDENTIAL_REJECTED_CODE,
                    "base_url": BASE_URL,
                    "access_ready": False,
                    "error": str(exc),
                },
                indent=2,
            )
        )
        return 2


def write_message(obj):
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    with WRITE_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def rpc_error(request_id, message):
    if request_id is None:
        return
    write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": message}})


def parse_sse(raw_text):
    for event in raw_text.replace("\r\n", "\n").split("\n\n"):
        data_lines = []
        for line in event.splitlines():
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if not data_lines:
            continue
        text = "\n".join(data_lines)
        try:
            yield json.loads(text)
        except ValueError:
            continue


def forward(message, retry_auth=True):
    request_id = message.get("id") if isinstance(message, dict) else None
    if isinstance(message, dict) and message.get("method") == "initialize":
        params = message.get("params")
        if isinstance(params, dict) and isinstance(params.get("protocolVersion"), str):
            PROTOCOL_VERSION["value"] = params["protocolVersion"]
    try:
        token = get_access_token()
    except Exception as exc:
        rpc_error(request_id, str(exc))
        return

    raw = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if isinstance(message, dict) and isinstance(message.get("method"), str):
        headers["MCP-Method"] = message["method"]
        params = message.get("params")
        if isinstance(params, dict) and isinstance(params.get("name"), str):
            headers["MCP-Name"] = params["name"]
    if PROTOCOL_VERSION["value"]:
        headers["MCP-Protocol-Version"] = PROTOCOL_VERSION["value"]
    req = urllib.request.Request(BASE_URL + "/mcp", data=raw, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            payload = res.read()
            if res.status == 202 or not payload:
                return
            ctype = (res.headers.get("Content-Type") or "").lower()
            text = payload.decode("utf-8")
            if "text/event-stream" in ctype:
                for item in parse_sse(text):
                    write_message(item)
            else:
                obj = json.loads(text)
                if isinstance(obj, list):
                    for item in obj:
                        write_message(item)
                else:
                    write_message(obj)
    except urllib.error.HTTPError as exc:
        if exc.code == 401 and retry_auth:
            ACCESS["token"] = None
            ACCESS["expires_at"] = 0
            forward(message, retry_auth=False)
            return
        rpc_error(request_id, "Agent Access upstream HTTP {}".format(exc.code))
    except Exception as exc:
        rpc_error(request_id, "Agent Access connection failed: {}".format(type(exc).__name__))


def serve_stdio():
    if not load_refresh_token():
        sys.stderr.write("webagenttools-home: " + PAIRING_REQUIRED_MESSAGE + "\n")
        sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        forward(message)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--forget-local", action="store_true")
    args = parser.parse_args()
    if args.pair:
        return pair()
    if args.status:
        return status_cmd()
    if args.forget_local:
        try:
            os.remove(STATE_PATH)
        except FileNotFoundError:
            pass
        print("Local Agent Access credential removed. Server-side grant is unchanged.")
        return 0
    return serve_stdio()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        sys.stderr.write("webagenttools-home: {}\n".format(exc))
        sys.exit(1)
