from pathlib import Path
import datetime
import hashlib
import json
import re
import shutil
import subprocess

H = Path("/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff")
W = H.parent / "aio1217-worktree"
PACKET = H / "review-public-support/f4-e3-remaining-adm-paired-pg/packet"
REQUEST = PACKET / "parent-execution-request.json"
FIXTURE = "test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts"
TABLES = {
    "audit_log",
    "group_members",
    "groups",
    "ingest_runs",
    "integrations",
    "members",
    "projects",
    "task_pm_links",
    "tasks",
    "teams",
}
OWNERS = ["lib/pm-sync/reconcile.ts", "app/t/[team]/admin/pm-sync/actions.ts"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def output(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def names_for(role):
    names = [
        "case01-first-pass",
        "case02-first-pass",
        "case02-unchanged-rerun",
        "case03-admitted-control",
        "case03-missing-cookie",
        "case03-role-member",
        "case03-external-only",
        "case03-foreign-team-admin",
    ]
    for provider in ("linear", "plane"):
        for state in ("missing", "disabled", "secret-less"):
            names += [
                f"case04-{provider}-{state}-member-guard-control",
                f"case04-{provider}-{state}-main",
            ]
            if role == "candidate":
                names.append(f"case04-{provider}-{state}-repeat")
    names += [
        "case05-no-links",
        "case06-plane-linked-first",
        "case06-plane-linked-repeat",
        "case06-plane-no-links-first",
        "case06-plane-no-links-repeat",
        "case07-none-enabled",
        "case07-multiple-enabled",
        "case08-linear-fallback",
        "case08-plane-fallback",
        "case09-first-pass",
        "case09-moved-board",
        "case09-unchanged-rerun",
        "case10-unknown-team-first",
        "case10-admitted-control",
        "case10-unknown-team-repeat",
        "case11-malformed-cookie",
        "case11-altered-signature",
        "case11-other-secret",
        "case11-admitted-control",
        "case11-other-secret-repeat",
        "case12-memberless",
        "case12-invited",
        "case12-disabled",
        "case12-lead",
        "case12-admitted-control",
        "case13-legacy-team-external-only",
        "case13-legacy-external-everyone-admitted",
        "case13-legacy-team-repeat",
        "case14-associated-first",
        "case14-everyone-removed",
        "case14-everyone-restored",
        "case15-bob-at-team-a",
        "case15-alice-at-team-b",
        "case15-bob-at-team-b-admitted",
        "case15-alice-team-a-control",
    ]
    return names


def load_records(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def require_complete_records(records):
    for index, record in enumerate(records):
        assert set(record) == {
            "startedAt",
            "endedAt",
            "outcome",
            "trace",
            "bound",
            "seams",
            "acquired",
            "revalidated",
            "refused",
            "violations",
            "before",
            "after",
        }, (index, sorted(record))
        assert record["startedAt"] and record["endedAt"]
        assert set(record["before"]) == TABLES, (index, sorted(record["before"]))
        assert set(record["after"]) == TABLES, (index, sorted(record["after"]))
        assert record["violations"] == [], index


request = json.loads(REQUEST.read_text())
helper = Path(request["helper"]["path"])
runner = Path(request["runner"]["path"])
assert sha(helper) == request["helper"]["sha256"]
assert sha(runner) == request["runner"]["sha256"]
assert sha(__file__) == request["hostScript"]["sha256"]
assert sha(W / FIXTURE) == request["fixture"]["sha256"]
assert output(["git", "rev-parse", "HEAD"], W) == request["localCheckpoint"]
assert output(["git", "status", "--porcelain"], W) == ""
assert output(["docker", "port", request["database"]["container"], "5432/tcp"]) == "127.0.0.1:50538"
identity = output(
    ["docker", "inspect", "--format", "{{.Name}} {{.Config.Image}}", request["database"]["container"]]
)
assert identity.startswith("/aios-aio1217-pg-8a4e78cb ") and "postgres" in identity

base = request["candidateRuntimeBase"]
reference = request["referenceOwnerCommit"]
temp_root = Path("/private/tmp") / (
    "aio1217-remaining-adm-paired-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
)
temp_root.mkdir()
result = {
    "kind": "AIO-1217_F4_E3_REMAINING_ADM_PAIRED_NATIVE_PG_RESULT",
    "utcStarted": utc(),
    "executedHelperSha256": sha(helper),
    "hostScriptSha256": sha(__file__),
    "runnerSha256": sha(runner),
    "requestSha256": sha(REQUEST),
    "localCheckpoint": request["localCheckpoint"],
    "remoteAtPreparation": request["remoteAtPreparation"],
    "candidateRuntimeBase": base,
    "referenceOwnerCommit": reference,
    "dedicatedDatabase": {
        "container": request["database"]["container"],
        "mapping": "127.0.0.1:50538",
        "identity": identity,
        "syntheticOnly": True,
    },
    "serialOrder": ["reference", "candidate"],
    "runs": [],
    "acceptanceGranted": False,
}
result_path = H / "f4-e3-remaining-adm-paired-parent.result.json"

for role, expected_class in (("reference", "nonzero"), ("candidate", "zero")):
    layout = temp_root / role
    layout.mkdir()
    runtime_worktree = layout / "aio1217-worktree"
    runtime_handoff = layout / "aio1217-handoff"
    runtime_handoff.mkdir()
    subprocess.run(["git", "clone", "--quiet", "--no-hardlinks", str(W), str(runtime_worktree)], check=True)
    subprocess.run(["git", "checkout", "--quiet", "--detach", base], cwd=runtime_worktree, check=True)
    (runtime_worktree / "node_modules").symlink_to(W / "node_modules", target_is_directory=True)
    shutil.copyfile(W / FIXTURE, runtime_worktree / FIXTURE)
    if role == "reference":
        for owner in OWNERS:
            (runtime_worktree / owner).write_bytes(
                subprocess.check_output(["git", "show", reference + ":" + owner], cwd=W)
            )
    assert sha(runtime_worktree / FIXTURE) == request["fixture"]["sha256"]
    mapping = output(["docker", "port", request["database"]["container"], "5432/tcp"])
    assert mapping == "127.0.0.1:50538"

    stage = "f4e3_remaining_adm_" + role
    command = [
        "zsh",
        str(helper),
        role,
        expected_class,
        str(runtime_worktree),
        str(runtime_handoff),
        stage,
    ]
    run = {
        "role": role,
        "utcStarted": utc(),
        "expectedExitClass": expected_class,
        "actualGitHead": output(["git", "rev-parse", "HEAD"], runtime_worktree),
        "fixtureOverlaySha256": sha(runtime_worktree / FIXTURE),
        "command": command,
        "ownedPgMapping": mapping,
        "substitutions": OWNERS if role == "reference" else [],
        "ownerSha256": {owner: sha(runtime_worktree / owner) for owner in OWNERS},
        "configSha256": sha(runtime_worktree / "vitest.datamechanics.config.ts"),
        "packageLockSha256": sha(runtime_worktree / "package-lock.json"),
        "dependencyTarget": str(W / "node_modules"),
    }
    with (runtime_handoff / "parent-command.log").open("w") as log:
        completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    run["helperExit"] = completed.returncode
    run["utcFinished"] = utc()
    assert completed.returncode == 0

    evidence = H / ("f4-e3-remaining-adm-paired-" + role)
    assert not evidence.exists()
    evidence.mkdir()
    for artifact in runtime_handoff.iterdir():
        if artifact.is_file():
            shutil.copyfile(artifact, evidence / artifact.name)
    raw_records = runtime_worktree / ".context/aio1217-e4-observation-records/requests.jsonl"
    shutil.copyfile(raw_records, evidence / "requests.jsonl")
    records = load_records(raw_records)
    names = names_for(role)
    assert len(records) == len(names), (role, len(records), len(names))
    require_complete_records(records)
    with (evidence / "named-requests.jsonl").open("w") as named:
        for ordinal, (name, record) in enumerate(zip(names, records), 1):
            named.write(
                json.dumps(
                    {"runtime": role, "ordinal": ordinal, "requestName": name, "request": record},
                    separators=(",", ":"),
                )
                + "\n"
            )

    log_text = ANSI.sub("", (evidence / f"{stage}.log").read_text(errors="replace"))
    fail_headers = [
        line for line in log_text.splitlines() if " FAIL " in line and FIXTURE in line and " > " in line
    ]
    if role == "reference":
        assert len(fail_headers) == 6, fail_headers
        joined = "\n".join(fail_headers)
        for provider in ("linear", "plane"):
            for state in ("missing", "disabled", "secret-less"):
                assert provider in joined and state in joined
    else:
        assert fail_headers == [], fail_headers
    for case in range(9, 16):
        assert f"✓ {case} —" in log_text, (role, case)

    check_result = json.loads((evidence / f"{stage}.result.json").read_text())
    provenance = json.loads((evidence / f"{stage}.provenance.json").read_text())
    environment = json.loads((evidence / f"{stage}.environment.json").read_text())
    assert check_result["unchanged"] is True and check_result["testUnchanged"] is True
    assert provenance["runnerSha256"] == request["runner"]["sha256"]
    assert environment["container"].startswith("/aios-aio1217-pg-8a4e78cb ")
    assert environment["postgresPort"] == 50538

    tracked = output(["git", "ls-files"], runtime_worktree).splitlines()
    source_map = {path: sha(runtime_worktree / path) for path in tracked if (runtime_worktree / path).is_file()}
    (evidence / "full-source-file-map.json").write_text(json.dumps(source_map, indent=2) + "\n")
    for index, owner in enumerate(OWNERS):
        (evidence / f"owner-{index}.ts").write_bytes((runtime_worktree / owner).read_bytes())

    run.update(
        {
            "recordCount": len(records),
            "requestNames": names,
            "allRequestRecordsComplete": True,
            "wholeTenTableSnapshotsEveryRequest": True,
            "nativeCasesPassingInLog": list(range(9, 16)),
            "failureHeaders": fail_headers,
            "productionBefore": check_result["productionBefore"],
            "productionAfter": check_result["productionAfter"],
            "testBefore": check_result["testBefore"],
            "testAfter": check_result["testAfter"],
            "sourceFileMapSha256": sha(evidence / "full-source-file-map.json"),
            "evidencePath": str(evidence),
        }
    )
    (evidence / "composite-runtime.json").write_text(json.dumps(run, indent=2) + "\n")
    run["artifactHashes"] = {
        artifact.name: {"sha256": sha(artifact), "bytes": artifact.stat().st_size}
        for artifact in sorted(evidence.iterdir())
        if artifact.is_file()
    }
    result["runs"].append(run)
    result_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"role": role, "records": len(records), "evidence": str(evidence)}), flush=True)

