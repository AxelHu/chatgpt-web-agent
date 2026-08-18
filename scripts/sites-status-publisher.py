#!/usr/bin/env python3
"""Collect lightweight local health/Codex quota state and publish it to a ChatGPT Site.

The publisher intentionally separates collection from transport:
- Codex quota/usage is read through codex app-server account/* RPCs (no model turn).
- Local service/Gitea/host checks are bounded and best-effort.
- Publishing requires a Sites SIWC bypass token plus a separate ingest key, both read
  from local files. Secret values are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
COLLECTOR_VERSION = "0.1.0"
DEFAULT_SERVICES = (
    "openclaw-gateway.service",
    "openai-tunnel-chatgpt-web-agent.service",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_from_unix(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def error_text(exc: BaseException, limit: int = 200) -> str:
    text = f"{type(exc).__name__}: {exc}"
    return text[:limit]


def run_text(command: list[str], timeout: float = 3.0) -> str:
    result = subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=timeout,
    )
    return result.stdout.strip()


def read_secret(path: str | None) -> str:
    if not path:
        raise RuntimeError("secret file path is not configured")
    value = Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"secret file is empty: {path}")
    return value


def collect_host() -> dict[str, Any]:
    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        mem: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            value = raw.strip().split()[0]
            if value.isdigit():
                mem[key] = int(value) * 1024
        total = mem.get("MemTotal", 0)
        available = mem.get("MemAvailable", 0)
        memory_used_percent = round((1 - available / total) * 100, 1) if total else None
        disk = shutil.disk_usage("/")
        load1, load5, load15 = os.getloadavg()
        return {
            "ok": True,
            "uptime_sec": round(uptime),
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
            "memory_used_percent": memory_used_percent,
            "disk_used_percent": round((disk.used / disk.total) * 100, 1) if disk.total else None,
            "disk_free_gib": round(disk.free / (1024**3), 1),
        }
    except Exception as exc:  # best-effort collector
        return {"ok": False, "error": error_text(exc)}


def collect_service(name: str) -> dict[str, Any]:
    try:
        state = run_text(["systemctl", "--user", "is-active", name], timeout=2.0)
        enabled = None
        try:
            enabled = run_text(["systemctl", "--user", "is-enabled", name], timeout=2.0)
        except Exception:
            pass
        return {"ok": state == "active", "state": state, "enabled": enabled}
    except subprocess.CalledProcessError as exc:
        return {"ok": False, "state": (exc.stdout or "inactive").strip() or "inactive"}
    except Exception as exc:
        return {"ok": False, "state": "unknown", "error": error_text(exc)}


def collect_services(names: tuple[str, ...]) -> dict[str, Any]:
    return {name: collect_service(name) for name in names}


def open_json(url: str, *, token: str | None = None, timeout: float = 3.0) -> tuple[Any, Any]:
    headers = {"Accept": "application/json", "User-Agent": "chatgpt-sites-status-publisher/0.1"}
    if token:
        headers["Authorization"] = f"token {token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response), response.headers


def total_count(headers: Any, data: Any) -> int | None:
    raw = headers.get("X-Total-Count") if headers is not None else None
    if raw and str(raw).isdigit():
        return int(raw)
    return len(data) if isinstance(data, list) else None


def collect_gitea(base_url: str | None, token_path: str | None, repo: str | None) -> dict[str, Any]:
    if not base_url or not repo or "/" not in repo:
        return {"ok": False, "error": "gitea is not configured"}
    result: dict[str, Any] = {"ok": False, "repo": repo}
    try:
        health, _ = open_json(base_url.rstrip("/") + "/api/healthz", timeout=2.0)
        result["health"] = health.get("status") if isinstance(health, dict) else "unknown"
        token = read_secret(token_path) if token_path else None
        owner, name = repo.split("/", 1)
        root = f"{base_url.rstrip('/')}/api/v1/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"
        issues, ih = open_json(root + "/issues?state=open&type=issues&limit=1", token=token, timeout=3.0)
        pulls, ph = open_json(root + "/pulls?state=open&limit=1", token=token, timeout=3.0)
        result.update(
            ok=result.get("health") == "pass",
            open_issues=total_count(ih, issues),
            open_prs=total_count(ph, pulls),
        )
        return result
    except Exception as exc:
        result["error"] = error_text(exc)
        return result


def collect_repo(path: str | None) -> dict[str, Any]:
    if not path:
        return {"ok": False, "error": "repo path is not configured"}
    try:
        branch = run_text(["git", "-C", path, "branch", "--show-current"], timeout=2.0)
        head = run_text(["git", "-C", path, "rev-parse", "--short=12", "HEAD"], timeout=2.0)
        status = run_text(["git", "-C", path, "status", "--porcelain"], timeout=2.0)
        return {"ok": True, "branch": branch, "head": head, "clean": not bool(status)}
    except Exception as exc:
        return {"ok": False, "error": error_text(exc)}


class AppServerClient:
    def __init__(self, codex_bin: str, timeout: float = 15.0):
        self.timeout = timeout
        self.next_id = 1
        self.process = subprocess.Popen(
            [codex_bin, "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)

    def request(self, method: str, params: Any = None) -> Any:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("codex app-server pipes are unavailable")
        request_id = self.next_id
        self.next_id += 1
        payload: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        stdout_fd = self.process.stdout.fileno()
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([stdout_fd], [], [], min(remaining, 0.5))
            if not ready:
                if self.process.poll() is not None:
                    raise RuntimeError(f"codex app-server exited with code {self.process.returncode}")
                continue
            line = self.process.stdout.readline()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(f"app-server RPC failed: {message['error']}")
            return message.get("result")
        raise TimeoutError(f"codex app-server RPC timed out: {method}")


def project_rate_limit(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    primary = raw.get("primary") if isinstance(raw.get("primary"), dict) else None
    credits = raw.get("credits") if isinstance(raw.get("credits"), dict) else None
    projected: dict[str, Any] = {
        "limit_id": raw.get("limitId"),
        "limit_name": raw.get("limitName"),
        "plan_type": raw.get("planType"),
        "rate_limit_reached_type": raw.get("rateLimitReachedType"),
    }
    if primary:
        used = primary.get("usedPercent")
        projected["used_percent"] = used
        projected["remaining_percent"] = max(0, 100 - used) if isinstance(used, int) else None
        projected["window_minutes"] = primary.get("windowDurationMins")
        projected["resets_at_unix"] = primary.get("resetsAt")
        projected["resets_at"] = iso_from_unix(primary.get("resetsAt"))
    if credits:
        projected["credits"] = {
            "has_credits": credits.get("hasCredits"),
            "unlimited": credits.get("unlimited"),
            "balance": credits.get("balance"),
        }
    return projected


def collect_codex(codex_bin: str) -> dict[str, Any]:
    started = time.monotonic()
    client: AppServerClient | None = None
    try:
        client = AppServerClient(codex_bin)
        client.request("initialize", {"clientInfo": {"name": "sites-status-publisher", "version": COLLECTOR_VERSION}})
        limits = client.request("account/rateLimits/read")
        usage = client.request("account/usage/read")
        by_id: dict[str, Any] = {}
        raw_by_id = limits.get("rateLimitsByLimitId") if isinstance(limits, dict) else None
        if isinstance(raw_by_id, dict):
            for key, value in raw_by_id.items():
                projected = project_rate_limit(value)
                if projected is not None:
                    by_id[str(key)] = projected
        if not by_id and isinstance(limits, dict):
            projected = project_rate_limit(limits.get("rateLimits"))
            if projected:
                by_id[str(projected.get("limit_id") or "codex")] = projected
        summary = usage.get("summary") if isinstance(usage, dict) and isinstance(usage.get("summary"), dict) else {}
        return {
            "ok": True,
            "limits": by_id,
            "usage": {
                "lifetime_tokens": summary.get("lifetimeTokens"),
                "peak_daily_tokens": summary.get("peakDailyTokens"),
                "current_streak_days": summary.get("currentStreakDays"),
                "longest_streak_days": summary.get("longestStreakDays"),
            },
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": error_text(exc),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    finally:
        if client is not None:
            client.close()


def configured_services() -> tuple[str, ...]:
    raw = os.getenv("CHATGPT_SITES_STATUS_SERVICES")
    if not raw:
        return DEFAULT_SERVICES
    return tuple(value.strip() for value in raw.split(",") if value.strip())


def build_snapshot() -> dict[str, Any]:
    started = time.monotonic()
    codex_bin = os.getenv("CHATGPT_SITES_STATUS_CODEX_BIN", "/home/axelhu/.npm-global/bin/codex")
    snapshot: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "collector_version": COLLECTOR_VERSION,
        "collected_at": utc_now(),
        "host": collect_host(),
        "services": collect_services(configured_services()),
        "codex": collect_codex(codex_bin),
        "gitea": collect_gitea(
            os.getenv("CHATGPT_SITES_STATUS_GITEA_BASE_URL", "http://127.0.0.1:3000"),
            os.getenv("CHATGPT_SITES_STATUS_GITEA_TOKEN_FILE"),
            os.getenv("CHATGPT_SITES_STATUS_GITEA_REPO", "Agents/chatgpt-web-agent"),
        ),
        "repo": collect_repo(os.getenv("CHATGPT_SITES_STATUS_LOCAL_REPO")),
    }
    snapshot["collector"] = {
        "ok": True,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
    }
    return snapshot


def publish(snapshot: dict[str, Any]) -> dict[str, Any]:
    site_url = os.getenv("CHATGPT_SITES_STATUS_SITE_URL")
    if not site_url:
        raise RuntimeError("CHATGPT_SITES_STATUS_SITE_URL is not configured")
    bypass = read_secret(os.getenv("CHATGPT_SITES_STATUS_BYPASS_TOKEN_FILE"))
    ingest_key = read_secret(os.getenv("CHATGPT_SITES_STATUS_INGEST_KEY_FILE"))
    body = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        site_url.rstrip("/") + "/api/status-ingest",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "chatgpt-sites-status-publisher/0.1",
            "OAI-Sites-Authorization": f"Bearer {bypass}",
            "X-Status-Ingest-Key": ingest_key,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15.0) as response:
            raw = response.read(64 * 1024)
            parsed = json.loads(raw) if raw else {}
            return {"http_status": response.status, "response": parsed}
    except urllib.error.HTTPError as exc:
        raw = exc.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(f"site ingest returned HTTP {exc.code}: {raw[:300]}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect-only", action="store_true", help="Print the safe snapshot and do not publish")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print collect-only JSON")
    args = parser.parse_args()

    snapshot = build_snapshot()
    if args.collect_only:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=args.pretty))
        return 0

    try:
        result = publish(snapshot)
    except Exception as exc:
        print(f"status publish failed: {error_text(exc)}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "collected_at": snapshot["collected_at"],
                "collector_elapsed_ms": snapshot.get("collector", {}).get("elapsed_ms"),
                "site_http_status": result.get("http_status"),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
