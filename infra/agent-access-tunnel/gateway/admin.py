#!/usr/bin/env python3
import argparse
import json
import sys

from agent_access_gateway import build_state_from_env


def main():
    parser = argparse.ArgumentParser(description="Agent Access Gateway operator CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    approve = sub.add_parser("approve")
    approve.add_argument("user_code")
    revoke = sub.add_parser("revoke")
    revoke.add_argument("client_id")
    sub.add_parser("pairings")
    sub.add_parser("clients")
    args = parser.parse_args()

    state = build_state_from_env()
    if args.command == "approve":
        print(json.dumps({"client_id": state.approve_pairing(args.user_code)}, indent=2))
    elif args.command == "revoke":
        ok = state.revoke_client(args.client_id)
        print(json.dumps({"revoked": ok, "client_id": args.client_id}, indent=2))
        if not ok:
            sys.exit(1)
    elif args.command == "pairings":
        print(json.dumps(state.list_pairings(), indent=2))
    elif args.command == "clients":
        print(json.dumps(state.list_clients(), indent=2))


if __name__ == "__main__":
    main()
