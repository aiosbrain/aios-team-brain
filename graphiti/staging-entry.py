"""Keyless staging entry for the Graphiti sidecar — AIO-997 / AC-07 clarification.

WHY THIS FILE EXISTS. The upstream server's ``Settings`` declares ``openai_api_key: str`` with no
default, and the FastAPI lifespan calls ``get_settings()`` then ``initialize_graphiti(...)``, which
constructs ``ZepGraphiti``/``OpenAIGenericClient``. So a sidecar with the provider key REMOVED — which
is exactly what the accepted copy-mode contract requires of staging — cannot start at all. The
contract simultaneously demands "no Graphiti provider credentials" and "a successfully deployed
pinned sidecar"; without a keyless serving mode those two are not satisfiable together, and the two
reconciliations people reach for first (a fake key, a guessed proxy) are both refused.

WHAT IT DOES. It is the uvicorn target for the image (see the Dockerfile's CMD). It selects between
two applications and NEVER blends them:

  * **ordinary/production** — re-export ``graph_service.main.app`` untouched. Same lifespan, same
    routers, same initialization, same failure when a key is missing. Nothing about production
    behaviour is changed by this file being in the path.
  * **pinned keyless staging** — build a minimal FastAPI app HERE, and never import
    ``graph_service.main``, the ingest/retrieve routers, ``zep_graphiti``, ``graphiti_core``,
    ``openai`` or ``neo4j``. It serves ``GET``/``HEAD /healthcheck`` and refuses everything else with
    a stable named 403. Health means the PROCESS is alive in no-model mode; it is not a claim that
    the graph or its database is ready, because in this mode neither is touched.

  A contradictory or unverifiable staging identity is a startup REFUSAL, never a fall-through to the
  production application — falling through is how a misconfigured staging deployment would quietly
  become a key-requiring, extraction-capable one.

WHY AN ENTRY MODULE RATHER THAN PATCHING ``Settings``. The alternative is string-patching a
third-party settings class and its constructors, the way the Dockerfile's other patches do. Those
patches are worth their cost because they change behaviour that only exists inside the library. This
does not: the whole requirement is "do not construct any of that", which an import boundary states
directly and a `sed` can only approximate. Nothing upstream is rewritten here.

THE LAZINESS IS LOAD-BEARING. ``app`` is produced by a module-level ``__getattr__`` (PEP 562), so
importing this module imports nothing else — not FastAPI, not ``graph_service.main``. That is what
lets the scope matrix be tested as a pure function with no image dependencies, and it is asserted by
``verify-staging-entry.py`` at build time. uvicorn resolves ``module:attr`` with ``getattr``, so the
application is still constructed exactly once, at startup, by the ordinary target string.
"""

from __future__ import annotations

import os
from typing import Any, Mapping, NamedTuple

# ── the vocabulary, in one place, because four surfaces read it ────────────────────────────────────
# (the app itself, the build-time verifier, the in-image diagnostic, and the commissioning runbook)

#: Reported by health in keyless mode. A human/commissioning readback, not a machine capability flag.
KEYLESS_MODE_NAME = "staging-no-model"
#: The one name every refusal carries, so a caller can tell "this sidecar is deliberately keyless"
#: apart from a crash, a 404 or a proxy error.
REFUSAL_CODE = "staging_graphiti_no_model"
#: The ONLY path this mode serves, and only for GET/HEAD.
HEALTH_PATH = "/healthcheck"

SCOPE_PRODUCTION = "production"
SCOPE_KEYLESS = "keyless-staging"
SCOPE_REFUSE = "refuse"

#: The declarations the app-side parser (`lib/staging/runtime-policy.ts`) recognises. Anything else
#: inside pinned staging scope is a configuration error, not a synonym for production.
KNOWN_MODE_DECLARATIONS = ("legacy-pg-only", "copy-ready")


class StagingEntryConfigurationError(RuntimeError):
    """Raised instead of returning an application. Uvicorn propagates it and the process exits."""


class Selection(NamedTuple):
    """Which application to build, and the stable reason code for why."""

    scope: str
    reason: str
    detail: str


