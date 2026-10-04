#!/usr/bin/env python3
"""Actual-image behavioural proof for the keyless staging sidecar — AIO-997 / AC-07 clarification.

RUN IT INSIDE A FRESHLY BUILT IMAGE, with no network:

    docker build -t aios-graphiti:keyless-check graphiti
    docker run --rm --network none -v "$PWD/graphiti:/diag:ro" aios-graphiti:keyless-check \\
        /app/.venv/bin/python /diag/staging-keyless-diagnostic.py

`graphiti/keyless-image-check.sh` does exactly that plus the image-identity readbacks. Nothing here is
copied into the image: the diagnostic and its tripwire are mounted read-only for the run and are gone
with the container.

WHY IT IS NOT THE BUILD GATE. `verify-staging-entry.py` runs at build time and proves structure and
the scope matrix. It cannot prove what a real uvicorn process does with real HTTP: that startup
constructs no provider client, that every route upstream ships is refused by name over the wire, that
nothing is queued, that no outbound connection is even ATTEMPTED, and that the process shuts down
cleanly. Those are this file's job, and `--network none` alone does not establish the fourth — it
proves no outbound call SUCCEEDED, which is a different claim. Hence the tripwire.

THE INSTRUMENTATION IS ITSELF UNDER TEST (scenario 0). A tripwire that observes nothing reports the
same empty list as a server that attempts nothing, and the two are not the same finding. Worse, the
first version of the tripwire hooked `connect`/`connect_ex` only — so a client that RESOLVED a
hostname first (all of them do) died inside `getaddrinfo`, which in a no-network container fails
immediately, and a caller that swallowed that error left no trace whatsoever. So the negative
controls below make a caught DNS-first attempt and a caught direct-IP attempt from a process wearing
the same hook, and REQUIRE both to appear in the report. If they do not, this diagnostic FAILS; a
server's zero-attempt report is not accepted as evidence from instrumentation that has not been shown
to fire.

ON THE ENVIRONMENT THESE SCENARIOS RUN IN. Each subprocess is given a small, fully stated
environment (`base_environment`) rather than the image's baked `ENV`. That is deliberate and it is
STRONGER, not a shortcut: an inherited ambient `OPENAI_API_KEY` would let a keyless run look keyless
while the process quietly had a credential available. It does mean these runs are not byte-identical
to a platform launch — the image's own `ENV` names are recorded in the report (names only) next to
what is actually supplied, so the difference is visible rather than implied. Nothing here needs an
ambient credential, and no scenario reads one.

WHAT EACH SCENARIO ESTABLISHES

  0. instrumentation     — negative controls: a DNS-first attempt and a direct-IP attempt, both
                            SWALLOWED by their caller, must still be recorded; and resolving loopback
                            must still be permitted, or the tripwire would "prove" silence by
                            preventing the server from binding at all.
  1. keyless serving      — run twice, once per accepted declaration. Starts with no reachable
                            database; health is 200 and names the mode; every known route/method,
                            both documentation surfaces, the OpenAPI schema, an unknown path and a
                            wrong method on health all return the named 403; SIGTERM shuts down
                            cleanly; zero outbound attempts and zero forbidden imports across the
                            whole process lifetime. The second run carries a credential-SHAPED
                            sentinel in its environment, because the branch must be chosen by
                            environment identity rather than by a key happening to be absent — and
                            the sentinel must still never be used. It authenticates to nothing, lives
                            only in that subprocess's environment inside a network-disabled
                            container, and is never written to a file or into the image.
  2. startup refusals     — every refusing row of the scope matrix exits non-zero, names its reason,
                            and does so with the production application never imported.
  3. production delegation— an unpinned configuration exports the very same object as
                            `graph_service.main.app` (proved by identity against a sentinel set before
                            the entry module is imported), with upstream's routes intact.
  4. production control   — an unpinned configuration with no provider key still fails at startup the
                            way it does today. The keyless mode did not make production boot keyless.

Exit 0 = every scenario passed; the JSON report on stdout is the evidence to file.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TRIPWIRE_SOURCE = os.path.join(HERE, "staging-keyless-tripwire.py")

VENV_PYTHON = "/app/.venv/bin/python"
VENV_UVICORN = "/app/.venv/bin/uvicorn"
INSTALLED_ENTRY = "/app/graph_service/staging_entry.py"
ENTRY_TARGET = "graph_service.staging_entry:app"

STAGING_ENV_ID = "env-2f9c-keyless-diagnostic"
OTHER_ENV_ID = "env-7b1a-not-staging"

REFUSAL_CODE = "staging_graphiti_no_model"
KEYLESS_MODE_NAME = "staging-no-model"

#: Every route the pinned upstream server ships (`graph_service/routers/{ingest,retrieve}.py`), plus
#: the documentation surfaces, plus paths and methods nothing defines. Enumerated because the spec
#: names them; the implementation is a DEFAULT DENY, so the unknown-path cases are the ones that
#: prove a future upstream route is covered too.
REFUSED_REQUESTS: tuple[tuple[str, str, object], ...] = (
    ("POST", "/messages", {"group_id": "acme_team", "messages": []}),
    ("POST", "/entity-node", {"uuid": "u", "group_id": "acme_team", "name": "n", "summary": "s"}),
    ("POST", "/clear", {}),
    ("POST", "/search", {"query": "who owns billing", "group_ids": ["acme_team"], "max_facts": 5}),
    ("POST", "/get-memory", {"group_id": "acme_team", "max_facts": 5, "messages": []}),
    ("DELETE", "/entity-edge/11111111-1111-1111-1111-111111111111", None),
    ("DELETE", "/group/acme_team", None),
    ("DELETE", "/episode/11111111-1111-1111-1111-111111111111", None),
    ("GET", "/entity-edge/11111111-1111-1111-1111-111111111111", None),
    ("GET", "/episodes/acme_team?last_n=5", None),
    # The three surfaces disabled at construction. Tested here because "not registered" and "refused
    # by name" are different properties and either alone would be weaker.
    ("GET", "/docs", None),
    ("GET", "/redoc", None),
    ("GET", "/openapi.json", None),
    # Nothing defines these — the default deny is what answers, which is the point.
    ("GET", "/", None),
    ("GET", "/nothing-defines-this", None),
    ("POST", "/messages/", None),
    # The one route that exists, under methods it does not serve.
    ("POST", "/healthcheck", {}),
    ("PUT", "/healthcheck", {}),
    ("DELETE", "/healthcheck", None),
    ("GET", "/healthcheck/", None),
)

UPSTREAM_ROUTE_PATHS = (
    "/messages",
    "/entity-node",
    "/entity-edge/{uuid}",
    "/group/{group_id}",
    "/episode/{uuid}",
    "/clear",
    "/search",
    "/episodes/{group_id}",
    "/get-memory",
    "/healthcheck",
)

#: The refusing rows of the scope matrix, as the environments a deployment could actually carry.
REFUSING_ENVIRONMENTS: tuple[tuple[str, dict[str, str], str], ...] = (
    ("copy-ready claimed with no pin", {"STAGING_DATA_MODE": "copy-ready"}, "copy-claim-without-pin"),
    ("activation flag with no pin", {"STAGING_COPY_MODE_ACTIVATED": "true"}, "copy-claim-without-pin"),
    ("pin with no actual environment id", {"STAGING_OPS_ENVIRONMENT_ID": STAGING_ENV_ID}, "actual-environment-missing"),
    (
        "pin naming a different environment",
        {"STAGING_OPS_ENVIRONMENT_ID": STAGING_ENV_ID, "RAILWAY_ENVIRONMENT_ID": OTHER_ENV_ID},
        "pinned-environment-mismatch",
    ),
    (
        "pinned scope with an unrecognised declaration",
        {
            "STAGING_OPS_ENVIRONMENT_ID": STAGING_ENV_ID,
            "RAILWAY_ENVIRONMENT_ID": STAGING_ENV_ID,
            "STAGING_DATA_MODE": "read-only-ish",
        },
        "unknown-mode-declaration",
    ),
)

#: Targets for the negative controls, chosen so they can never be a real call to anything.
#: `.invalid` is RFC 2606's reserved TLD — guaranteed never to resolve — and `192.0.2.0/24` is
#: RFC 5737 TEST-NET-1 documentation space, routed nowhere and owned by nobody. Neither is a provider
#: endpoint, and the container has no network in any case.
CONTROL_HOSTNAME = "keyless-negative-control.invalid"
CONTROL_IP = "192.0.2.1"
CONTROL_IP_CONNECT_EX = "192.0.2.2"

failures: list[str] = []
evidence: dict[str, object] = {}


def fail(scenario: str, message: str) -> None:
    failures.append(f"{scenario}: {message}")
    print(f"FAIL {scenario}: {message}", file=sys.stderr)


def base_environment(
    extra: dict[str, str],
    tripwire_dir: str | None,
    report_path: str | None,
    role: str = "server",
) -> dict[str, str]:
    """A deliberately bare environment. No provider key, no database, nothing inherited.

    Inheriting the caller's environment would let an ambient `OPENAI_API_KEY` make a keyless run look
    keyless while the process quietly had one available. Every scenario states its whole environment,
    and `collect_image_evidence` records the image `ENV` names this deliberately does not pass on.

    `role` labels the tripwire report. The diagnostic runs the hook in two roles — the SERVER under
    test, and a negative control that proves the hook fires — and a report that could not say which
    process it came from would let a control's recorded attempts be read as a server's, or the
    reverse. The diagnostic's own HTTP client traffic carries no tripwire at all: it is issued from
    THIS process, which never has the hook on its path.
    """
    env = {
        "PATH": "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if tripwire_dir:
        env["PYTHONPATH"] = tripwire_dir
    if report_path:
        env["KEYLESS_TRIPWIRE_REPORT"] = report_path
        env["KEYLESS_TRIPWIRE_ROLE"] = role
    env.update(extra)
    return env


def install_tripwire(directory: str) -> str:
    """Place the test-only hook as `sitecustomize.py`. It exists only for the life of this run."""
    target = os.path.join(directory, "sitecustomize.py")
    shutil.copyfile(TRIPWIRE_SOURCE, target)
    return target


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def http(method: str, url: str, body: object) -> tuple[int, bytes]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def run_bounded(argv: list[str], env: dict[str, str], timeout: int) -> tuple[int | None, str, str]:
    """Run to completion, and treat "it kept running" as a distinguishable outcome rather than a crash.

    A configuration that should refuse but instead SERVES would otherwise surface as an unhandled
    `TimeoutExpired` from the harness — which reads like a flaky test rather than the finding it is.
    Returns `(returncode, stdout, stderr)`; `returncode is None` means it never terminated.
    """
    try:
        completed = subprocess.run(  # noqa: S603
            argv, env=env, cwd="/app", capture_output=True, text=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired as expired:
        return None, expired.output or "", f"process was still running after {timeout}s"
    return completed.returncode, completed.stdout, completed.stderr


def read_report(path: str) -> dict[str, object]:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def assert_clean_report(scenario: str, report: dict[str, object], *, expect_server_loop: bool) -> None:
    """The properties the tripwire exists for, asserted separately so none hides another."""
    if not report:
        fail(scenario, "the tripwire wrote no report; instrumentation did not load")
        return
    if not INSTRUMENTATION.get("validated"):
        fail(
            scenario,
            "the tripwire's own negative controls did not pass, so an empty attempt list from this "
            "server is unobserved silence, not evidence of zero attempts",
        )
    if report.get("role") != "server":
        fail(scenario, f"this report is labelled {report.get('role')!r}, not the server under test")

    # FRESHNESS FIRST, because everything below is an empty list either way. A report written before
    # the application was loaded — which is what an exit-only refresh leaves behind when the exit hook
    # does not run — says `forbidden_modules: []` for the same reason a blank page does.
    observation = report.get("observation")
    if not isinstance(observation, dict):
        fail(scenario, "the report carries no observation metadata, so its freshness is unknown")
        return
    reached = set(observation.get("reached") or [])
    missing = [name for name in ("asyncio", "uvicorn", "fastapi", "graph_service.staging_entry") if name not in reached]
    if missing:
        fail(
            scenario,
            f"the report never observed {missing}: it was written before the application was loaded "
            f"({observation!r}), so its empty findings are about a process that had not started yet",
        )

    attempts = report.get("outbound_attempts")
    if attempts:
        fail(scenario, f"the server attempted outbound connections: {attempts!r}")
    forbidden = report.get("forbidden_modules")
    if forbidden:
        fail(scenario, f"the server imported modules the keyless mode must never import: {forbidden!r}")
    # Strictly stronger than the line above: an import that FAILED leaves no trace in `sys.modules`
    # but still proves the keyless branch reached for something it must never reach for.
    requested = report.get("forbidden_module_requests")
    if requested:
        fail(scenario, f"the server ATTEMPTED to import modules the keyless mode must never touch: {requested!r}")
    clients = report.get("client_modules_present") or report.get("client_module_requests")
    if clients:
        # Bounded defence in depth. Absence proves nothing on its own — a bare socket call needs no
        # client library — which is why it sits alongside the attempt instrumentation, not instead.
        fail(scenario, f"the server loaded HTTP/telemetry client modules it has no use for: {clients!r}")
    if expect_server_loop:
        loop = report.get("event_loop") or {}
        if not isinstance(loop, dict):
            fail(scenario, f"the report carries no event-loop evidence: {loop!r}")
            return
        # The hooks are patches on Python's `socket` module. A uvloop server resolves and connects
        # inside libuv, where they cannot see — so its empty attempt list would mean "unobserved",
        # not "none". This is the assertion that keeps that from being a silent blind spot.
        if loop.get("uvloop_loaded"):
            fail(
                scenario,
                "the server loaded uvloop, whose resolution and connect bypass Python's socket "
                "module: the tripwire cannot observe outbound work on that loop",
            )
        if not loop.get("asyncio_loaded"):
            fail(scenario, f"the server did not run on asyncio, so hook compatibility is unproven: {loop!r}")


# ── scenario 0: the instrumentation itself, proved by negative controls ────────────────────────────

#: Set by `scenario_instrumentation_controls`. Every later "zero outbound attempts" claim is
#: conditioned on it, because an unproven hook and a silent server produce the identical report.
INSTRUMENTATION: dict[str, object] = {"validated": False}

NEGATIVE_CONTROL_PROBE = """
import json
import socket
import urllib.request

