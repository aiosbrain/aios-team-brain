"""TEST-ONLY outbound/import tripwire for the keyless staging sidecar — AIO-997.

**This file never ships.** `staging-keyless-diagnostic.py` copies it into a throwaway directory as
`sitecustomize.py` and puts that directory on the server subprocess's `PYTHONPATH`; the image's
Dockerfile does not `COPY` it, and `test/guards/graphiti-staging-entry.test.ts` asserts that it does
not. It is instrumentation, never a runtime credential substitute or a runtime policy.

WHY IT EXISTS. Running the container with `--network none` proves no outbound call SUCCEEDED. It does
not prove none was ATTEMPTED, and "attempted" is the property AC-07 is about: a keyless sidecar that
tries to reach a provider and fails is not a keyless sidecar, it is a broken one whose brokenness is
doing the work. So the server process records and REFUSES every outbound attempt.

THE DNS-FIRST BLIND SPOT THIS VERSION CLOSES. The first version hooked `connect`/`connect_ex` only.
Almost nothing reaches those with a hostname: `urllib`, `httpx`, `requests` and asyncio's
`create_connection` all RESOLVE first, and in a `--network none` container the resolution itself
fails — so the attempt died in `getaddrinfo`, `connect` was never called, and the report said
`outbound_attempts: []`. A caller that swallows the resolver error (every "best effort" client does)
left NO trace at all. A no-network container is exactly the environment where that happens, which is
to say: exactly the environment this tripwire is used in. So resolution is now intercepted FIRST, and
`staging-keyless-diagnostic.py` carries a negative control that would fail if it were not.

WHAT IS ALLOWED, AND WHY THE DISTINCTION IS LOAD-BEARING. Resolving a LOOPBACK or wildcard target is
observed and permitted — uvicorn resolves its own bind address, and a tripwire that refused that
would "prove" zero outbound attempts by preventing the server from starting at all. Every non-local
name is refused before the real resolver ever sees it. Outbound `connect`/`connect_ex` are refused
unconditionally, loopback included: the keyless server has nothing to connect to, and the
diagnostic's own loopback HTTP traffic is issued by a DIFFERENT process that carries no tripwire.

WHAT IT DELIBERATELY DOES NOT PATCH. `bind`, `listen` and `accept` — the health server needs all
three, and a tripwire that broke them would prove nothing except that it had broken them.

WHEN THE REPORT IS WRITTEN, which turned out to matter as much as what is in it. The first version
wrote once at import (i.e. at interpreter startup, before uvicorn had loaded anything) and once from
an `atexit` hook. In the measured run the file on disk was the STARTUP one — `graph_service_modules:
[]`, `toplevel_modules` still at the interpreter's bootstrap set, no `uvicorn` and no `fastapi` — so
its "no forbidden module was imported" said nothing about the server: it was a photograph taken
before the subject arrived. This version therefore also refreshes the report from a `sys.meta_path`
observer that is consulted for EVERY not-yet-loaded module, in every phase, so the file always
reflects the furthest state the process reached. `observation.reached` names the milestones actually
seen, and the diagnostic refuses a server report that never reached the application.

WHAT IT CANNOT SEE, stated so the evidence is not over-read. These are Python-level hooks on the
`socket` module. They cover CPython's own resolver and socket objects, and therefore asyncio's
selector loop, which calls `socket.getaddrinfo` and `sock.connect` by name. They do NOT cover a
native event loop that resolves through libuv (`uvloop`) or any extension that calls `_socket`
directly. That is not a hypothetical for a uvicorn image, so the report records the loop evidence
(`event_loop`) and the diagnostic FAILS if `uvloop` is loaded in the observed process rather than
quietly reporting an unobserved zero.

Two more gaps, named for the same reason. **Connectionless UDP** — `sock.sendto`/`sock.sendmsg`
carry their destination in the call and never touch `connect`, so a datagram sent to a non-local
address leaves no entry here. **Reverse resolution** — `socket.gethostbyaddr`, `socket.getnameinfo`
and `socket.getfqdn` are resolver calls these forward-resolution hooks do not wrap. So "zero
outbound attempts" in this report means zero through the hooked forward-resolution and connect
paths; it is not a claim that all egress was intercepted. No caller of any of them is established in
the keyless server, and closing the gaps is deliberately NOT attempted here: this is scope stated
honestly, not a hook that exists.
"""

