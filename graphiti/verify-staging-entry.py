#!/usr/bin/env python3
"""Gate for `staging-entry.py` — AIO-997 / AC-07 clarification.

Two callers, one file:

  * the **image build** runs it in full mode against `/app/graph_service/staging_entry.py`, so a base
    image or FastAPI change that breaks the keyless application fails the BUILD rather than shipping
    a sidecar that looks patched and is not — the same discipline as this image's other patches.
  * the **unit tier** (`test/guards/graphiti-staging-entry.test.ts`) runs it with `--selector-only`
    against the repo copy, where FastAPI is not installed and does not need to be. That is only
    possible because the entry module imports nothing at module scope, which is itself check 1.

Both callers now also exercise the DISPATCH — which branch `build_app` actually takes — against a
restored `sys.modules` sentinel standing in for `graph_service.main`. Selector-only could previously
reach `build_app` on refusals alone, so a swap of the two branches was invisible to it; the mutation
table's branch-swap row is the proof that it no longer is.

WHAT IT IS NOT. It proves structure, the scope matrix and the dispatch. It does **not** prove the
shipped image serves and refuses over real HTTP with no outbound attempt — that is
`staging-keyless-diagnostic.py`, run inside an actual freshly built image. A source-level gate cannot
replace a behavioural one and is not offered as a substitute for it.

Exit 0 = every check passed. Exit 1 = a named failure on stderr; the name is the contract, because
the unit tier's mutation table asserts that each mutation reddens its OWN check rather than merely
reddening something.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import sys
import types
from typing import Any, Iterator

DEFAULT_MODULE_PATH = "/app/graph_service/staging_entry.py"

#: Nothing in this list may be imported by the keyless branch — not at import time, not while the
#: application is constructed. `openai` is the provider client, `neo4j`/`graphiti_core` the database
#: and engine, and the three `graph_service` names are the production application whose lifespan
#: requires the key this mode exists to do without.
FORBIDDEN_MODULES = (
    "openai",
    "neo4j",
    "graphiti_core",
    "graph_service.main",
    "graph_service.zep_graphiti",
    "graph_service.routers",
)

failures: list[str] = []


def fail(check: str, message: str) -> None:
    failures.append(f"{check}: {message}")


def forbidden_present() -> list[str]:
    return sorted(
        name
        for name in list(sys.modules)
        for forbidden in FORBIDDEN_MODULES
        if name == forbidden or name.startswith(forbidden + ".")
    )


def load_entry_module(path: str) -> Any:
    """Import the entry module BY PATH, so the repo copy and the installed copy verify identically.

    Any exception here is itself a finding: importing this module must construct nothing, so a
    module-scope `build_app()` — the mutation that would quietly reintroduce eager construction —
    surfaces as an import-time side effect rather than as an unrelated crash.
    """
    spec = importlib.util.spec_from_file_location("aios_staging_entry_under_test", path)
    if spec is None or spec.loader is None:
        print(f"FAIL entry-module-loadable: cannot load a module from {path}", file=sys.stderr)
        raise SystemExit(1)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 — every failure mode is the same finding here
        print(
            "FAIL entry-module-import-side-effect: importing the entry module must construct "
            f"nothing and import nothing, but it raised {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        raise SystemExit(1) from error
    return module


# ── check 1: the import boundary ───────────────────────────────────────────────────────────────────


def check_lazy_import(module: Any) -> None:
    """Importing the entry module must pull in neither FastAPI nor the production application.

    This is what makes the matrix testable as a pure function, and it is the same property the
    keyless branch depends on at runtime: `app` is resolved by `__getattr__`, once, at startup.
    """
    if "fastapi" in sys.modules:
        fail("lazy-import", "importing the entry module imported `fastapi`; construction must be deferred")
    for name in forbidden_present():
        fail("lazy-import", f"importing the entry module imported `{name}`")
    if "app" in vars(module):
        fail(
            "lazy-import",
            "`app` is a module-level attribute, so it was constructed at import time; it must be "
            "produced by `__getattr__` instead",
        )
    if not callable(getattr(module, "__getattr__", None)):
        fail("lazy-import", "the entry module defines no module-level `__getattr__` to build `app` lazily")


# ── check 2: the vocabulary four surfaces share ────────────────────────────────────────────────────


def check_constants(module: Any) -> None:
    expected = {
        "KEYLESS_MODE_NAME": "staging-no-model",
        "REFUSAL_CODE": "staging_graphiti_no_model",
        "HEALTH_PATH": "/healthcheck",
        "SCOPE_PRODUCTION": "production",
        "SCOPE_KEYLESS": "keyless-staging",
        "SCOPE_REFUSE": "refuse",
    }
    for name, value in expected.items():
        actual = getattr(module, name, None)
        if actual != value:
            fail("constants", f"{name} is {actual!r}, expected {value!r}")
    declarations = getattr(module, "KNOWN_MODE_DECLARATIONS", ())
    if tuple(declarations) != ("legacy-pg-only", "copy-ready"):
        fail("constants", f"KNOWN_MODE_DECLARATIONS is {declarations!r}")


# ── check 3: the complete scope matrix ─────────────────────────────────────────────────────────────

PIN = "STAGING_OPS_ENVIRONMENT_ID"
ACTUAL = "RAILWAY_ENVIRONMENT_ID"
MODE = "STAGING_DATA_MODE"
ACTIVATED = "STAGING_COPY_MODE_ACTIVATED"

STG = "env-2f9c-staging"
PROD = "env-7b1a-production"

#: (label, env, expected scope, expected reason)
MATRIX: tuple[tuple[str, dict[str, str], str, str], ...] = (
    # ── row 1: absent pin, absent/legacy declaration, no copy claim → production, unchanged ────────
    ("unpinned, nothing declared", {}, "production", "unpinned-production-delegation"),
    ("unpinned, legacy declared", {MODE: "legacy-pg-only"}, "production", "unpinned-production-delegation"),
    (
        "unpinned, legacy declared, Railway's own environment id present",
        {ACTUAL: PROD, MODE: "legacy-pg-only"},
        "production",
        "unpinned-production-delegation",
    ),
    # Railway injects an environment ID into EVERY deployment. If its presence alone could select
    # staging, production would select staging. Only an operator-supplied pin equal to it does.
    ("unpinned, Railway environment id alone", {ACTUAL: STG}, "production", "unpinned-production-delegation"),
    ("blank pin is an absent pin", {PIN: "   ", ACTUAL: STG}, "production", "unpinned-production-delegation"),
    # ── row 2: absent pin + copy claim → refusal (both spellings of the claim) ─────────────────────
    ("unpinned, copy-ready declared", {MODE: "copy-ready"}, "refuse", "copy-claim-without-pin"),
    ("unpinned, activation flag set", {ACTIVATED: "true"}, "refuse", "copy-claim-without-pin"),
    ("unpinned, activation flag with whitespace", {ACTIVATED: " true "}, "refuse", "copy-claim-without-pin"),
    (
        "unpinned, copy-ready declared, blank pin",
        {PIN: "\t", ACTUAL: STG, MODE: "copy-ready"},
        "refuse",
        "copy-claim-without-pin",
    ),
    # The app's own parser tests `STAGING_COPY_MODE_ACTIVATED !== "true"` exactly, so `TRUE` is not
    # the flag there either. Pinned here so the two parsers cannot drift apart unnoticed; with no pin
    # the answer is production either way, so this costs nothing and hides nothing.
    ("unpinned, activation flag miscased", {ACTIVATED: "TRUE"}, "production", "unpinned-production-delegation"),
    # ── row 3: pin present, environment absent or different → refusal, whatever is declared ────────
    ("pinned, actual environment absent", {PIN: STG}, "refuse", "actual-environment-missing"),
    (
        "pinned, actual environment absent, copy-ready declared",
        {PIN: STG, MODE: "copy-ready"},
        "refuse",
        "actual-environment-missing",
    ),
    ("pinned, actual environment blank", {PIN: STG, ACTUAL: "  "}, "refuse", "actual-environment-missing"),
    ("pinned, actual environment different", {PIN: STG, ACTUAL: PROD}, "refuse", "pinned-environment-mismatch"),
    (
        "pinned, actual environment different, legacy declared",
        {PIN: STG, ACTUAL: PROD, MODE: "legacy-pg-only"},
        "refuse",
        "pinned-environment-mismatch",
    ),
    (
        "pinned, actual environment different, unknown declaration",
        {PIN: STG, ACTUAL: PROD, MODE: "something-else"},
        "refuse",
        "pinned-environment-mismatch",
    ),
    # Identity comparison is exact, matching `isPinnedStagingEnvironment` in the app.
    ("pinned, actual environment differs only by case", {PIN: STG, ACTUAL: STG.upper()}, "refuse", "pinned-environment-mismatch"),
    # ── row 4: pin equals actual → keyless, for every accepted declaration ─────────────────────────
    ("pinned match, nothing declared", {PIN: STG, ACTUAL: STG}, "keyless-staging", "pinned-staging-keyless"),
    # legacy-pg-only must select keyless too, or the sidecar cannot be commissioned before bootstrap.
    ("pinned match, legacy declared", {PIN: STG, ACTUAL: STG, MODE: "legacy-pg-only"}, "keyless-staging", "pinned-staging-keyless"),
    ("pinned match, copy-ready declared", {PIN: STG, ACTUAL: STG, MODE: "copy-ready"}, "keyless-staging", "pinned-staging-keyless"),
    (
        "pinned match, copy-ready declared and activation flag set",
        {PIN: STG, ACTUAL: STG, MODE: "copy-ready", ACTIVATED: "true"},
        "keyless-staging",
        "pinned-staging-keyless",
    ),
    (
        "pinned match, legacy declared and activation flag set",
        {PIN: STG, ACTUAL: STG, MODE: "legacy-pg-only", ACTIVATED: "true"},
        "keyless-staging",
        "pinned-staging-keyless",
    ),
    (
        "pinned match after trimming both sides",
        {PIN: f"  {STG}  ", ACTUAL: f"\t{STG}\n", MODE: " copy-ready "},
        "keyless-staging",
        "pinned-staging-keyless",
    ),
    ("pinned match, whitespace-only declaration is an absent one", {PIN: STG, ACTUAL: STG, MODE: "   "}, "keyless-staging", "pinned-staging-keyless"),
    # ── row 5: pinned scope + unrecognised declaration → configuration refusal, never production ───
    ("pinned match, unknown declaration", {PIN: STG, ACTUAL: STG, MODE: "production"}, "refuse", "unknown-mode-declaration"),
    ("pinned match, misspelled declaration", {PIN: STG, ACTUAL: STG, MODE: "copy_ready"}, "refuse", "unknown-mode-declaration"),
    # ── row 6: absent pin + unrecognised declaration, no claim → production, unchanged ─────────────
    # This file does not get to invent a new global production validation.
    ("unpinned, unknown declaration", {MODE: "something-else"}, "production", "unpinned-production-delegation"),
    (
        "unpinned, unknown declaration alongside Railway's environment id",
        {ACTUAL: PROD, MODE: "something-else"},
        "production",
        "unpinned-production-delegation",
    ),
)


def check_matrix(module: Any) -> None:
    select = getattr(module, "select_startup_mode", None)
    if not callable(select):
        fail("scope-matrix", "the entry module exposes no `select_startup_mode`")
        return
    for label, env, expected_scope, expected_reason in MATRIX:
        try:
            selection = select(env)
        except Exception as error:  # noqa: BLE001
            fail("scope-matrix", f"[{label}] raised {type(error).__name__}: {error}")
            continue
        if selection.scope != expected_scope or selection.reason != expected_reason:
            fail(
                "scope-matrix",
                f"[{label}] env={json.dumps(env, sort_keys=True)} selected "
                f"{selection.scope}/{selection.reason}, expected {expected_scope}/{expected_reason}",
            )
        if not selection.detail:
            fail("scope-matrix", f"[{label}] selected {selection.scope} with an empty explanation")


def check_refusal_raises(module: Any) -> None:
    """A refusing configuration must RAISE, not return the production application.

    The failure this pins is the only one that matters here: falling through to production would give
    a misconfigured staging deployment the key-requiring, extraction-capable app.
    """
    error_type = getattr(module, "StagingEntryConfigurationError", None)
    if error_type is None:
        fail("refusal-raises", "the entry module exposes no StagingEntryConfigurationError")
        return
    for label, env, expected_scope, expected_reason in MATRIX:
        if expected_scope != "refuse":
            continue
        try:
            module.build_app(env)
        except error_type as raised:
            if expected_reason not in str(raised):
                fail("refusal-raises", f"[{label}] refusal message does not name `{expected_reason}`: {raised}")
        except Exception as error:  # noqa: BLE001
            fail("refusal-raises", f"[{label}] raised {type(error).__name__} instead of a refusal: {error}")
        else:
            fail("refusal-raises", f"[{label}] returned an application instead of refusing")


# ── check 4: the DISPATCH — which branch `build_app` actually takes ────────────────────────────────

#: One accepted staging configuration and one ordinary production configuration, as whole
#: environments. `PINNED_ENV` is also what full mode constructs the keyless application from, so the
#: application under test is reached through the real selector rather than through a direct call to
#: the keyless factory.
PINNED_ENV = {PIN: STG, ACTUAL: STG, MODE: "legacy-pg-only"}
UNPINNED_ENV: dict[str, str] = {}

_MISSING = object()


class _ProductionSentinelModule(types.ModuleType):
    """Stands in for `graph_service.main`, and records every attribute read of it.

    The recording is the second half of the check: "the production application was not returned" is
    weaker than "the production module was never even asked for its app", and the second is the
    property the keyless and refusing branches actually promise.
    """

    def __init__(self, name: str, sentinel: object, reads: list[str]) -> None:
        super().__init__(name)
        # Into `__dict__` directly, so ordinary attribute lookup finds them and `__getattr__` — which
        # exists to notice the ONE read we care about — is not called for the bookkeeping itself.
        self.__dict__["_sentinel"] = sentinel
        self.__dict__["_reads"] = reads

    def __getattr__(self, item: str) -> object:
        if item.startswith("__"):  # import machinery probing for `__path__`/`__all__` is not a read
            raise AttributeError(item)
        self.__dict__["_reads"].append(item)
        if item == "app":
            return self.__dict__["_sentinel"]
        raise AttributeError(item)


@contextlib.contextmanager
def _production_sentinel(reads: list[str]) -> Iterator[object]:
    """Install a fake `graph_service.main` for the duration, then put `sys.modules` back exactly.

    Why a sentinel at all: in the unit tier the real production module does not exist, so the
    production branch could only ever be observed as an ImportError — which is indistinguishable from
    a dozen other breakages and, worse, is ALSO what an inverted branch produces when the keyless
    branch fails on absent FastAPI. A sentinel turns "took the production branch" into an identity
    comparison, which is a fact rather than an inference.

    Why the restore is not optional: `check_keyless_application` asserts that no `graph_service.*`
    module is present in `sys.modules`, and a leaked stub would fail that check for a reason that has
    nothing to do with the module under test.
    """
    sentinel = object()
    names = ("graph_service", "graph_service.main")
    saved = {name: sys.modules.get(name, _MISSING) for name in names}
    package = types.ModuleType("graph_service")
    package.__path__ = []  # type: ignore[attr-defined] — a package, so the submodule name resolves
    main = _ProductionSentinelModule("graph_service.main", sentinel, reads)
    package.main = main  # type: ignore[attr-defined]
    sys.modules["graph_service"] = package
    sys.modules["graph_service.main"] = main
    try:
        yield sentinel
    finally:
        for name in names:
            if saved[name] is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]  # type: ignore[assignment]


def check_production_dispatch(module: Any) -> None:
    """`build_app` must reach `graph_service.main.app` on the production branch — and ONLY there."""
    reads: list[str] = []
    with _production_sentinel(reads) as sentinel:
        # 1. Production delegation: the ordinary deployment gets the ORIGINAL object, by identity.
        try:
            produced = module.build_app(UNPINNED_ENV)
        except Exception as error:  # noqa: BLE001
            fail(
                "production-dispatch",
                f"an unpinned configuration raised {type(error).__name__}: {error}; it must delegate "
                "to `graph_service.main.app`",
            )
        else:
            if produced is not sentinel:
                fail(
                    "production-dispatch",
                    "an unpinned configuration did not return `graph_service.main.app`; production "
                    "delegation must export the original object, not a rebuilt one",
                )
        if "app" not in reads:
            fail(
                "production-dispatch",
                "the production branch never read `graph_service.main.app`, so an unpinned "
                "deployment is not being delegated to the unchanged application",
            )

        # 2. Pinned staging: the keyless branch, and the production module untouched.
        del reads[:]
        try:
            produced = module.build_app(PINNED_ENV)
        except ModuleNotFoundError as error:
            # Selector-only: FastAPI is not installed here, so REACHING its import is itself the
            # proof that the keyless branch was taken. Any other missing module is a real finding.
            if error.name != "fastapi":
                fail(
                    "production-dispatch",
                    f"a pinned staging configuration failed on an unexpected import: {error}",
                )
        except Exception as error:  # noqa: BLE001
            fail(
                "production-dispatch",
                f"a pinned staging configuration raised {type(error).__name__}: {error}",
            )
        else:
            if produced is sentinel:
                fail(
                    "production-dispatch",
                    "a pinned staging configuration returned the PRODUCTION application: the "
                    "branches are inverted, and staging would run the key-requiring app",
                )
        if reads:
            fail(
                "production-dispatch",
                f"a pinned staging configuration read {sorted(set(reads))} from `graph_service.main`; "
                "the keyless branch must not touch the production module at all",
            )

        # 3. Refusals, with production IMPORTABLE. Without the sentinel a fall-through to production
        #    merely raises ImportError in this tier, which reads as "it refused" — so this is the
        #    only place the fall-through is actually distinguishable from the refusal.
        del reads[:]
        error_type = getattr(module, "StagingEntryConfigurationError", None)
        if error_type is not None:
            for label, env, expected_scope, _reason in MATRIX:
                if expected_scope != "refuse":
                    continue
                try:
                    produced = module.build_app(env)
                except error_type:
                    continue
                except Exception as error:  # noqa: BLE001
                    fail(
                        "production-dispatch",
                        f"[{label}] raised {type(error).__name__} instead of refusing: {error}",
                    )
                    continue
                fail(
                    "production-dispatch",
                    f"[{label}] returned "
                    + ("the PRODUCTION application" if produced is sentinel else repr(produced))
                    + " instead of refusing",
                )
            if reads:
                fail(
                    "production-dispatch",
                    f"a refusing configuration read {sorted(set(reads))} from `graph_service.main`; "
                    "a refusal must happen before the production application is reached",
                )


# ── check 5 (full mode only): the keyless application, behaviourally ───────────────────────────────


async def _call(app: Any, method: str, path: str) -> tuple[int, bytes]:
    """Drive the ASGI application directly — no server, no HTTP client, no network."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"localhost")],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8000),
    }
    status = 0
    body = b""

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        nonlocal status, body
        if message["type"] == "http.response.start":
            status = message["status"]
        elif message["type"] == "http.response.body":
            body += message.get("body", b"")

    await app(scope, receive, send)
    return status, body