results = {}

# (a) DNS-FIRST, and SWALLOWED. This is the shape the old connect-only hook could not see at all:
# `urlopen` resolves before it connects, resolution fails immediately in a no-network container, and
# a caller that catches the error leaves no trace. The hook must record it before the resolver runs.
try:
    urllib.request.urlopen("http://%(hostname)s:8080/probe", timeout=2)
    results["dns_first"] = "unexpectedly succeeded"
except Exception as error:
    results["dns_first"] = type(error).__name__

# (b) DIRECT IP: no name to resolve, so only the connect hook can see it. Retained because dropping
# the connect verbs in favour of resolution hooks would open the mirror-image blind spot.
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    probe.connect(("%(ip)s", 9))
    results["direct_ip"] = "unexpectedly succeeded"
except Exception as error:
    results["direct_ip"] = type(error).__name__
finally:
    probe.close()

# (c) `connect_ex`, whose contract is to RETURN an errno rather than raise — a caller written against
# it swallows failure by construction.
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    results["connect_ex"] = repr(probe.connect_ex(("%(ip_ex)s", 9)))
except Exception as error:
    results["connect_ex"] = type(error).__name__
finally:
    probe.close()

# (d) POSITIVE control for the hook's SCOPE: loopback resolution must still work. A tripwire that
# refused everything would report zero outbound attempts from a server that never managed to bind,
# and that is not the finding it would look like.
try:
    socket.getaddrinfo("127.0.0.1", 8000, socket.AF_INET, socket.SOCK_STREAM)
    results["loopback_resolution"] = "allowed"
