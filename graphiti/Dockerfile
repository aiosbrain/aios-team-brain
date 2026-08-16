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

# ── PATCH 3: carry only the SAME ITEM's prior chunks into extraction (PIPEFF-2 / AIO-821) ──────────
#
# THE PROBLEM. `add_episode` fetches the group's last `RELEVANT_SCHEMA_LIMIT` (10) episodes as
# `previous_episodes` and attaches them to EVERY extraction/dedupe/edge prompt. On our projector,
# consecutive episodes in a group are usually chunks of ten DIFFERENT documents, so each call was
# billed for ten unrelated documents' text. Measured on the Phase-B battery: input tokens per episode
# **−25.5%** with this filter (20,792/21,378 vs 28,000/28,574), entity yield −3%, cross-chunk
# continuity +4%, zero people lost, zero same-name splits, zero retries — every observed difference
# smaller than the incumbent's own ~7% run-to-run noise. On prod's MATURE graph the same absolute cut
# (~7,200 tokens, fixed-size: it is ten episodes' content, independent of graph maturity) lands on a
# 40,070-token baseline, so the number to EXPECT here is **~−18%, not −25.5%**. A verification band
# written around 25% would have called a fully-working patch broken. See
# docs/design/graph-episode-window-phase-c.md.
#
# THE MECHANISM, and why the risk is bounded. It does not reduce what is READ. Episode names are
# `items:<id>` / `items:<id>#k`, so the pre-`#` prefix identifies the document: a multi-chunk item
# keeps ALL of its own prior chunks, and only unrelated documents drop out. The one loss channel is
# cross-ITEM dedupe judgement (the context that helps the extractor decide "John" here is "John Smith"
# there). A non-`items:` episode — `correction:<arc_id>` arc writeback — matches nothing and gets ZERO
# predecessors. That is intended (a correction is not a chunk of a document) and is pinned by
# `test/guards/graphiti-patch-same-item.test.ts`, which runs THIS script and executes the code it
# inserts, rather than describing it.
#
# WHY A SCRIPT AND NOT A `sed`. The insert is 17 lines; a sed of that would be unreadable and
# unverifiable. `patch-same-item.py` is committed **byte-for-byte as the measured arm ran it**
# (sha256 94ba6b1918b8df3f34fd44737e79a5c42f9e26a00d0fe498975e255dcdfcf2d6) — deliberately WITHOUT a
# repo header comment, because a header would change that sha and break the one claim in this change
# that can be PROVED rather than argued: this script applied to the pinned wheel reproduces
# `graphiti_core/graphiti.py` at sha256
# 49ee534a1043760f9e3b58617f7853edd65e7e643a75f34f75267528cb0ec72d, the exact file the battery ran.
# The script is documented here instead; the guard test pins the sha so a "tidy-up" reddens the build.
#
# THE GATES, and what each one catches — a vendored-library edit's real hazard is the SILENT NO-OP:
#   * pre-state `grep -cF … == 1` — the anchor exists exactly once. Fixed-string (`-F`) because the
#     anchor contains `(` and `.`. A base-image or graphiti-core bump that moves this line fails the
#     BUILD instead of shipping an unpatched image that looks patched.
#   * the script's own asserts — anchor count AND the line that must follow it — plus its `ast.parse`.
#   * post-state `grep -q` on the inserted marker — the edit actually landed in the file we serve.
#   * untouched-elsewhere: `RELEVANT_SCHEMA_LIMIT` still appears 15x in `search/search_utils.py`. That
#     constant is the retrieval-quality knob the parent spec REJECTED changing; pinning its count is
#     how this patch is prevented from ever widening into that change.
# Runs AFTER the pip install (like PATCH 2), or pip would overwrite the edit.
COPY patch-same-item.py /tmp/patch-same-item.py
RUN F=/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py \
 && test "$(grep -cF '                    else await EpisodicNode.get_by_uuids(self.driver, previous_episode_uuids)' "$F")" = "1" \
 && /app/.venv/bin/python /tmp/patch-same-item.py "$F" \
 && grep -q 'PIPEFF-2: carry only the SAME ITEM' "$F" \
 && test "$(grep -c RELEVANT_SCHEMA_LIMIT /app/.venv/lib/python3.12/site-packages/graphiti_core/search/search_utils.py)" = "15"