assert output(["git", "rev-parse", "HEAD"], W) == request["localCheckpoint"]
assert output(["git", "status", "--porcelain"], W) == ""
reference_run, candidate_run = result["runs"]
differences = [
    path
    for path, digest in json.loads(
        (Path(reference_run["evidencePath"]) / "full-source-file-map.json").read_text()
    ).items()
    if json.loads((Path(candidate_run["evidencePath"]) / "full-source-file-map.json").read_text()).get(path)
    != digest
]
assert sorted(differences) == sorted(OWNERS), differences
assert reference_run["testBefore"] == candidate_run["testBefore"]
assert reference_run["testAfter"] == candidate_run["testAfter"]

named = {}
for run in result["runs"]:
    rows = [
        json.loads(line)
        for line in (Path(run["evidencePath"]) / "named-requests.jsonl").read_text().splitlines()
    ]
    named[run["role"]] = {row["requestName"]: row["request"] for row in rows}

classification = {"cells": [], "nativeCases": list(range(9, 16))}
for provider in ("linear", "plane"):
    for state in ("missing", "disabled", "secret-less"):
        key = f"case04-{provider}-{state}-main"
        repeat = f"case04-{provider}-{state}-repeat"
        ref_record = named["reference"][key]
        cand_record = named["candidate"][key]
        cand_repeat = named["candidate"][repeat]
        assert ref_record["outcome"]["returned"]["ok"] is True
        assert len(ref_record["after"]["audit_log"]) == len(ref_record["before"]["audit_log"]) + 1
        assert len(ref_record["revalidated"]) == 1
        assert cand_record["outcome"]["returned"] == {
            "ok": False,
            "error": "primary PM integration is unavailable",
        }
        assert cand_record["before"] == cand_record["after"]
        assert cand_record["revalidated"] == []
        assert cand_repeat["outcome"] == cand_record["outcome"]
        assert cand_repeat["trace"] == cand_record["trace"]
        assert cand_repeat["before"] == cand_repeat["after"]
        assert repeat not in named["reference"]
        classification["cells"].append(
            {
                "provider": provider,
                "state": state,
                "reference": "FALSE_SUCCESS_WITH_AUDIT_AND_REVALIDATION",
                "candidate": "EXACT_UNAVAILABLE_REFUSAL_NO_DURABLE_EFFECT",
                "referenceRepeat": "NOT_REACHED_AFTER_EXPECTED_ASSERTION_FAILURE",
                "candidateRepeat": "REACHED_AND_IDENTICAL",
            }
        )

for role in ("reference", "candidate"):
    required = [name for name in names_for(role) if name.startswith(tuple(f"case{x:02d}-" for x in range(11, 16)))]
    assert required and all(name in named[role] for name in required)

result.update(
    {
        "utcFinished": utc(),
        "actualReferenceCandidateFileDifferences": differences,
        "sameFixtureAndTestFingerprintAcrossRuntimes": True,
        "productionFingerprintsStableWithinEachRuntime": True,
        "actualFailureClassification": classification,
        "originalWorktreeUnchanged": True,
        "lintTypecheckReusedNotRerun": request["reuseChecks"],
        "acceptanceGranted": False,
        "nextGate": "freeze all evidence and obtain a fresh independent actual subscription Opus 5.5 HIGH affected pre-push review before any push",
    }
)
result_path.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"complete": True, "result": str(result_path), "sha256": sha(result_path)}), flush=True)