except Exception as error:
    results["loopback_resolution"] = "REFUSED: " + type(error).__name__

print(json.dumps(results))
""" % {"hostname": CONTROL_HOSTNAME, "ip": CONTROL_IP, "ip_ex": CONTROL_IP_CONNECT_EX}


def scenario_instrumentation_controls(workdir: str) -> None:
    """Prove the hook fires — on a resolved name, on a raw IP, and on a caller that swallows both."""
    scenario = "instrumentation-controls"
    tripwire_dir = os.path.join(workdir, "tripwire-controls")
    os.makedirs(tripwire_dir, exist_ok=True)
    install_tripwire(tripwire_dir)
    report_path = os.path.join(workdir, "instrumentation-controls.json")
    returncode, stdout, stderr = run_bounded(
        [VENV_PYTHON, "-c", NEGATIVE_CONTROL_PROBE],
        base_environment({}, tripwire_dir, report_path, role="negative-control"),
        120,
    )
    report = read_report(report_path)
    evidence["instrumentation_controls"] = {
        "returncode": returncode,
        "probe_stdout": stdout.strip()[-800:],
        "probe_stderr": stderr.strip()[-800:],
        "tripwire": report,
    }

    if returncode != 0:
        # The control must survive its own attempts. If it died, "detected even when the caller
        # catches the exception" is not what was demonstrated.
        fail(scenario, f"the control process exited {returncode}: {(stdout + stderr)[-800:]}")
        return
    try:
        probe = json.loads(stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        fail(scenario, f"the control process printed no result: {stdout[-400:]!r}")
        return
    if not report:
        fail(scenario, "the control wrote no tripwire report; the hook did not load at all")
        return
    if report.get("role") != "negative-control":
        fail(scenario, f"the control's report is labelled {report.get('role')!r}")

    attempts = [a for a in (report.get("outbound_attempts") or []) if isinstance(a, dict)]
    recorded = [f"{a.get('verb')} {a.get('address')}" for a in attempts]

    def recorded_attempt(verb: str, needle: str) -> bool:
        # Exact verb, not a prefix: `socket.connect` must not be satisfied by a `socket.connect_ex`
        # record, or one working hook would vouch for the other.
        return any(a.get("verb") == verb and needle in str(a.get("address", "")) for a in attempts)

    # THE finding this whole scenario exists for. Without the resolver hook this is exactly what
    # comes back empty while everything else still looks fine.
    if not recorded_attempt("socket.getaddrinfo", CONTROL_HOSTNAME):
        fail(
            scenario,
            f"a DNS-first outbound attempt to {CONTROL_HOSTNAME} was NOT recorded ({recorded!r}); "
            "the tripwire cannot see resolution, so no server's empty report proves zero attempts",
        )
    if not recorded_attempt("socket.connect", CONTROL_IP):
        fail(scenario, f"a direct-IP connect to {CONTROL_IP} was NOT recorded ({recorded!r})")
    if not recorded_attempt("socket.connect_ex", CONTROL_IP_CONNECT_EX):
        fail(scenario, f"a direct-IP connect_ex to {CONTROL_IP_CONNECT_EX} was NOT recorded ({recorded!r})")
    # The caller swallowed everything and still exited 0 — detection did not depend on it crashing.
    for key in ("dns_first", "direct_ip", "connect_ex"):
        if probe.get(key) == "unexpectedly succeeded":
            fail(scenario, f"the {key} control reported success; it must never reach anything")
    if probe.get("loopback_resolution") != "allowed":
        fail(
            scenario,
            f"loopback resolution was refused ({probe.get('loopback_resolution')!r}); the tripwire "
            "would prevent the health server from binding and its silence would mean nothing",
        )

    INSTRUMENTATION["validated"] = not any(f.startswith(scenario + ":") for f in failures)
    INSTRUMENTATION["recorded"] = recorded
    INSTRUMENTATION["hooked_verbs"] = report.get("hooked_verbs")
    INSTRUMENTATION["unhooked_verbs"] = report.get("unhooked_verbs")
    INSTRUMENTATION["local_resolutions_permitted"] = report.get("local_resolution_count")


# ── scenario 1: the keyless sidecar actually serves, and refuses ───────────────────────────────────


def scenario_keyless_serving(workdir: str, scenario: str, extra_env: dict[str, str]) -> None:
    """Start the real launch target and probe it. Run once per accepted staging declaration."""
    tripwire_dir = os.path.join(workdir, f"tripwire-{scenario}")
    os.makedirs(tripwire_dir, exist_ok=True)
    install_tripwire(tripwire_dir)
    report_path = os.path.join(workdir, f"{scenario}-report.json")
    port = free_port()

    env = base_environment(
        {
            # NO NEO4J_* of any kind: the mode must not need a database, because its health is
            # liveness, not readiness.
            "STAGING_OPS_ENVIRONMENT_ID": STAGING_ENV_ID,
            "RAILWAY_ENVIRONMENT_ID": STAGING_ENV_ID,
            **extra_env,
        },
        tripwire_dir,
        report_path,
    )
    process = subprocess.Popen(
        [VENV_UVICORN, ENTRY_TARGET, "--host", "127.0.0.1", "--port", str(port)],
        env=env,
        cwd="/app",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 45
        health: tuple[int, bytes] | None = None
        while time.time() < deadline:
            if process.poll() is not None:
                fail(scenario, f"the server exited during startup with code {process.returncode}")
                break
            try:
                health = http("GET", f"{base}/healthcheck", None)
                break
            except (urllib.error.URLError, OSError):
                time.sleep(0.25)
        if health is None:
            fail(scenario, "health never answered")
        else:
            status, body = health
            payload = json.loads(body or b"{}")
            evidence[f"{scenario}/health"] = {"status": status, "body": payload}
            if status != 200:
                fail(scenario, f"GET /healthcheck returned {status}")
            if payload.get("status") != "healthy":
                fail(scenario, f"health does not report the existing `healthy` status: {payload!r}")
            if payload.get("mode") != KEYLESS_MODE_NAME:
                fail(scenario, f"health does not name the no-model mode: {payload!r}")
            # Health must NOT claim graph or database readiness; it has touched neither.
            for forbidden_key in ("graph", "database", "neo4j", "ready"):
                if forbidden_key in payload:
                    fail(scenario, f"health claims `{forbidden_key}`, which this mode cannot know")

            head_status, _ = http("HEAD", f"{base}/healthcheck", None)
            if head_status != 200:
                fail(scenario, f"HEAD /healthcheck returned {head_status}, expected 200")

            refusals: dict[str, object] = {}
            for method, path, body_in in REFUSED_REQUESTS:
                status, raw = http(method, f"{base}{path}", body_in)
                try:
                    payload = json.loads(raw or b"{}")
                except ValueError:
                    payload = {"_raw": raw[:200].decode("utf-8", "replace")}
                refusals[f"{method} {path}"] = {"status": status, "body": payload}
                if status != 403:
                    fail(scenario, f"{method} {path} returned {status}, expected 403")
                elif payload.get("error") != REFUSAL_CODE:
                    fail(scenario, f"{method} {path} returned 403 without the named refusal: {payload!r}")
                # A 202/200 here would mean work was accepted. Named explicitly because "not 403" and
                # "accepted a job" are different failures and the second is the dangerous one.
                if status in (200, 201, 202):
                    fail(scenario, f"{method} {path} ACCEPTED work in keyless mode: {status}")
            evidence[f"{scenario}/refusals"] = refusals
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            output = process.communicate(timeout=30)[0]
        except subprocess.TimeoutExpired:
            process.kill()
            output = process.communicate()[0]
            fail(scenario, "the server did not shut down within 30s of SIGTERM")
        evidence[f"{scenario}/log_tail"] = (output or "")[-4000:]
        if process.returncode not in (0, -signal.SIGTERM):
            fail(scenario, f"shutdown did not complete cleanly: exit code {process.returncode}")

    report = read_report(report_path)
    evidence[f"{scenario}/tripwire"] = report
    assert_clean_report(scenario, report, expect_server_loop=True)
    # No routers imported means no `AsyncWorker`, no `asyncio.Queue` and therefore nothing that could
    # have queued the requests above. Asserted separately from the forbidden-module list so the
    # queue-absence claim has its own failing assertion rather than riding on a general one.
    if "graph_service.routers" in (report.get("forbidden_modules") or []):
        fail(scenario, "the ingest router (and with it the episode queue) was imported")
    if "graph_service.routers.ingest" in (report.get("graph_service_modules") or []):
        fail(scenario, "the ingest router module was loaded, so an episode queue exists")


# ── scenario 2: refusing configurations fail before production is imported ─────────────────────────


def scenario_startup_refusals(workdir: str) -> None:
    scenario = "startup-refusals"
    results: dict[str, object] = {}
    for index, (label, extra, reason) in enumerate(REFUSING_ENVIRONMENTS):
        tripwire_dir = os.path.join(workdir, f"tripwire-refusal-{index}")
        os.makedirs(tripwire_dir, exist_ok=True)
        install_tripwire(tripwire_dir)
        report_path = os.path.join(workdir, f"refusal-{index}.json")
        returncode, stdout, stderr = run_bounded(
            [VENV_PYTHON, "-c", "import graph_service.staging_entry as entry; entry.app"],
            base_environment(extra, tripwire_dir, report_path),
            120,
        )
        output = stdout + stderr
        report = read_report(report_path)
        results[label] = {
            "returncode": returncode,
            "reason_named": reason in output,
            "forbidden_modules": report.get("forbidden_modules"),
        }
        if returncode == 0:
            fail(scenario, f"[{label}] resolving `app` succeeded; it must refuse")
        if returncode is None:
            fail(scenario, f"[{label}] resolving `app` never terminated; it must refuse")
        if reason not in output:
            fail(scenario, f"[{label}] refusal does not name `{reason}`: {output[-600:]}")
        if "StagingEntryConfigurationError" not in output:
            fail(scenario, f"[{label}] refusal is not the entry module's own error: {output[-600:]}")
        # The whole point of the refusal: the production application is never reached. Both the
        # loaded set and the REQUESTED set, because a refusal that reached for `graph_service.main`
        # and failed would leave nothing in `sys.modules` to find.
        if report.get("forbidden_modules"):
            fail(scenario, f"[{label}] refused only AFTER importing {report['forbidden_modules']!r}")
        if report.get("forbidden_module_requests"):
            fail(scenario, f"[{label}] reached for {report['forbidden_module_requests']!r} before refusing")
        if report.get("outbound_attempts"):
            fail(scenario, f"[{label}] attempted an outbound connection before refusing")

    # ...and the same refusal through the real launch command, not only through an import.
    tripwire_dir = os.path.join(workdir, "tripwire-refusal-uvicorn")
    os.makedirs(tripwire_dir, exist_ok=True)
    install_tripwire(tripwire_dir)
    report_path = os.path.join(workdir, "refusal-uvicorn.json")
    returncode, launch_stdout, launch_stderr = run_bounded(
        [VENV_UVICORN, ENTRY_TARGET, "--host", "127.0.0.1", "--port", str(free_port())],
        base_environment(
            {"STAGING_OPS_ENVIRONMENT_ID": STAGING_ENV_ID, "RAILWAY_ENVIRONMENT_ID": OTHER_ENV_ID},
            tripwire_dir,
            report_path,
        ),
        120,
    )
    launch_output = launch_stdout + launch_stderr
    results["uvicorn launch with a mismatched pin"] = {
        "returncode": returncode,
        "reason_named": "pinned-environment-mismatch" in launch_output,
    }
    if returncode == 0:
        fail(scenario, "the launch command started despite a mismatched pin")
    if returncode is None:
        fail(scenario, "the launch command kept running despite a mismatched pin")
    if "pinned-environment-mismatch" not in launch_output:
        fail(scenario, f"the launch refusal does not name its reason: {launch_output[-600:]}")
    if read_report(report_path).get("forbidden_modules"):
        fail(scenario, "the launch refusal imported the production application first")
    evidence["startup_refusals"] = results


# ── scenario 3: an unpinned deployment gets the ORIGINAL application object ────────────────────────

DELEGATION_PROBE = """
import json
import graph_service.main as main

