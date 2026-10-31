#!/usr/bin/env python3
"""Filter Claude stream-json to a review text file and safe live activity."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


root = Path(sys.argv[1])
tag = sys.argv[2]
text_path = root / f"{tag}.text"
activity_path = root / f"{tag}.activity.log"
meta_path = root / f"{tag}.meta.json"
assistant_text: list[str] = []
partial_text: list[str] = []
meta: dict[str, Any] = {"assistant_text_chars": 0, "partial_text_chars": 0}


def log(message: str) -> None:
    with activity_path.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, flush=True)


def tool_event(block: dict[str, Any]) -> None:
    data = block.get("input") or {}
    target = data.get("file_path") or data.get("path") or ""
    name = str(block.get("name") or "unknown")
    log(f"tool {name} {target}".rstrip())


for line in sys.stdin:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        log("unparsed stream event (content omitted)")
        continue

    kind = event.get("type")
    if kind == "system" and event.get("subtype") == "init":
        meta.update(
            model=event.get("model"),
            session_id=event.get("session_id"),
            tools=event.get("tools"),
        )
        log(f"worker initialized model={meta.get('model')} session={meta.get('session_id')}")
    elif kind == "assistant":
        message = event.get("message") or {}
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = str(block.get("text") or "")
                if text:
                    assistant_text.append(text)
                    meta["assistant_text_chars"] += len(text)
                    log(f"assistant text available chars={len(text)} (content withheld from live view)")
            elif block.get("type") == "tool_use":
                tool_event(block)
    elif kind == "stream_event":
        frame = event.get("event") or {}
        if frame.get("type") == "content_block_start":
            block = frame.get("content_block") or {}
            if block.get("type") == "tool_use":
                tool_event(block)
        elif frame.get("type") == "content_block_delta":
            delta = frame.get("delta") or {}
            if delta.get("type") == "text_delta":
                text = str(delta.get("text") or "")
                if text:
                    partial_text.append(text)
                    meta["partial_text_chars"] += len(text)
        elif frame.get("type") == "message_delta":
            delta = frame.get("delta") or {}
            if delta.get("stop_reason"):
                meta["last_stop_reason"] = delta["stop_reason"]
    elif kind == "result":
        meta.update(
            subtype=event.get("subtype"),
            is_error=event.get("is_error"),
            num_turns=event.get("num_turns"),
            stop_reason=event.get("stop_reason"),
            terminal_reason=event.get("terminal_reason"),
            usage=event.get("usage"),
            model_usage=event.get("modelUsage"),
        )
        result = event.get("result")
        if isinstance(result, str) and result.strip():
            final_text = result
            meta["text_source"] = "result"
        elif assistant_text:
            final_text = "\n\n".join(assistant_text)
            meta["text_source"] = "assistant_text_blocks"
        else:
            final_text = "".join(partial_text)
            meta["text_source"] = "stream_text_deltas" if final_text else "empty"
        text_path.write_text(final_text, encoding="utf-8")
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        log(
            f"terminal result={meta.get('subtype')} error={meta.get('is_error')} "
            f"turns={meta.get('num_turns')} text_source={meta['text_source']} chars={len(final_text)}"
        )

if not meta_path.exists():
    if assistant_text:
        final_text = "\n\n".join(assistant_text)
        meta["text_source"] = "assistant_text_blocks_without_terminal_result"
    else:
        final_text = "".join(partial_text)
        meta["text_source"] = "stream_text_deltas_without_terminal_result" if final_text else "no_result_event"
    text_path.write_text(final_text, encoding="utf-8")
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"stream ended without a terminal result; text_source={meta['text_source']} chars={len(final_text)}")
