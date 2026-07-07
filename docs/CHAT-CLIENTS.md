# Chat clients — using `conversation_id` (CLI, Telegram/Hermes)

The brain is the **system of record** for chat. Conversations persist server-side, keyed by
`conversation_id` and **owned by a member** — so the CLI and the Telegram-via-Hermes agent can
continue the *same* threads as the web dashboard (they show up in that member's sidebar too),
as long as they use an API key tied to that member.

The **server side is already built** (`/api/v1/query` accepts `conversation_id`, persists each
turn, loads a windowed history, auto-titles new threads). What remains is the **client side**:
capture, persist, and resend the `conversation_id`. This doc is the contract + integration plan.

## The wire contract — `POST /api/v1/query`

Auth: `Authorization: Bearer <api_key>` (the key's member owns any conversation it touches).

Request body:
```jsonc
{
  "question": "what did he finish last week?",
  "conversation_id": "…uuid…",   // OPTIONAL — omit to start a new thread
  "project": null                 // optional retrieval scope
}
```

Response: **SSE stream** (`text/event-stream`) with these events:
```
event: conversation      data: { "id": "…uuid…" }        ← FIRST; the thread this turn belongs to
event: delta             data: { "text": "…" }            ← answer chunks (repeat)
event: sources           data: { "sources": [ … ] }       ← cited items
event: done              data: { "input_tokens": …, "cost_usd": … }
event: error             data: { "message": "…" }         ← on failure (instead of done)
```

Server behavior you rely on:
- **Omit `conversation_id`** → the server creates a thread and returns its id in the `conversation`
  event. **Capture it.**
- **Send `conversation_id`** → the server loads the **windowed history** (last ~6 turns, truncated)
  so pronouns/follow-ups resolve. No need to send history yourself.
- Ownership is enforced: a key can only continue **its own member's** conversations; an unknown or
  someone else's id is treated as "start new" (you'll get a fresh id back).
- New threads get an **auto-generated title** shortly after the first answer (no client action).

## Client responsibilities (the pattern)

1. On a **new** chat, send no `conversation_id`.
2. Read the **`conversation` event** and remember its `id`.
3. On the **next turn of the same chat**, send that `id`.
4. Persist the id keyed by whatever "chat" means for your surface (a CLI session, a Telegram chat).

## CLI (`aios`)

- Store the current thread id in a small state file, e.g. `~/.aios/chat.json`:
  `{ "conversation_id": "…", "updated_at": "…" }` (optionally keyed by cwd/project).
- `aios chat "<question>"` → send the stored `conversation_id`; update it from the `conversation`
  event. `aios chat --new` → clear it first (start a fresh thread).
- `aios chat --list` → **`GET /api/v1/conversations`** (API-key) returns the key member's threads
  (`id`, `title`, `updated_at`), newest-active first. `aios chat --resume <id>` →
  **`GET /api/v1/conversations/:id`** re-hydrates the full message history, then continue by sending
  that `conversation_id` on the next `POST /api/v1/query`.

## Telegram via Hermes (the box on Fly.io)

Goal: a Telegram conversation is one continuous brain thread (and appears in the member's web
sidebar). Map **Telegram chat → brain `conversation_id`** on the Hermes box:

- Keep a persistent map `telegram_chat_id → conversation_id` (SQLite/KV on the box). If Telegram
  **topics/threads** are used, key on `(chat_id, message_thread_id)`.
- On an inbound Telegram message:
  1. Look up the `conversation_id` for that chat (may be absent).
  2. `POST /api/v1/query` with the question (+ the id if present), using the API key of **the member
     this Telegram user maps to** (so threads land in the right person's history).
  3. From the `conversation` event, **upsert** `telegram_chat_id → id` (covers the first message,
     which had no id).
  4. Stream the `delta`s back to Telegram (edit-in-place or send on `done`).
- A "/new" command clears the mapping for that chat to start fresh.

Auth mapping note: one API key = one member = one owner of threads. If multiple Telegram users
share one Hermes key, their chats all land under that one member (fine for a single-user assistant;
for multi-user, issue a key per member and pick it by Telegram user).

## Not yet on the server (say the word)
- API-key **rename/delete** of a conversation (the session-authed dashboard has `PATCH`/`DELETE`;
  the API-key list/get are built, management verbs are a small add).
- API-key **search** — the dashboard supports it (`GET /api/dashboard/conversations?q=` matches title
  OR message content via FTS); the API-key `GET /api/v1/conversations` doesn't take `q` yet.