SENTINEL = "aios-delegation-sentinel-4f2a"
# Set BEFORE the entry module is imported, so identity is the only way the sentinel can appear on the
# object the entry module exports. A re-created FastAPI app with identical routes would not carry it.
main.app.state.aios_delegation_sentinel = SENTINEL

import graph_service.staging_entry as entry

app = entry.app
print(json.dumps({
    "identical": app is main.app,
    "sentinel": getattr(app.state, "aios_delegation_sentinel", None),
    "routes": sorted({getattr(route, "path", None) for route in app.routes}),
    "lifespan_identical": app.router.lifespan_context is main.app.router.lifespan_context,
}))
"""


def scenario_production_delegation(workdir: str) -> None:
    scenario = "production-delegation"
    tripwire_dir = os.path.join(workdir, "tripwire-delegation")
    os.makedirs(tripwire_dir, exist_ok=True)
    install_tripwire(tripwire_dir)
    returncode, stdout, stderr = run_bounded(
        [VENV_PYTHON, "-c", DELEGATION_PROBE],
        # Unpinned, no copy claim, and — deliberately — no provider credential of any kind. Importing
        # the production application needs none; only its lifespan does, which scenario 4 exercises.
        base_environment({}, tripwire_dir, os.path.join(workdir, "delegation.json")),
        120,
    )
    if returncode != 0:
        fail(scenario, f"the delegation probe failed: {(stdout + stderr)[-800:]}")
        return
    result = json.loads(stdout.strip().splitlines()[-1])
    evidence["production_delegation"] = result
    if not result["identical"]:
        fail(scenario, "the entry module exported a DIFFERENT object than graph_service.main.app")
    if result["sentinel"] != "aios-delegation-sentinel-4f2a":
        fail(scenario, f"the exported app does not carry the pre-set sentinel: {result!r}")
    if not result["lifespan_identical"]:
        fail(scenario, "the exported app does not carry the original lifespan")
    missing = [path for path in UPSTREAM_ROUTE_PATHS if path not in result["routes"]]
    if missing:
        fail(scenario, f"upstream routes missing from the delegated app: {missing}")


# ── scenario 4: production still fails without a key, in the real image ────────────────────────────


def scenario_production_negative_control(workdir: str) -> None:
    scenario = "production-negative-control"
    returncode, stdout, stderr = run_bounded(
        [VENV_UVICORN, ENTRY_TARGET, "--host", "127.0.0.1", "--port", str(free_port())],
        # No pin, no claim, no key. Under the previous CMD this configuration failed at startup on
        # `openai_api_key`; it must still do so. A keyless-mode change that let production boot
        # without a key would be a far larger change than the one authorised.
        base_environment({}, None, None),
        180,
    )
    output = stdout + stderr
    evidence["production_negative_control"] = {"returncode": returncode, "log_tail": output[-3000:]}
    if returncode == 0:
        fail(scenario, "an unpinned, keyless production configuration started; it must not")
    if returncode is None:
        fail(scenario, "an unpinned, keyless production configuration kept running; it must not")
    if "Application startup complete" in output:
        fail(scenario, "the production application completed startup with no provider key")
    if "openai_api_key" not in output:
        fail(
            scenario,
            "the preserved failure is not the Settings one; the image's startup path may have "
            f"changed: {output[-1500:]}",
        )


# ── image identity, recorded rather than assumed ───────────────────────────────────────────────────


def collect_image_evidence() -> None:
    def digest(path: str) -> str | None:
        try:
            with open(path, "rb") as handle:
                return hashlib.sha256(handle.read()).hexdigest()
        except OSError:
            return None

    package_init = "/app/graph_service/__init__.py"
    try:
        with open(package_init, encoding="utf-8") as handle:
            init_source = handle.read()
    except OSError:
        init_source = ""
    evidence["image"] = {
        "python": sys.version,
        "installed_entry_sha256": digest(INSTALLED_ENTRY),
        "graph_service_init_bytes": len(init_source),
        "graph_service_init_source": init_source,
        # `Settings` reads `env_file='.env'`. If the image shipped one containing a key, the negative
        # control above would pass for the wrong reason — so the fact is recorded, not assumed.
        "app_dotenv_present": os.path.exists("/app/.env"),
        "diagnostic_sha256": digest(os.path.abspath(__file__)),
        "tripwire_sha256": digest(TRIPWIRE_SOURCE),
        # NAMES ONLY, never values. This is the honest statement of L5: the scenarios below run in a
        # small stated environment, NOT the image's baked ENV, so they are not byte-identical to a
        # platform launch. The difference is deliberate isolation — nothing ambient can make a
        # keyless run look keyless while a credential sits in the process — and recording both lists
        # lets a reader see exactly what was withheld instead of taking the claim on trust.
        "container_env_names": sorted(os.environ),
        "scenario_env_names": sorted(base_environment({}, "<tripwire-dir>", "<report>").keys()),
    }
    # A non-empty package `__init__` could drag the production application in through the entry
    # module's own package. Scenario 1's forbidden-module assertion is what would catch it; this makes
    # the input to that assertion visible in the report either way.
    if init_source.strip():
        print(
            f"NOTE /app/graph_service/__init__.py is not empty ({len(init_source)} bytes); "
            "scenario 1's import assertions are the check that matters",
            file=sys.stderr,
        )


def main() -> int:
    if not os.path.exists(INSTALLED_ENTRY):
        print(f"FAIL the image does not contain {INSTALLED_ENTRY}", file=sys.stderr)
        return 1
    collect_image_evidence()
    with tempfile.TemporaryDirectory(prefix="keyless-diagnostic-") as workdir:
        # FIRST, because every later "zero outbound attempts" depends on it: prove the hook fires on
        # a resolved name and on a raw IP even when the caller swallows the failure. A control that
        # fails fails THIS DIAGNOSTIC — it is never counted as a passing keyless server.
        scenario_instrumentation_controls(workdir)
        # The commissioning baseline: pinned, legacy-pg-only, before any bootstrap has run, with no
        # provider credential present at all.
        scenario_keyless_serving(
            workdir, "keyless-serving-legacy", {"STAGING_DATA_MODE": "legacy-pg-only"}
        )
        # The copied-staging declaration, with a credential-shaped string PRESENT. It proves the
        # branch is selected by ENVIRONMENT IDENTITY, not by a key happening to be absent: the server
        # must still import no provider client and attempt no outbound connection. The value is a
        # sentinel that cannot authenticate to anything, it exists only in this process's environment
        # inside a network-disabled container, and it is never written to a file or into the image.
        # Live commissioning removes provider variables independently; preflight still rejects them.
        scenario_keyless_serving(
            workdir,
            "keyless-serving-copy-ready-with-credential-present",
            {
                "STAGING_DATA_MODE": "copy-ready",
                "STAGING_COPY_MODE_ACTIVATED": "true",
                "OPENAI_API_KEY": "not-a-credential-aios997-diagnostic-sentinel",
            },
        )
        scenario_startup_refusals(workdir)
        scenario_production_delegation(workdir)
        scenario_production_negative_control(workdir)
    print(
        json.dumps(
            {"failures": failures, "instrumentation": INSTRUMENTATION, "evidence": evidence},
            indent=2,
            sort_keys=True,
        )
    )
    if failures:
        print(f"\n{len(failures)} FAILURE(S)", file=sys.stderr)
        return 1
    print("\nkeyless staging Graphiti: all scenarios passed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
