# Patched Graphiti image — kill the per-entity LLM fan-out (GRAPHCOST-8 / AIO-755).
#
# THE PROBLEM. Putting 2,500 characters into the graph cost 27.2 LLM calls and 123,809 billed input
# tokens — 198x the source text. Measured 2026-08-03 (666 episodes, 18,143 calls, $43.52) and
# attributed once `llm_usage.call_kind` shipped: `node_attributes` alone was 65.6% of graph spend at
# ~18 calls per episode. That is `extract_attributes_from_node` in graphiti_core 0.13.2, which calls
# the LLM ONCE PER RESOLVED ENTITY, ungated (the `if entity_type is not None` branch above it does
# not gate the call), each carrying the full episode.
#
# THE FIX. graphiti_core 0.29.3, for our exact configuration (no custom entity types):
#   * `_extract_entity_attributes` returns {} with NO LLM call when the entity type is absent/empty;
#   * summaries are BATCHED at MAX_NODES=30 instead of one call per node;
#   * and a node whose summary + edge facts fits MAX_SUMMARY_CHARS*2 is built by string
#     concatenation — zero LLM calls.
#
# ── TWO TRAPS, both verified by running the images ──────────────────────────────────────────────
#
# TRAP 1: bumping the image TAG does nothing. Every published `zepai/graphiti` image — including the
# one tagged `0.22.0` — runs graphiti_core **0.13.2** in /app/.venv, with a newer copy sitting UNUSED
# at /usr/local/lib/python3.12/site-packages. There is no published server image on 0.29.x at all.
# So the upgrade must install the library into the venv the server actually imports from.
#
# TRAP 2 (would have taken extraction down SILENTLY): 0.29.3's DEFAULT `OpenAIClient` calls
# `client.responses.parse(...)` — the OpenAI **Responses** API — where 0.13.2 calls
# `chat.completions.parse`. Every graphiti extraction call passes a response_model, so ~100% of calls
# take that path, and the brain's proxy serves only /chat/completions and /embeddings: every call
# would POST to a Next.js 404. Worse than loud — our proxy handler never runs, so NO `llm_failures`
# row is written and the cost ledger goes QUIET, which is indistinguishable from "the upgrade worked,
# spend collapsed". Hence patch 1 below: construct `OpenAIGenericClient`, which targets any
# OpenAI-compatible /chat/completions endpoint.
#
# ⚠️ BEFORE DEPLOYING, CONFIRM THE SERVICE HAS NO CUSTOM START COMMAND (Settings → Deploy).
# A Railway start command OVERRIDES this image's CMD. If one is set — especially one "matching" the
# base image, `uv run uvicorn …` — then every gate in this file still passes and the venv is
# re-synced back to graphiti_core 0.13.2 at boot anyway. That is the trap below, resurrected by
# dashboard config, and nothing in the image can detect it. The start command must be EMPTY.
# Also confirm the service still targets port 8000 (this CMD binds it, as the base image did).
#
# Deploy: point the prod `graphiti` Railway service at this Dockerfile (Settings → Source → build
# from repo `graphiti/`). RECORD THE CURRENT DEPLOYMENT ID FIRST — rollback is a dashboard rollback
# to that deployment, never `railway up`/`redeploy` (restarting this service has previously rebuilt a
# broken image). Rollback is DATA-safe: 0.29.3 keeps the same labels/relationships, same-named
# `CREATE … IF NOT EXISTS` indices and the same embedder, so vectors stay comparable. But Graphiti's
# worker queue is IN-MEMORY: episodes accepted (202) but unprocessed at rollback are lost — confirm
# the brain's reconcile re-pushed them. See docs/ARCHITECTURE.md ("202 ≠ extracted").
FROM zepai/graphiti@sha256:76d14f30afc65d2f914637d67d0c0631a7e779e2740be1ae99b9dc0c5876d2da

# Telemetry OFF, in the IMAGE. 0.29.3 defaults GRAPHITI_TELEMETRY_ENABLED to 'true' and fires a
# PostHog event on every `Graphiti()` init — which the server does PER REQUEST. Set here rather than
# as a Railway variable because a var-touch on this service is the rebuild-a-broken-image hazard.
ENV GRAPHITI_TELEMETRY_ENABLED=false

# Pinned exactly, TRANSITIVELY. `graphiti-core==0.29.3` alone pins one package; openai, pydantic,
# neo4j, tenacity and posthog would still resolve fresh at whatever moment the platform builds — so
# the image verified here would not be the image that ships, and a new `openai` release could land
# untested under the patched client. `constraints.txt` is `pip freeze` of the image this change was
# actually validated against; regenerate it deliberately, not incidentally.
# The image's venv is uv-built and ships NO pip, so bootstrap it with ensurepip first. Installing
# with the SYSTEM pip would land the library in /usr/local/lib/python3.12/site-packages — which is
# exactly the unused copy Trap 1 is about, and the server would keep importing 0.13.2 from the venv.
COPY constraints.txt /tmp/constraints.txt
RUN /app/.venv/bin/python -m ensurepip --upgrade \
 && /app/.venv/bin/python -m pip install --no-cache-dir --disable-pip-version-check -c /tmp/constraints.txt 'graphiti-core==0.29.3' \
 && /app/.venv/bin/python -c "import graphiti_core.utils.maintenance.node_operations as n; print('MAX_NODES', n.MAX_NODES)"