def _normalized(env: Mapping[str, str], name: str) -> str:
    """Trim, and treat absent/blank/whitespace-only alike.

    The app's own parsers trim (`stagingModeFromEnvironment`, `isPinnedStagingEnvironment`), and a
    dashboard-entered variable acquires trailing whitespace easily. Two components disagreeing about
    whether `" copy-ready"` is a declaration is the kind of drift that is silent in both directions.
    """
    value = env.get(name)
    return value.strip() if isinstance(value, str) else ""


def select_startup_mode(env: Mapping[str, str]) -> Selection:
    """The complete scope matrix, as a pure function over the environment.

    Deliberately imports nothing: the matrix is the part most worth testing and the part least able
    to afford FastAPI, a provider client or a database in the room while it is tested.

    | Pin      | Actual environment  | Declaration / copy claim                  | Selection       |
    | -------- | ------------------- | ----------------------------------------- | --------------- |
    | absent   | any/absent          | absent or `legacy-pg-only`, no copy claim  | production      |
    | absent   | any/absent          | copy claim                                 | refusal         |
    | nonempty | absent or different | any                                        | refusal         |
    | nonempty | exact match         | absent / `legacy-pg-only` / `copy-ready`   | keyless staging |
    | nonempty | exact match         | unknown nonempty declaration               | refusal         |
    | absent   | any/absent          | unknown nonempty declaration, no copy claim| production      |

    Two orderings in here are the whole point and must not be "tidied":

    * identity is checked BEFORE the declaration, so a supplied pin that does not match the actual
      environment refuses whatever it declares. A pin naming an environment we are not in is a
      configuration error regardless of what else the operator wrote.
    * the declaration is validated ONLY inside pinned scope. An unpinned production deployment that
      happens to carry an unrecognised `STAGING_DATA_MODE` keeps starting exactly as it does today;
      this file does not get to invent a new global production validation, and a build that refuses
      production for a stray variable is a worse outcome than the one it would be preventing.

    Railway supplies `RAILWAY_ENVIRONMENT_ID` on every deployment, so its presence alone proves
    nothing and never selects staging — only an operator-supplied pin that EQUALS it does.
    """
    pin = _normalized(env, "STAGING_OPS_ENVIRONMENT_ID")
    actual = _normalized(env, "RAILWAY_ENVIRONMENT_ID")
    declared = _normalized(env, "STAGING_DATA_MODE")
    # "Copy claim" = the operator asserting copied-staging scope, by either of its two spellings.
    copy_claim = declared == "copy-ready" or _normalized(env, "STAGING_COPY_MODE_ACTIVATED") == "true"

    if not pin:
        if copy_claim:
            return Selection(
                SCOPE_REFUSE,
                "copy-claim-without-pin",
                "copied-staging mode is claimed (STAGING_DATA_MODE=copy-ready or "
                "STAGING_COPY_MODE_ACTIVATED=true) but STAGING_OPS_ENVIRONMENT_ID is absent, so the "
                "claim cannot be bound to an environment; refusing rather than starting the "
                "provider-dependent application under a copy claim",
            )
        return Selection(
            SCOPE_PRODUCTION,
            "unpinned-production-delegation",
            "no staging environment pin and no copy claim: delegating to the unchanged "
            "graph_service.main application",
        )

    if not actual:
        return Selection(
            SCOPE_REFUSE,
            "actual-environment-missing",
            "STAGING_OPS_ENVIRONMENT_ID is pinned but RAILWAY_ENVIRONMENT_ID is absent, so the pin "
            "cannot be checked against the environment actually running this container",
        )
    if actual != pin:
        return Selection(
            SCOPE_REFUSE,
            "pinned-environment-mismatch",
            "STAGING_OPS_ENVIRONMENT_ID does not equal RAILWAY_ENVIRONMENT_ID: this container is "
            "not running in the pinned staging environment",
        )
    if declared and declared not in KNOWN_MODE_DECLARATIONS:
        return Selection(
            SCOPE_REFUSE,
            "unknown-mode-declaration",
            "STAGING_DATA_MODE inside pinned staging scope must be absent, "
            + " or ".join(KNOWN_MODE_DECLARATIONS)
            + "; an unrecognised declaration is a configuration error, not production",
        )
    return Selection(
        SCOPE_KEYLESS,
        "pinned-staging-keyless",
        "pinned staging environment: serving the keyless no-model application",
    )


