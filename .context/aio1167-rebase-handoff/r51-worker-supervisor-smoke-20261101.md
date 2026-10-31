# Safe worker supervisor smoke results

- Python syntax compile passed for `watch-claude-safe.py`.
- Synthetic persisted transcript: ignored a thinking-only `end_turn`, recognized following assistant text `end_turn`, returned `WORKER_FINISHED`, did not print reasoning text.
- Synthetic stream-json result: returned `WORKER_FINISHED subtype=success`.
- Synthetic active transcript: emitted `ATTACHED state=active-or-awaiting-terminal` and remained attached; test stopped the monitor after the state line.
- Existing writer transcript attached at EOF and emitted `WORKER_FINISHED subtype=end_turn is_error=false model=claude-opus-5-5 timestamp=2026-10-31T18:10:06.618Z`; no transcript reasoning was replayed.
- This confirms that an open/idle Claude TUI process is not treated as an active model turn.