from __future__ import annotations

import atexit
import importlib.util
import ipaddress
import json
import os
import socket
import sys

#: Nothing in this list may be imported by the keyless server, at startup or while serving.
FORBIDDEN_MODULES = (
    "openai",
    "neo4j",
    "graphiti_core",
    "graph_service.main",
    "graph_service.zep_graphiti",
    "graph_service.routers",
)

#: A bounded, deliberately conservative defence-in-depth list: HTTP and telemetry clients a
#: health-only FastAPI application has no reason to load. Their ABSENCE is not evidence that nothing
#: was attempted — a bare `socket` call needs none of them — so this supplements the attempt
#: instrumentation above and never substitutes for it.
CLIENT_MODULES = (
    "openai",
    "httpx",
    "requests",
    "urllib3",
    "aiohttp",
    "boto3",
    "opentelemetry",
    "posthog",
    "sentry_sdk",
    "ddtrace",
    "newrelic",
    "segment",
)

#: Recorded, never asserted on: uvicorn imports `ssl` for its own options and stdlib HTTP machinery
#: comes along with ordinary imports. Presence here is context for a reader, not a finding.
OBSERVED_MODULES = ("ssl", "http.client", "urllib.request", "asyncio", "uvloop", "httptools")

#: Hostnames that mean "this machine". Anything else is an outbound resolution.
LOCAL_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"})

#: Milestones that say how far the observed process actually got. A report whose `reached` list is
#: empty was written before the application existed, and its empty findings mean nothing.
MILESTONE_MODULES = ("asyncio", "uvicorn", "fastapi", "graph_service.staging_entry")

#: Every name whose first import must refresh the report immediately — the union of everything the
#: diagnostic asserts on, so no assertion can read a value that went stale between imports.
WATCHED_MODULES = MILESTONE_MODULES + FORBIDDEN_MODULES + CLIENT_MODULES + OBSERVED_MODULES

#: How many permitted local resolutions to keep. Bounded because a long-running server can resolve
#: its own bind address repeatedly and the report is evidence, not a log.
MAX_RECORDED_LOCAL = 50

_REPORT_PATH = os.environ.get("KEYLESS_TRIPWIRE_REPORT")
#: Which process this report is about. The diagnostic runs the tripwire in two roles — the server
#: under test, and a negative control that PROVES the hooks fire — and a report that could not say
#: which it came from would let one be read as the other.
_ROLE = os.environ.get("KEYLESS_TRIPWIRE_ROLE") or "unlabelled"

_outbound: list[dict[str, object]] = []
_local: list[dict[str, str]] = []
_local_count = 0
#: Every module name the import system was asked for. Broader than `sys.modules` on purpose: an
#: import that FAILED still proves the attempt, and `sys.modules` forgets those entirely.
_requested: set[str] = set()
_writes = 0
_last_reason = "startup"
_writing = False

try:
    _UVLOOP_INSTALLED: bool | None = importlib.util.find_spec("uvloop") is not None
except (ImportError, ValueError):
    _UVLOOP_INSTALLED = None


class OutboundConnectionAttempt(RuntimeError):
    """Raised at the attempt, so a call that should not exist cannot merely be logged and retried."""


def _forbidden_now() -> list[str]:
    return sorted(
        name
        for name in list(sys.modules)
        for forbidden in FORBIDDEN_MODULES
        if name == forbidden or name.startswith(forbidden + ".")
    )


def _modules_present(candidates: tuple[str, ...]) -> list[str]:
    loaded = list(sys.modules)
    return sorted(
        candidate
        for candidate in candidates
        if any(name == candidate or name.startswith(candidate + ".") for name in loaded)
    )