def refusal_payload() -> dict[str, str]:
    """The body every refusal returns.

    Nothing from the request is echoed back. There is no diagnostic value in reflecting a path we
    refused to route, and a refusal is the last place to introduce a reflection.
    """
    return {
        "error": REFUSAL_CODE,
        "mode": KEYLESS_MODE_NAME,
        "detail": (
            "staging Graphiti runs in keyless no-model mode: it serves only GET/HEAD "
            f"{HEALTH_PATH} and refuses every other operation. Graph search, embedding, extraction "
            "and mutation are unavailable here; no provider credential is configured."
        ),
    }


def build_keyless_app() -> Any:
    """The minimal health-only application. Imports FastAPI and nothing else.

    DEFAULT DENY, not an enumeration. The refusal is a middleware, so it runs before routing, before
    dependency resolution and before any handler — and it covers paths that do not exist yet. Listing
    upstream's routes instead would have to be re-audited on every base-image bump, and the one route
    nobody added to the list is the one that matters. There is nothing to enumerate anyway: the only
    route registered in this application is health.

    The interactive documentation surfaces are ALSO disabled at construction (`docs_url`, `redoc_url`,
    `openapi_url` all `None`). That is a second, independent property from the default deny — the
    middleware refuses `/docs` even if the surfaces existed, and the surfaces do not exist even if the
    middleware were removed — and the diagnostic asserts each separately so neither can be silently
    dropped behind the other.
    """
    from fastapi import FastAPI, Response  # noqa: PLC0415 — deliberately deferred
    from fastapi.responses import JSONResponse  # noqa: PLC0415

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    # NO ANNOTATIONS ON THESE HANDLERS, and it is not a style lapse. This module carries
    # `from __future__ import annotations`, so annotations are strings that FastAPI resolves against
    # the function's MODULE globals — and `Response`/`Request` here are locals of this factory, which
    # module globals do not contain. An annotated handler would raise `NameError` while the route was
    # being registered, i.e. at startup, in the one mode that exists to start reliably.
    @app.middleware("http")
    async def refuse_non_health(request, call_next):
        if request.method in ("GET", "HEAD") and request.url.path == HEALTH_PATH:
            return await call_next(request)
        return JSONResponse(content=refusal_payload(), status_code=403)

    @app.get(HEALTH_PATH)
    async def healthcheck():
        # Liveness of THIS PROCESS in no-model mode. Not graph readiness, not database readiness:
        # this mode opens no database connection, so it has nothing to report about one.
        return JSONResponse(content={"status": "healthy", "mode": KEYLESS_MODE_NAME}, status_code=200)

    # HEAD is registered separately because FastAPI's `APIRoute` — unlike Starlette's `Route` — does
    # not add it alongside GET. A probe configured for HEAD would otherwise fall through to the
    # default deny and read the sidecar as broken.
    @app.head(HEALTH_PATH)
    async def healthcheck_head():
        return Response(status_code=200, media_type="application/json")

    return app


def build_app(env: Mapping[str, str] | None = None) -> Any:
    """Select and construct. The production branch is the LAST thing that happens, never the first.

    The import of `graph_service.main` lives inside the branch on purpose: a refusing or keyless
    configuration must fail or serve without the production module ever being imported, and a
    module-scope import would make that untestable and untrue.
    """
    selection = select_startup_mode(os.environ if env is None else env)
    if selection.scope == SCOPE_REFUSE:
        raise StagingEntryConfigurationError(
            f"staging-entry refused startup [{selection.reason}]: {selection.detail}"
        )
    if selection.scope == SCOPE_KEYLESS:
        return build_keyless_app()
    from graph_service.main import app as production_app  # noqa: PLC0415 — deliberately deferred

    return production_app


_APP: Any = None


def __getattr__(name: str) -> Any:
    """PEP 562 — `app` is built on first access, so importing this module builds nothing.

    Memoised because `module:app` must denote one application: a second access constructing a second
    FastAPI instance would be a latent bug the day anything reads the attribute twice.
    """
    if name != "app":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    global _APP
    if _APP is None:
        _APP = build_app()
    return _APP