# ── PATCH 1: make the server construct the /chat/completions client, not the Responses one ─────────
#
# `ZepGraphiti.__init__` passes `llm_client=None`, so `Graphiti` builds its default (Responses API).
# We construct `OpenAIGenericClient` instead. Two settings are supplied EXPLICITLY because their
# defaults are wrong for us:
#
#   * temperature=0 — deployed 0.13.2 had DEFAULT_TEMPERATURE = 0; 0.29.3 has **1**. A bare
#     LLMConfig() would silently move every extraction/dedupe/summary call to temperature-1 sampling.
#   * small_model='gpt-4.1-nano' — LLMConfig.small_model defaults to None and the server never sets
#     it, so ModelSize.small would fall back to the STRONG model and the brain's small-model routing
#     (AIO-753) would stop firing while looking fine. This literal MUST equal
#     GRAPHITI_SMALL_MODEL_MARKER in lib/llm/graph-call-kind.ts — that marker is how the proxy
#     recognises a small call.
#
# base_url/api_key need no plumbing: the AsyncOpenAI client reads OPENAI_BASE_URL/OPENAI_API_KEY from
# env, which the graphiti service sets. (`get_graphiti`'s post-construction `config.base_url`/
# `config.api_key` assignments were always no-ops; its `llm_client.model = settings.model_name`
# assignment is LIVE and still works.)
RUN F=/app/graph_service/zep_graphiti.py \
 && grep -q 'super().__init__(uri, user, password, llm_client)' "$F" \
 && sed -i 's|from graphiti_core.llm_client import LLMClient  # type: ignore|from graphiti_core.llm_client import LLMClient  # type: ignore\nfrom graphiti_core.llm_client.config import LLMConfig  # type: ignore\nfrom graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient  # type: ignore|' "$F" \
 && sed -i 's|super().__init__(uri, user, password, llm_client)|super().__init__(uri, user, password, llm_client or OpenAIGenericClient(config=LLMConfig(temperature=0, small_model="gpt-4.1-nano")))|' "$F" \
 && grep -q 'OpenAIGenericClient(config=LLMConfig(temperature=0, small_model="gpt-4.1-nano"))' "$F" \
 && grep -q 'from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient' "$F"

# ── PATCH 2: teach OpenAIGenericClient about ModelSize.small ───────────────────────────────────────
#
# It extends LLMClient, NOT BaseOpenAIClient, so it does not inherit `_get_model_for_size` and sends
# `model=self.model or DEFAULT_MODEL` unconditionally. `model_size` is already in scope at that call
# site and `ModelSize` is already imported. Without this, every call — including the two Graphiti
# itself marks ModelSize.small — goes to the strong model, and AIO-753's routing silently stops.
#
# The 'gpt-4.1-nano' fallback is load-bearing: this module never imports DEFAULT_SMALL_MODEL (it
# lives in openai_base_client.py), and `self.small_model` would be None without patch 1's config.
# Belt and braces — either one alone would work; both together mean neither can silently regress.
#
# Runs AFTER the pip install, or pip would overwrite the edit.
RUN F=/app/.venv/lib/python3.12/site-packages/graphiti_core/llm_client/openai_generic_client.py \
 && test "$(grep -c 'model=self.model or DEFAULT_MODEL' "$F")" = "1" \
 && sed -i 's|model=self.model or DEFAULT_MODEL,|model=((self.small_model or "gpt-4.1-nano") if model_size == ModelSize.small else (self.model or DEFAULT_MODEL)),|' "$F" \
 && grep -q 'if model_size == ModelSize.small' "$F" \
 && /app/.venv/bin/python -c "import ast,sys; ast.parse(open('$F').read()); print('patch 2 parses')"

# The old DEFAULT_MAX_TOKENS = 8192 → 16384 sed is GONE ON PURPOSE: 0.29.3 ships 16384 already
# (llm_client/config.py). Its grep gate would now fail the build — that gate working as designed.
# Asserted rather than assumed, so a future base image that regresses the ceiling is caught here.
RUN grep -q 'DEFAULT_MAX_TOKENS = 16384' /app/.venv/lib/python3.12/site-packages/graphiti_core/llm_client/config.py

# ── THE RUNTIME REVERT — the trap that explains Trap 1 ─────────────────────────────────────────────
#
# The base image's CMD is `uv run uvicorn …`, and **`uv run` SYNCS the venv against /app/uv.lock
# before starting**. That lockfile pins graphiti-core 0.13.2, so a build-time install is UNDONE AT
# BOOT: the image builds green, every gate above passes, and then the server imports 0.13.2 anyway.
#
# Observed directly, not theorised — a container built from the steps above logged
#   Uninstalled 2 packages in 138ms / Installed 2 packages in 21ms
# at startup, and then reported `graphiti_core-0.13.2` with no `MAX_NODES` attribute at runtime.
# This is almost certainly why every published `zepai/graphiti` image ships a newer graphiti_core at
# /usr/local while serving 0.13.2 from the venv (Trap 1).
#
# FIX: start uvicorn from the venv DIRECTLY. No `uv run`, so nothing can re-resolve the environment
# between build and serve. `graph_service` is already installed into that venv (and WORKDIR is /app),
# so this is the same process, minus the sync.
CMD ["/app/.venv/bin/uvicorn", "graph_service.main:app", "--host", "0.0.0.0", "--port", "8000"]

# Belt and braces: state the intended pin in pyproject.toml. We do NOT regenerate uv.lock (that needs
# uv, which is root-only in this image). The deliberate consequence is that if anyone reinstates
# `uv run` WITH syncing, the pyproject/lock disagreement makes it fail LOUDLY rather than silently
# reinstalling 0.13.2 — which is the failure mode that cost this ticket a full build cycle to find.
RUN cd /app \
 && sed -i 's|^    "graphiti-core",|    "graphiti-core==0.29.3",|' pyproject.toml \
 && grep -q 'graphiti-core==0.29.3' pyproject.toml
