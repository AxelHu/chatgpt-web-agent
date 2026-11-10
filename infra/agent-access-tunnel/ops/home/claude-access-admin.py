#!/usr/bin/env python3
"""Operate the private Claude grant store through the existing trusted SSH host."""

import argparse
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("pairings", help="Show pending requests and their bound OAuth metadata")
    actions.add_parser("clients", help="Show revocable grants, without credentials")
    actions.add_parser("approve", help="Approve the code displayed in your own authorization browser").add_argument("user_code")
    actions.add_parser("revoke", help="Revoke one exact grant").add_argument("client_id")
    args = parser.parse_args()
    remote = [
        "sudo", "-n", "-u", "agentaccess", "env",
        "AGENT_ACCESS_STATE_DIR=/var/lib/agent-access-claude",
        "AGENT_ACCESS_PUBLIC_BASE=https://sites.axelhu.com/agent-access-claude",
        "AGENT_ACCESS_PROFILES=claude",
        "AGENT_ACCESS_OAUTH_ENABLED=true",
        "AGENT_ACCESS_OAUTH_PROFILE=claude",
        "/usr/bin/python3", "/opt/agent-access-claude/current/gateway/admin.py",
        "oauth-requests" if args.action == "pairings" else args.action,
    ]
    if args.action == "approve":
        remote.append(args.user_code)
    elif args.action == "revoke":
        remote.append(args.client_id)
    result = subprocess.run([
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "tencent-cloud-2", shlex.join(remote),
    ], check=False)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