def check_keyless_application(module: Any) -> None:
    # Through `build_app` with a real pinned environment, not through `build_keyless_app` directly:
    # calling the factory proves the application is right and says nothing about whether a pinned
    # staging deployment would ever be given it. This is the same object the CMD target resolves.
    try:
        app = module.build_app(PINNED_ENV)
    except Exception as error:  # noqa: BLE001
        fail(
            "keyless-construction",
            f"a pinned staging environment did not build an application: {type(error).__name__}: {error}",
        )
        return

    for name in forbidden_present():
        fail("keyless-imports", f"building the keyless application imported `{name}`")

    paths = {getattr(route, "path", None) for route in app.routes}
    if paths != {"/healthcheck"}:
        fail("keyless-routes", f"the keyless application registers {sorted(map(str, paths))}, expected only /healthcheck")

    # A property distinct from the default deny below: the surfaces must not EXIST, independently of
    # anything refusing requests to them.
    for attribute in ("docs_url", "redoc_url", "openapi_url"):
        if getattr(app, attribute, "unset") is not None:
            fail("keyless-docs-disabled", f"{attribute} is {getattr(app, attribute)!r}, expected None")

    status, body = asyncio.run(_call(app, "GET", "/healthcheck"))
    payload = json.loads(body or b"{}")
    if status != 200 or payload.get("status") != "healthy" or payload.get("mode") != module.KEYLESS_MODE_NAME:
        fail("keyless-health", f"GET /healthcheck returned {status} {payload!r}")

    head_status, _ = asyncio.run(_call(app, "HEAD", "/healthcheck"))
    if head_status != 200:
        fail("keyless-health", f"HEAD /healthcheck returned {head_status}, expected 200")

    # The default deny, sampled here and enumerated exhaustively against a real server by the
    # in-image diagnostic. Every entry is a route upstream ships, a documentation surface, a wrong
    # method on the one route that exists, or a path nothing has ever defined.
    refusals = (
        ("POST", "/messages"),
        ("POST", "/entity-node"),
        ("POST", "/clear"),
        ("POST", "/search"),
        ("POST", "/get-memory"),
        ("DELETE", "/entity-edge/abc"),
        ("DELETE", "/group/team_external"),
        ("DELETE", "/episode/abc"),
        ("GET", "/entity-edge/abc"),
        ("GET", "/episodes/team_team"),
        ("GET", "/docs"),
        ("GET", "/redoc"),
        ("GET", "/openapi.json"),
        ("GET", "/"),
        ("GET", "/nothing-defines-this"),
        ("POST", "/healthcheck"),
        ("PUT", "/healthcheck"),
        ("GET", "/healthcheck/"),
    )
    for method, path in refusals:
        status, body = asyncio.run(_call(app, method, path))
        payload = json.loads(body or b"{}")
        if status != 403 or payload.get("error") != module.REFUSAL_CODE:
            fail("keyless-default-deny", f"{method} {path} returned {status} {payload!r}, expected 403 {module.REFUSAL_CODE}")


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    selector_only = "--selector-only" in argv[1:]
    path = args[0] if args else DEFAULT_MODULE_PATH

    module = load_entry_module(path)
    check_lazy_import(module)
    check_constants(module)
    check_matrix(module)
    check_refusal_raises(module)
    # Before the keyless application, and never after: the sentinel it installs must be out of
    # `sys.modules` again before anything asserts on what is loaded there.
    check_production_dispatch(module)
    if not selector_only:
        check_keyless_application(module)

    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    scope = "selector + dispatch" if selector_only else "selector + dispatch + keyless application"
    print(f"staging entry verified ({scope}, {len(MATRIX)} scope rows): {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