# ── PATCH 4: ONE extraction call instead of two (PIPEFF-5 / AIO-868) ───────────────────────────────
#
# THE PROBLEM. `add_episode` reads every episode TWICE: `extract_nodes` for the entities, then
# `extract_edges` for the relations between them. Both carry the same episode body, the same
# (PATCH-3-filtered) predecessors and the same entity-type block. Measured on prod's ledger over the
# four days after PATCH 3 shipped, those two kinds are **47.6% of graph spend** ($0.82 + $0.73 of
# $3.26). 0.29.3 ships `utils/maintenance/combined_extraction.py` which does both in one call, with
# its own registered prompt — but it is reachable only from the BULK path (`bulk_utils.py:271`,
# default False, and `graphiti.py:798` omits it), so the REST server can never take it. Hence a
# patch. Projected saving **~12–14% of graph cost**; see docs/design/graph-combined-extraction.md.
#
# WHY IT IS NOT A FREE WIN, unlike PATCH 3. PATCH 3 removed padding — same question, less junk — so
# mechanism carried its quality argument. This CHANGES THE QUESTION: a different prompt can extract a
# different set of entities and relations from identical text. No mechanism argument is available and
# none is attempted; the gate is the battery (2 arms × 8 reps), and the merge decision is taken on it.
#
# THE THING THAT WOULD HAVE FOOLED THE MEASUREMENT — recorded because it nearly did. Upstream's
# docstring claims combined extraction "reduc[es] orphaned nodes". It does, by DELETING them:
# `combined_extraction.py:295` drops every node with no incident edge, behind a logger.debug. So
# orphan rate cannot fail as a quality sensor, and RAW entity-per-episode falls ~7% MECHANICALLY
# (prod's measured orphan share: 1,356 of 19,051). The battery therefore counts CONNECTED entities,
# and prices the drop separately. Anyone reading raw entity yield after this ships would see a "7%
# quality regression" that is nothing of the kind.
#
# THE THREE EDITS, all in `graphiti.py`, all by anchor-with-assert (see patch-combined-extraction.py):
#   1. `_extract_and_resolve_edges` gains `pre_extracted_edges=None`. None keeps today's behaviour
#      byte-for-byte, so the unpatched path is untouched and provably so (guard AC6).
#   2. its `extract_edges` call moves under `else:` — skipped when edges arrive pre-extracted.
#   3. `add_episode` calls `extract_nodes_and_edges` instead of `extract_nodes` and threads the edges
#      through. The import is at the CALL SITE, not module scope: one anchor instead of two, and the
#      import block is the part most likely to move on a library bump.
# Everything after extraction — resolve_extracted_nodes, resolve_edge_pointers,
# resolve_extracted_edges, attributes, episodic edges — is untouched by construction.
#
# ORDER MATTERS: this runs AFTER PATCH 3, and depends on it. PATCH 3 filters `previous_episodes` at
# the RETRIEVAL site, upstream of both extractors, so the combined call inherits the filter — pinned
# structurally by the guard rather than assumed.
#
# THE GATES, same discipline as PATCH 3 — the hazard of a vendored edit is the SILENT NO-OP:
#   * pre-state: each of the three anchors exists exactly once (asserted inside the script, which
#     exits non-zero and names which anchor failed).
#   * the script's own `ast.parse` — a syntactically broken file never reaches the image.
#   * post-state `grep -q` on the inserted marker — the edit landed in the file we serve.
#   * `extract_edges` must STILL be REFERENCED exactly once: the else-branch keeps the separate path
#     alive for any caller that passes no pre-extracted edges, and a patch that deleted it would
#     break `add_episode_bulk` silently. The gate greps the CALL, not the import — an earlier version
#     of this comment claimed both, and describing a check that is not there is how a gate comes to be
#     trusted for something it never did.
# ⚠️ DEFAULTED OFF. This lever is NOT validated: it changes the extraction PROMPT, so quality cannot
# be argued from mechanism, and the 2-arm x 8-rep battery that would settle it has NOT been run (it
# was paused after one rep at the owner's call — the saving is ~$3-4/month at current volume against
# ~$15 to finish measuring it). The patch merges so the instrument repair and tests beside it stop
# being stranded on a branch; the SWITCH stays off.
#
# Turning it on is a one-line change to this default, and the three conditions are in
# docs/design/graph-combined-extraction.md:
#   1. on ONLY after a passing battery — never on an unmeasured guess;
#   2. run the battery only at ~3x today's graph spend (~$15/week) or when a customer is heading
#      there — below that the measurement costs more than the saving;
#   3. if neither has happened by 2027-02-16, DELETE this block rather than keep it as decoration.
# (2) is a judgement on a measured number; (1) and (3) are enforced by
# `test/guards/graphiti-patch-combined.test.ts`, which asserts this default is off and reddens on the
# expiry date. A flag with only prose behind it becomes furniture.
ARG PIPEFF5_COMBINED_EXTRACTION=0
COPY patch-combined-extraction.py /tmp/patch-combined-extraction.py
RUN F=/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py \
 && if [ "$PIPEFF5_COMBINED_EXTRACTION" = "1" ]; then \
      /app/.venv/bin/python /tmp/patch-combined-extraction.py "$F" \
   && grep -q 'PIPEFF-5: one extraction call' "$F" \
   && grep -q 'pre_extracted_edges: list\[EntityEdge\] | None = None' "$F" \
   && test "$(grep -c 'extracted_edges = await extract_edges(' "$F")" = "1" ; \
    else \
      echo "PIPEFF-5 combined extraction: OFF (default)" \
   && ! grep -q 'PIPEFF-5: one extraction call' "$F" ; \
    fi \
 && grep -q 'PIPEFF-2: carry only the SAME ITEM' "$F"

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
