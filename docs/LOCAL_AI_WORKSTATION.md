# Local AI Workstation

A private, self-hosted AI stack on a single machine (built/tested on macOS /
Apple Silicon), with the Team Brain as the team-facing query layer. Every layer
can run **fully locally** or fall back to **cloud** — see
[PROVIDERS.md](./PROVIDERS.md) for the brain's provider switches.

```
            ┌────────────────────────── your machine ──────────────────────────┐
 any device │  Hermes Agent (local agent)         aios-team-brain (Next.js)     │
 over   ───▶│     │                                   │                         │
 Tailscale  │     ▼                                   ├─ LLM ──┐                 │
            │  Ollama  ◀──────── OpenAI /v1 ──────────┤        ▼                 │
            │   (local model, e.g. llama3.1 / qwen3)  │   llama.cpp reranker     │
            │                                         │        ▲   (/v1/rerank)  │
            │  llm-wiki (~/wiki, markdown)            └─ retrieval ──┘           │
            │  GBrain (~/.gbrain, embeddings + brain) ─ local nomic-embed-text   │
            └───────────────────────────────────────────────────────────────────┘
```

Each component is independent — adopt only the layers you want.

## Prerequisites

- macOS 13+ on Apple Silicon (Linux works for most pieces too).
- **RAM matters.** A 7–8B model at 64k context ≈ 13 GB; a 35B reasoning model
  ≈ 21–25 GB. On 32–36 GB, prefer an 8B as the everyday driver. Watch memory
  with `ollama ps` and `memory_pressure`.
- Tools: `git`, `node 20+`, `ollama`, `bun` (for GBrain), `brew` (for llama.cpp),
  and `tailscale` (for the private gateway).

---

## 1. Ollama + a local model

```bash
# pull a model; ensure it advertises >=64k context if you'll drive Hermes with it
ollama pull llama3.1:8b
# many models default to a small context — pin it with a Modelfile:
printf 'FROM llama3.1:8b\nPARAMETER num_ctx 65536\n' > Modelfile.64k
ollama create llama3.1-8b-64k -f Modelfile.64k
ollama run llama3.1-8b-64k "hello"   # verify it loads without swapping
```

> Tip: if you updated the Ollama app but `ollama --version` shows a different
> server vs client version, **restart the Ollama daemon** — a stale daemon
> ignores `num_ctx` and can over-allocate context (OOM). Some quant formats
> (e.g. MLX/nvfp4) ignore `num_ctx` entirely and load at native context; cap
> usage at the *client* layer instead (Hermes `context_length`, or the brain's
> own prompt budget).

## 2. Hermes Agent (local agent + private gateway)

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.zshrc
hermes model        # choose "Custom Endpoint": http://localhost:11434/v1, model = your 64k model
hermes              # chat, served entirely by the local model
```

**Private gateway (reach it from any device, no public exposure):** put the
dashboard on the tailnet. The cleanest, cert-free way is to bind it to the
Tailscale IP directly (loopback-trust, so no login; tailnet is the boundary):

```bash
tailscale up
hermes dashboard --insecure --host <your-tailscale-ip> --port 9119 --no-open
# then browse http://<your-tailscale-ip>:9119/ from any device on your tailnet
```

(For always-on, wrap it in a `launchctl` LaunchAgent — see **Persistence**.)

## 3. llm-wiki (knowledge layer)

Hermes ships a built-in `llm-wiki` skill (`hermes skills list`). Or use the
upstream [`nvk/llm-wiki`](https://github.com/nvk/llm-wiki) `AGENTS.md` with any
agent. Wikis live as plain markdown in `~/wiki/` (Obsidian-compatible). Ask the
agent to "initialize my wiki and add a page about X" — a capable model
(8B+ for tool-driven file ops) will scaffold and maintain it.

## 4. GBrain (memory/retrieval + local reranker)

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite                                   # local Postgres-in-WASM
gbrain apply-migrations --yes && gbrain doctor

# use LOCAL embeddings (default auto-detect picks cloud OpenAI — override it):
ollama pull nomic-embed-text
gbrain reinit-pglite --embedding-model ollama:nomic-embed-text --embedding-dimensions 768
gbrain import ~/wiki/                                   # index your wiki, locally

# LOCAL cross-encoder reranker (use the ggml-org GGUF — community ones can score garbage):
brew install llama.cpp
llama-server -hf ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF \
  --alias qwen3-reranker-0.6b --reranking --pooling rank --port 8081
gbrain config set search.reranker.model llama-server-reranker:qwen3-reranker-0.6b
gbrain config set search.reranker.enabled true
gbrain config set provider_base_urls.llama-server-reranker http://localhost:8081/v1
```

Expose GBrain to Hermes over MCP, **pruned to a lean toolset** so it doesn't
crowd a local model's context window:

```bash
printf 'Y\n' | hermes mcp add gbrain --command "$(command -v gbrain)" --args serve
# then in ~/.hermes/config.yaml under mcp_servers.gbrain, add:
#   tools:
#     include: [query, search, recall, get_page, put_page, list_pages]
```

## 5. Team Brain integration

The brain (`aios-team-brain`) is a Next.js app. Point its **LLM** and
**reranker** at your local services via env — full reference in
[PROVIDERS.md](./PROVIDERS.md):

```bash
# .env.local
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1-8b-64k:latest
RERANK_URL=http://localhost:8081/v1/rerank
RERANK_MODEL=qwen3-reranker-0.6b
```

```bash
npm run dev      # dashboard query + `aios query` now run on the local model, $0
```

Unset `LLM_BASE_URL` / `RERANK_URL` to use cloud Anthropic + Postgres ranking —
the same code path, no rebuild. The `aios` CLI is unchanged; it just POSTs to the
brain, so pointing the brain local makes `aios query` local end-to-end.

---

## Persistence (always-on)

Long-running local services (Hermes dashboard, the reranker) survive reboots via
user LaunchAgents in `~/Library/LaunchAgents/`. Pattern: `RunAtLoad` +
`KeepAlive` (KeepAlive retries until the Tailscale interface is up). Load with
`launchctl bootstrap gui/$(id -u) <plist>`; check with `launchctl print`.

## Local vs cloud at a glance

| Layer | Local | Cloud |
|-------|-------|-------|
| Agent | Hermes + Ollama | Hermes + hosted model |
| Brain LLM | `LLM_BASE_URL` → Ollama | `ANTHROPIC_API_KEY` |
| Embeddings | `ollama:nomic-embed-text` | `openai:text-embedding-3-large` |
| Reranker | `llama-server` Qwen3-Reranker | Cohere / Voyage / ZeroEntropy |
| Storage | PGLite / local Postgres | hosted Postgres |

Mix freely — each layer is an independent switch.
