# Patched Graphiti image — the "raise the extraction cap for real" fix.
#
# The problem: Graphiti extracts entities/edges from each episode with its OWN LLM, and that call's
# OUTPUT is hard-capped at graphiti_core's `DEFAULT_MAX_TOKENS`, which is **8192** in every PUBLISHED
# `zepai/graphiti` image (verified through v0.22.0, the latest tag). A dense/long episode whose
# extraction overflows 8192 raises `Output length exceeded max tokens 8192` in `resolve_extracted_nodes`
# and stalls the queue — so episodes are accepted (202) but no facts are created, blanking narrative
# arcs (prod 2026-06-25, 07-03, 07-17). getzep's graph_service exposes NO env to raise it (verified vs
# `server/graph_service/config.py`: only api_key/base_url/model_name/embedding), and the 16384 default
# lives only on unreleased `main` — no image carries it. So the minimal, lowest-risk way to raise the
# cap is to bump the constant in the installed package on the EXACT known-good pinned image.
#
# Why FROM the pinned digest (not `latest`): zero version jump ⇒ the Neo4j schema our reads depend on
# (`lib/graph/learning` Cypher) and the REST API our projector uses are byte-identical to the image
# that's been running in prod — ONLY the token ceiling moves (8192 → 16384, gpt-4o's max output). This
# keeps full 6000-char episodes instead of shrinking them, and can't regress the graph's shape.
#
# Deploy: point the prod `graphiti` Railway service at this Dockerfile (Settings → Source → build from
# repo `graphiti/`), or build+push and set the service image. Roll back to deployment 6208aed5 if the
# service doesn't come healthy. See docs/ARCHITECTURE.md ("202 ≠ extracted") + the graphiti memory.
FROM zepai/graphiti@sha256:76d14f30afc65d2f914637d67d0c0631a7e779e2740be1ae99b9dc0c5876d2da

# graphiti_core lives in the image's venv (path taken from the prod traceback). Bump the constant
# in-place. The OpenAI client's `max_tokens` default binds to this constant at import and the server
# never overrides it, so raising it here raises the real extraction output budget. The `grep` gate
# makes the build FAIL LOUDLY if a future base image renames/moves the constant (so we never silently
# ship an unpatched image that reintroduces the stall).
RUN CONFIG=/app/.venv/lib/python3.12/site-packages/graphiti_core/llm_client/config.py \
 && grep -q 'DEFAULT_MAX_TOKENS = 8192' "$CONFIG" \
 && sed -i 's/DEFAULT_MAX_TOKENS = 8192/DEFAULT_MAX_TOKENS = 16384/' "$CONFIG" \
 && grep 'DEFAULT_MAX_TOKENS =' "$CONFIG"
