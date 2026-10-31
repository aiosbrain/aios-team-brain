# Fable dispatch attempt 1 — stopped before verdict

- The first Fable 5.1 CLI attempt used only `Read,Glob,Grep` with strict empty MCP and no persistence.
- Its safe activity stream showed it reading the prior source-worktree packet `r51-fable-correction-delta-20261031T1932Z` rather than this new correction packet. That prior packet pinned a different candidate. No verdict was accepted.
- Coordinator sent SIGTERM to the model process (PID 66385); the supervisor recorded exit 143. The corresponding safe watcher was stopped. The partial event stream remains local and is not included in the remote checkpoint.
- Corrective action: this packet's prompt now gives the exact absolute packet directory and exact file names, explicitly rejects older packets, and the next invocation grants read access to this packet directory with `--add-dir`. The next review must use a fresh Fable session and verify its `system/init` model before accepting a verdict.