def _event_loop_evidence() -> dict[str, object]:
    """What the hooks' validity DEPENDS on, recorded rather than assumed.

    These hooks are patches on the `socket` module, so they see a loop that resolves and connects
    through it — CPython's asyncio selector loop does. `uvloop` does not: it resolves and connects
    inside libuv, so a uvloop server would produce an empty `outbound_attempts` list that meant
    "unobserved", not "none". Recording the fact lets the diagnostic assert it instead of claiming a
    generic native-extension interception this cannot perform.
    """
    policy: str | None = None
    asyncio_module = sys.modules.get("asyncio")
    if asyncio_module is not None:
        try:
            policy_type = type(asyncio_module.get_event_loop_policy())
            policy = f"{policy_type.__module__}.{policy_type.__qualname__}"
        except Exception:  # noqa: BLE001 — evidence collection must never break the process
            policy = None
    return {
        "uvloop_loaded": bool(_modules_present(("uvloop",))),
        # Distinguishes "not loaded because it is not installed" — in which case uvicorn's `--loop
        # auto` deterministically falls back to asyncio and these hooks are always valid — from "not
        # loaded this time", which would be luck rather than a property. Computed once, without
        # importing it: `find_spec` locates a module, it does not execute one.
        "uvloop_installed": _UVLOOP_INSTALLED,
        "asyncio_loaded": asyncio_module is not None,
        "event_loop_policy": policy,
        "hooks_observe": "python-socket-module",
        "hooks_blind_to": [
            "uvloop/libuv resolution and connect",
            "direct _socket extension calls",
            "connectionless UDP sendto/sendmsg",
            "reverse resolution gethostbyaddr/getnameinfo/getfqdn",
        ],
    }


def _requested_matching(candidates: tuple[str, ...]) -> list[str]:
    return sorted(
        candidate
        for candidate in candidates
        if any(name == candidate or name.startswith(candidate + ".") for name in _requested)
    )


def _write_report(reason: str = "startup") -> None:
    """Written on every attempt, on every new import, and at exit.

    On every new import because the alternative was measured and it is worse: an exit-only refresh
    left a startup snapshot on disk whose empty findings looked exactly like a clean run.
    """
    global _writing
    if not _REPORT_PATH or _writing:
        return
    # Re-entrancy guard: a write must never be able to trigger an import that triggers a write.
    _writing = True
    try:
        _write_report_unguarded(reason)
    finally:
        _writing = False


def _write_report_unguarded(reason: str) -> None:
    global _writes, _last_reason
    _writes += 1
    _last_reason = reason
    payload = {
        "pid": os.getpid(),
        "role": _ROLE,
        "observation": {
            "writes": _writes,
            "last_reason": reason,
            "module_requests": len(_requested),
            # The freshness evidence. A server report that never reached the application was written
            # before there was anything to observe.
            "reached": _requested_matching(MILESTONE_MODULES),
        },
        "outbound_attempts": _outbound,
        "hooked_verbs": [
            "socket.getaddrinfo",
            "socket.gethostbyname",
            "socket.gethostbyname_ex",
            "socket.connect",
            "socket.connect_ex",
        ],
        "unhooked_verbs": ["socket.bind", "socket.listen", "socket.accept"],
        "local_resolutions": _local,
        "local_resolution_count": _local_count,
        "event_loop": _event_loop_evidence(),
        "client_modules_present": _modules_present(CLIENT_MODULES),
        # Requested-but-absent counts too: an `import openai` that failed still proves the intent,
        # and `sys.modules` keeps no record of a failed import at all.
        "client_module_requests": _requested_matching(CLIENT_MODULES),
        "observed_modules_present": _modules_present(OBSERVED_MODULES),
        "forbidden_modules": _forbidden_now(),
        "forbidden_module_requests": _requested_matching(FORBIDDEN_MODULES),
        "graph_service_modules": sorted(n for n in list(sys.modules) if n.startswith("graph_service")),
        "toplevel_modules": sorted({n.split(".")[0] for n in list(sys.modules)}),
    }
    with open(_REPORT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


class _ImportObserver:
    """A `sys.meta_path` finder that claims NOTHING and refreshes the report on every new import.

    `find_spec` returning `None` means "I cannot handle this module" — the real finders behind it
    answer exactly as before, so nothing about import resolution changes. What it buys is a hook the
    import system calls for every module not already loaded, which is both the freshness trigger the
    report needed and a record of imports that were ATTEMPTED and failed.
    """

    def find_spec(self, fullname, path=None, target=None):  # noqa: ARG002 — finder protocol
        if fullname in _requested:
            return None
        _requested.add(fullname)
        # Every WATCHED name rewrites immediately — those are precisely the names every assertion in
        # the diagnostic reads — and everything else rewrites periodically, so the module count and
        # the loaded-module lists cannot go stale by more than a handful of imports. Writing on all
        # ~800 imports of a uvicorn boot would work too; this costs a fraction of the I/O and loses
        # nothing any assertion looks at.
        watched = any(fullname == name or fullname.startswith(name + ".") for name in WATCHED_MODULES)
        if watched or len(_requested) % 50 == 0:
            try:
                _write_report(f"import:{fullname}")
            except Exception:  # noqa: BLE001 — instrumentation must never break an import
                pass
        return None


def _record_and_refuse(verb: str, target: object, host: object = None) -> None:
    _outbound.append(
        {
            "verb": verb,
            "address": repr(target),
            "host": repr(host) if host is not None else repr(target),
            # Written down because the two are caught by DIFFERENT hooks, and a report that could not
            # tell them apart could not show that both hooks work.
            "kind": "name-resolution" if "hostby" in verb or "addrinfo" in verb else "direct-connect",
        }
    )
    _write_report(f"attempt:{verb}")
    raise OutboundConnectionAttempt(
        f"keyless staging Graphiti attempted an outbound connection: {verb} {target!r}"
    )


def _is_local_target(host: object) -> bool:
    """Loopback, wildcard, or an empty/None address — everything else is outbound.

    Deliberately conservative in the direction that matters: anything this cannot positively
    identify as local is treated as outbound and refused. A hostname it does not recognise is a
    refusal, never a pass.
    """
    if host is None:
        return True
    if isinstance(host, (bytes, bytearray)):
        try:
            host = bytes(host).decode("ascii")
        except UnicodeDecodeError:
            return False
    if not isinstance(host, str):
        return False
    name = host.strip().strip("[]").lower()
    if not name:
        return True
    if name in LOCAL_HOSTNAMES:
        return True
    try:
        address = ipaddress.ip_address(name.split("%", 1)[0])
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


def _note_local(verb: str, target: object) -> None:
    global _local_count
    _local_count += 1
    if len(_local) < MAX_RECORDED_LOCAL:
        _local.append({"verb": verb, "address": repr(target)})


# ── resolution, intercepted BEFORE the resolver can fail and be swallowed ──────────────────────────

_real_getaddrinfo = socket.getaddrinfo
_real_gethostbyname = socket.gethostbyname
_real_gethostbyname_ex = socket.gethostbyname_ex


def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):  # noqa: A002 — stdlib signature
    if not _is_local_target(host):
        _record_and_refuse("socket.getaddrinfo", (host, port), host)
    _note_local("socket.getaddrinfo", (host, port))
    return _real_getaddrinfo(host, port, family, type, proto, flags)


