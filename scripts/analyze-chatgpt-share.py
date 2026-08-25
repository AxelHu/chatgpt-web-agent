#!/usr/bin/env python3
"""Inspect a public ChatGPT share snapshot without relying on the rendered UI.

The current ChatGPT share page serializes conversation state as a flattened
React Router reference table. This script extracts that table, walks the
current linear branch, and reports structural metrics useful for studying
long/tool-heavy ChatGPT Web conversations.

The public share intentionally redacts many connector/tool payloads. Token
metrics are therefore lower-bound / visible-prefix metrics, not billing usage.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import statistics
import sys
import urllib.request
from pathlib import Path
from typing import Any

REDACTED = "The output of this plugin was redacted."
CUSTOM_INSTRUCTIONS_PLACEHOLDER = "Original custom instructions no longer available"


def load_html(source: str) -> str:
    if source.startswith(("https://", "http://")):
        req = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as response:  # nosec - explicit user URL
            return response.read().decode("utf-8", errors="replace")
    return Path(source).read_text(encoding="utf-8", errors="replace")


def extract_flat_payload(html: str) -> list[Any]:
    scripts = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", html, flags=re.I | re.S)
    for script in scripts:
        if "streamController.enqueue" not in script:
            continue
        # Share pages currently place the large flattened state in one enqueue call.
        match = re.search(r"streamController\.enqueue\((\".*\")\);?\s*$", script, flags=re.S)
        if not match:
            continue
        try:
            decoded = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        first_line = decoded.split("\n", 1)[0]
        if not first_line.lstrip().startswith("["):
            continue
        payload = json.loads(first_line)
        if isinstance(payload, list):
            return payload
    raise RuntimeError("Could not locate flattened ChatGPT share payload")


class FlatState:
    def __init__(self, payload: list[Any]):
        self.payload = payload

    def value(self, value: Any) -> Any:
        if isinstance(value, int) and 0 <= value < len(self.payload):
            return self.payload[value]
        return value

    def dict(self, value: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, item in value.items():
            decoded_key: Any = key
            if isinstance(key, str) and key.startswith("_") and key[1:].isdigit():
                decoded_key = self.value(int(key[1:]))
            out[str(decoded_key)] = self.value(item)
        return out

    def root(self) -> dict[str, Any]:
        for item in self.payload:
            if not isinstance(item, dict):
                continue
            decoded = self.dict(item)
            if isinstance(decoded.get("mapping"), dict) and isinstance(decoded.get("linear_conversation"), list):
                return decoded
        raise RuntimeError("Conversation root not found")

    def deep_strings(self, value: Any, depth: int = 0) -> list[str]:
        if depth > 12:
            return []
        value = self.value(value)
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            out: list[str] = []
            for item in value:
                out.extend(self.deep_strings(item, depth + 1))
            return out
        if isinstance(value, dict):
            out: list[str] = []
            for item in self.dict(value).values():
                out.extend(self.deep_strings(item, depth + 1))
            return out
        return []


def message_text(state: FlatState, content: dict[str, Any]) -> str:
    content_type = content.get("content_type")
    if content_type == "multimodal_text":
        # Do not recursively stringify image/file objects; only count direct text parts.
        parts = state.value(content.get("parts", []))
        if not isinstance(parts, list):
            return ""
        return "\n".join(state.value(item) for item in parts if isinstance(state.value(item), str))

    fields = {
        "text": ["parts"],
        "code": ["text"],
        "thoughts": ["thoughts"],
        "reasoning_recap": ["content"],
        "execution_output": ["text"],
        "model_editable_context": ["model_set_context"],
    }.get(content_type, ["parts", "text"])
    strings: list[str] = []
    for field in fields:
        if field in content:
            strings.extend(state.deep_strings(content[field]))
    return "\n".join(item for item in strings if item)


def parse_rows(state: FlatState, root: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    linear = state.value(root["linear_conversation"])
    for position, node_ref in enumerate(linear):
        node_raw = state.value(node_ref)
        if not isinstance(node_raw, dict):
            continue
        node = state.dict(node_raw)
        message_raw = node.get("message")
        if not isinstance(message_raw, dict):
            continue
        message = state.dict(message_raw)
        author = state.dict(message["author"]) if isinstance(message.get("author"), dict) else {}
        content = state.dict(message["content"]) if isinstance(message.get("content"), dict) else {}
        metadata = state.dict(message["metadata"]) if isinstance(message.get("metadata"), dict) else {}
        rows.append(
            {
                "position": position,
                "node_id": node.get("id"),
                "parent": node.get("parent"),
                "role": author.get("role"),
                "tool_name": author.get("name"),
                "content_type": content.get("content_type"),
                "text": message_text(state, content),
                "recipient": message.get("recipient"),
                "channel": metadata.get("channel"),
                "turn": metadata.get("turn_exchange_id"),
                "request_id": metadata.get("request_id"),
                "create_time": message.get("create_time"),
                "end_turn": message.get("end_turn"),
                "status": message.get("status"),
                "reasoning_start_time": metadata.get("reasoning_start_time"),
                "reasoning_end_time": metadata.get("reasoning_end_time"),
                "finished_duration_sec": metadata.get("finished_duration_sec"),
                "model": metadata.get("model_slug") or metadata.get("resolved_model_slug"),
                "thinking_effort": metadata.get("thinking_effort"),
            }
        )
    return rows


def ordered_turns(rows: list[dict[str, Any]]) -> list[str]:
    order: list[str] = []
    for row in rows:
        turn = row.get("turn")
        if turn and turn not in order:
            order.append(turn)
    return order


def turn_metrics(rows: list[dict[str, Any]], turn_order: list[str]) -> list[dict[str, Any]]:
    result = []
    for index, turn in enumerate(turn_order, 1):
        items = [row for row in rows if row.get("turn") == turn]
        users = [row for row in items if row["role"] == "user"]
        calls = [row for row in items if row["role"] == "assistant" and row.get("recipient") not in (None, "all")]
        tools = [row for row in items if row["role"] == "tool"]
        finals = [
            row
            for row in items
            if row["role"] == "assistant"
            and row["content_type"] == "text"
            and (row.get("channel") == "final" or row.get("end_turn") is True)
        ]
        durations = [
            row["finished_duration_sec"]
            for row in items
            if isinstance(row.get("finished_duration_sec"), (int, float))
            and not isinstance(row.get("finished_duration_sec"), bool)
        ]
        timestamps = [row["create_time"] for row in items if isinstance(row.get("create_time"), (int, float))]
        result.append(
            {
                "index": index,
                "turn_exchange_id": turn,
                "nodes": len(items),
                "user_messages": len(users),
                "tool_calls": len(calls),
                "tool_results": len(tools),
                "final_text_messages": len(finals),
                "finished_duration_sec": max(durations) if durations else None,
                "observed_span_sec": max(timestamps) - min(timestamps) if timestamps else None,
                "user_preview": users[0]["text"][:160] if users else "",
            }
        )
    return result


def model_continuation_prefixes(rows: list[dict[str, Any]], token_key: str) -> tuple[list[int], list[int]]:
    state: dict[str, dict[str, bool]] = {}
    prefix = 0
    continuations: list[int] = []
    turn_starts: list[int] = []
    seen_turns: set[str] = set()
    for row in rows:
        turn = row.get("turn")
        if turn:
            turn_state = state.setdefault(turn, {"started": False, "tool_since": False})
            if row["role"] == "assistant":
                if not turn_state["started"]:
                    continuations.append(prefix)
                    turn_state["started"] = True
                    turn_state["tool_since"] = False
                    if turn not in seen_turns:
                        turn_starts.append(prefix)
                        seen_turns.add(turn)
                elif turn_state["tool_since"]:
                    continuations.append(prefix)
                    turn_state["tool_since"] = False
            elif row["role"] == "tool":
                turn_state["tool_since"] = True
        prefix += int(row[token_key])
    return continuations, turn_starts


def add_token_metrics(rows: list[dict[str, Any]], result: dict[str, Any]) -> None:
    try:
        import tiktoken  # type: ignore

        encoding = tiktoken.get_encoding("o200k_base")
    except Exception as exc:  # optional dependency / older tiktoken
        result["tokens"] = {"available": False, "reason": str(exc)}
        return

    for row in rows:
        row["o200k_tokens"] = len(encoding.encode(row["text"]))
    continuations, turn_starts = model_continuation_prefixes(rows, "o200k_tokens")
    real_users = [
        row
        for row in rows
        if row["role"] == "user" and not row["text"].startswith(CUSTOM_INSTRUCTIONS_PLACEHOLDER)
    ]
    result["tokens"] = {
        "available": True,
        "encoding": "o200k_base",
        "visible_static_tokens": sum(row["o200k_tokens"] for row in rows),
        "visible_tokens_by_role": {
            role: sum(row["o200k_tokens"] for row in rows if row["role"] == role)
            for role in ("user", "assistant", "tool", "system")
        },
        "real_user_tokens": sum(row["o200k_tokens"] for row in real_users),
        "assistant_visible_tokens_excluding_redaction": sum(
            row["o200k_tokens"]
            for row in rows
            if row["role"] == "assistant" and row["text"] != REDACTED
        ),
        "model_continuations": len(continuations),
        "visible_prefix_input_equivalent_tokens": sum(continuations),
        "turn_start_visible_input_equivalent_tokens": sum(turn_starts),
    }


def load_payload(source: str) -> tuple[list[Any], int | None]:
    if not source.startswith(("https://", "http://")) and Path(source).suffix.lower() == ".json":
        payload = json.loads(Path(source).read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise RuntimeError("Flattened payload JSON must contain a top-level list")
        return payload, None
    html = load_html(source)
    return extract_flat_payload(html), len(html.encode("utf-8"))


def analyze(source: str) -> dict[str, Any]:
    payload, html_bytes = load_payload(source)
    state = FlatState(payload)
    root = state.root()
    rows = parse_rows(state, root)
    turn_order = ordered_turns(rows)
    turns = turn_metrics(rows, turn_order)
    real_users = [
        row for row in rows if row["role"] == "user" and not row["text"].startswith(CUSTOM_INSTRUCTIONS_PLACEHOLDER)
    ]
    redacted = [row for row in rows if row["text"] == REDACTED]
    calls = [
        row
        for row in rows
        if row["turn"] and row["role"] == "assistant" and row.get("recipient") not in (None, "all")
    ]
    result: dict[str, Any] = {
        "source": source,
        "html_bytes": html_bytes,
        "flat_slots": len(payload),
        "title": root.get("title"),
        "conversation_id": root.get("conversation_id"),
        "backing_conversation_id": root.get("backing_conversation_id"),
        "default_model_slug": root.get("default_model_slug"),
        "share_create_time": root.get("create_time"),
        "share_update_time": root.get("update_time"),
        "current_node": root.get("current_node"),
        "linear_nodes": len(state.value(root["linear_conversation"])),
        "message_nodes": len(rows),
        "role_counts": dict(collections.Counter(row["role"] for row in rows)),
        "real_user_messages": len(real_users),
        "turn_exchanges": len(turn_order),
        "turn_scoped_tool_calls": len(calls),
        "tool_result_nodes": sum(row["role"] == "tool" for row in rows),
        "redacted_nodes": len(redacted),
        "redacted_by_role": dict(collections.Counter(row["role"] for row in redacted)),
        "assistant_recipient_counts": dict(
            collections.Counter(row["recipient"] for row in rows if row["role"] == "assistant")
        ),
        "tool_name_counts": dict(collections.Counter(row["tool_name"] for row in rows if row["role"] == "tool")),
        "turns": turns,
    }
    if turns:
        result["turn_density"] = {
            "nodes_mean": statistics.mean(item["nodes"] for item in turns),
            "nodes_median": statistics.median(item["nodes"] for item in turns),
            "nodes_max": max(item["nodes"] for item in turns),
            "tool_calls_mean": statistics.mean(item["tool_calls"] for item in turns),
            "tool_calls_median": statistics.median(item["tool_calls"] for item in turns),
            "tool_calls_max": max(item["tool_calls"] for item in turns),
        }
    add_token_metrics(rows, result)
    return result


def print_text(result: dict[str, Any]) -> None:
    print(f"title: {result['title']}")
    print(f"conversation: {result['conversation_id']} (backing {result['backing_conversation_id']})")
    print(f"model: {result['default_model_slug']}")
    print(
        f"linear/message nodes: {result['linear_nodes']}/{result['message_nodes']} | "
        f"real users: {result['real_user_messages']} | turns: {result['turn_exchanges']}"
    )
    print(
        f"turn-scoped tool calls: {result['turn_scoped_tool_calls']} | "
        f"tool result nodes: {result['tool_result_nodes']} | redacted: {result['redacted_nodes']}"
    )
    tokens = result.get("tokens", {})
    if tokens.get("available"):
        print(
            "o200k visible static: {visible_static_tokens:,} | continuations: {model_continuations:,} | "
            "visible-prefix input-equivalent: {visible_prefix_input_equivalent_tokens:,}".format(**tokens)
        )
    else:
        print(f"o200k token metrics unavailable: {tokens.get('reason')}")
    if result.get("turns"):
        print("last turns:")
        for item in result["turns"][-8:]:
            print(
                f"  #{item['index']:>2} nodes={item['nodes']:>4} calls={item['tool_calls']:>3} "
                f"tools={item['tool_results']:>3} finals={item['final_text_messages']} "
                f"span={item['observed_span_sec']!s:>8}  {item['user_preview']!r}"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", help="public chatgpt.com/share URL, saved HTML, or flattened payload JSON")
    parser.add_argument("--json", action="store_true", help="emit full JSON metrics")
    args = parser.parse_args()
    result = analyze(args.source)
    if args.json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print_text(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
