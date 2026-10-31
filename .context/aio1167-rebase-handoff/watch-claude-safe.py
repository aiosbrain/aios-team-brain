#!/usr/bin/env python3
"""Tail a Claude stream as safe event summaries and emit local checkpoint/quota deadlines."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def _has_public_text(event: dict) -> bool:
    message = event.get("message") or {}
    return any(
        isinstance(item, dict)
        and item.get("type") == "text"
        and isinstance(item.get("text"), str)
        and item["text"].strip()
        for item in (message.get("content") or [])
    )


def _is_terminal_event(event: dict) -> tuple[bool, str, bool, str | None, str | None]:
    """Recognize both stream-json results and persisted Claude Code turns."""
    if event.get("type") == "result":
        subtype = str(event.get("subtype") or "unknown")
        is_error = bool(event.get("is_error")) or subtype != "success"
        return True, subtype, is_error, None, event.get("timestamp")
    if event.get("type") == "assistant":
        message = event.get("message") or {}
        # A reasoning block can itself end with end_turn before the public text
        # block is persisted. Only the final text-bearing assistant message is
        # the turn's terminal result.
        if message.get("stop_reason") == "end_turn" and _has_public_text(event):
            return True, "end_turn", False, message.get("model"), event.get("timestamp")
    return False, "", False, None, None


def _is_user_prompt(event: dict) -> bool:
    if event.get("type") != "user":
        return False
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else message
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(
            isinstance(item, dict)
            and item.get("type") == "text"
            and isinstance(item.get("text"), str)
            and item["text"].strip()
            for item in content
        )
    return False


def _attach_existing(stream: Path) -> tuple[int, bool]:
    """Scan metadata only, report a completed last turn, or attach at EOF."""
    prompt_index = -1
    terminal_index = -1
    terminal = ("", False, None, None)
    offset = 0
    if not stream.exists():
        print("0s ATTACHED state=waiting-for-stream", flush=True)
        return 0, False
    with stream.open("rb") as handle:
        for index, raw in enumerate(handle):
            offset += len(raw)
            try:
                event = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if _is_user_prompt(event):
                prompt_index = index
            is_terminal, subtype, is_error, model, timestamp = _is_terminal_event(event)
            if is_terminal:
                terminal_index = index
                terminal = (subtype, is_error, model, timestamp)
    if terminal_index > prompt_index:
        subtype, is_error, model, timestamp = terminal
        suffix = f" model={model}" if model else ""
        when = f" timestamp={timestamp}" if timestamp else ""
        state = "FAILED" if is_error else "FINISHED"
        print(f"0s WORKER_{state} subtype={subtype} is_error={str(is_error).lower()}{suffix}{when}", flush=True)
        return offset, True
    print("0s ATTACHED state=active-or-awaiting-terminal", flush=True)
    return offset, False


def main() -> int:
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--attach-existing"):
        print("usage: watch-claude-safe.py STREAM.jsonl MINUTES_SINCE_USAGE [--attach-existing]", file=sys.stderr)
        return 2
    stream = Path(sys.argv[1])
    usage_minutes = int(sys.argv[2])
    start = time.monotonic()
    checkpoint_due = start + 10 * 60
    quota_due = start + usage_minutes * 60
    checkpoint_sent = quota_sent = False
    offset = 0
    if len(sys.argv) == 4:
        offset, already_terminal = _attach_existing(stream)
        if already_terminal:
            return 0
    while True:
        try:
            with stream.open("rb") as handle:
                handle.seek(offset)
                for raw in handle:
                    offset += len(raw)
                    try:
                        event = json.loads(raw)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    kind = event.get("type")
                    elapsed = int(time.monotonic() - start)
                    if kind == "system" and event.get("subtype") == "init":
                        print(f"{elapsed}s INIT model={event.get('model')} apiKeySource={event.get('apiKeySource')} mcp={len(event.get('mcp_servers') or [])}", flush=True)
                    elif kind == "assistant":
                        for item in (event.get("message") or {}).get("content") or []:
                            if item.get("type") != "tool_use":
                                continue
                            name = item.get("name", "tool")
                            args = item.get("input") or {}
                            path = args.get("file_path") or args.get("path")
                            suffix = f" path={path}" if isinstance(path, str) else ""
                            print(f"{elapsed}s TOOL {name}{suffix}", flush=True)
                    terminal, subtype, is_error, model, timestamp = _is_terminal_event(event)
                    if terminal:
                        suffix = f" model={model}" if model else ""
                        when = f" timestamp={timestamp}" if timestamp else ""
                        state = "FAILED" if is_error else "FINISHED"
                        print(f"{elapsed}s WORKER_{state} subtype={subtype} is_error={str(is_error).lower()}{suffix}{when}", flush=True)
                        return 0 if not is_error else 1
        except FileNotFoundError:
            pass
        now = time.monotonic()
        if not checkpoint_sent and now >= checkpoint_due:
            print(f"{int(now-start)}s CHECKPOINT_DUE (local durable checkpoint required)", flush=True)
            checkpoint_sent = True
        if not quota_sent and now >= quota_due:
            print(f"{int(now-start)}s QUOTA_CHECK_DUE (read subscription /usage)", flush=True)
            quota_sent = True
        time.sleep(1.0)


if __name__ == "__main__":
    raise SystemExit(main())