def _gethostbyname(hostname):
    if not _is_local_target(hostname):
        _record_and_refuse("socket.gethostbyname", hostname, hostname)
    _note_local("socket.gethostbyname", hostname)
    return _real_gethostbyname(hostname)


def _gethostbyname_ex(hostname):
    if not _is_local_target(hostname):
        _record_and_refuse("socket.gethostbyname_ex", hostname, hostname)
    _note_local("socket.gethostbyname_ex", hostname)
    return _real_gethostbyname_ex(hostname)


# ── the connect verbs, retained: an IP literal needs no resolver at all ────────────────────────────


def _connect(self: socket.socket, address: object) -> None:  # noqa: ARG001 — signature must match
    _record_and_refuse("socket.connect", address, _host_of(address))


def _connect_ex(self: socket.socket, address: object) -> int:  # noqa: ARG001
    # `connect_ex` RETURNS an errno rather than raising, so a caller written against it swallows
    # failure by construction. Refusing loudly here is what makes such a caller visible.
    _record_and_refuse("socket.connect_ex", address, _host_of(address))
    return 1  # unreachable; present so the replacement's shape matches the verb it replaces


def _host_of(address: object) -> object:
    if isinstance(address, tuple) and address:
        return address[0]
    return address


socket.getaddrinfo = _getaddrinfo  # type: ignore[assignment]
socket.gethostbyname = _gethostbyname  # type: ignore[assignment]
socket.gethostbyname_ex = _gethostbyname_ex  # type: ignore[assignment]
socket.socket.connect = _connect  # type: ignore[method-assign]
socket.socket.connect_ex = _connect_ex  # type: ignore[method-assign]

atexit.register(_write_report, "exit")
# Installed LAST, so this module's own imports are not counted as the observed process's, and first
# in `meta_path` so it sees every request before a real finder answers it.
sys.meta_path.insert(0, _ImportObserver())
_write_report("startup")
