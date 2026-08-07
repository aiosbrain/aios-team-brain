import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * GUARD: the same-item predecessor filter (PIPEFF-2 / AIO-821) — the script, the Dockerfile gates
 * that apply it, and the SEMANTICS of the code it inserts.
 *
 * The spec's one provable claim is that **the shipped script is the script the measured arm ran**
 * (docs/design/graph-episode-window-phase-c.md, "Verification"). Everything else about this change is
 * a threshold judgement on evidence smaller than the incumbent's own noise; this part is a checksum.
 * So the script is committed byte-for-byte, WITHOUT a repo header comment — a header would change its
 * sha and dissolve the claim — and the `why` lives in `graphiti/Dockerfile` and the spec instead.
 *
 * ── HOW THE SEMANTIC HALF WORKS, AND WHY IT IS BUILT THIS WAY ───────────────────────────────────
 * The behaviour under test is Python that runs inside a vendored library in another container. A
 * TypeScript "mirror" of it would be a paraphrase that can silently diverge from the shipped file —
 * exactly the class of test this repo has been burned by. So this suite does not paraphrase:
 *
 *   1. it pins the committed script's sha256 AND the literal text of the filter expression, then
 *   2. it RUNS the committed script — the same invocation the Dockerfile makes — against a synthetic
 *      host file that reproduces `graphiti.py`'s anchor context at the same indentation, and
 *   3. it EXECUTES the patched result in python3 and asserts on the returned predecessor list.
 *
 * The code exercised in step 3 is therefore literally the code the image will run, inserted by
 * literally the script the image will run. If the script changes, step 1 reddens; if its semantics
 * change, step 3 reddens.
 *
 * python3 is a HARD requirement here, not a skip: a suite that quietly skips itself on a machine
 * without python3 is a guard that disarms without saying so, which is the failure mode half this
 * repo's guards exist to prevent. CI's ubuntu runner ships python3.
 */

const REPO = process.cwd();
const SCRIPT = join(REPO, "graphiti/patch-same-item.py");
const DOCKERFILE = join(REPO, "graphiti/Dockerfile");

/** The measured artifact's checksum, from the spec's verification table. */
const SCRIPT_SHA256 = "94ba6b1918b8df3f34fd44737e79a5c42f9e26a00d0fe498975e255dcdfcf2d6";

/** The anchor the patch keys on — 20 spaces of continuation indent, inside `add_episode`. */
const ANCHOR =
  "                    else await EpisodicNode.get_by_uuids(self.driver, previous_episode_uuids)";

const script = readFileSync(SCRIPT, "utf8");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

describe("the shipped script IS the measured script", () => {
  it("sha256 matches the spec's verification table", () => {
    // A reformat, a rename, or a "helpful" header comment all break this — deliberately. The
    // byte-identity precondition (patched graphiti.py == 49ee534a…) only means anything if the input
    // to the patch is the byte-identical script.
    expect(createHash("sha256").update(readFileSync(SCRIPT)).digest("hex")).toBe(SCRIPT_SHA256);
  });

  it("carries no repo header comment — the sha is why, and the Dockerfile says so", () => {
    expect(script.startsWith("import sys, ast\n")).toBe(true);
    expect(dockerfile).toContain("a header would change that sha");
  });

  it("pins the literal filter expression the patch inserts", () => {
    // The text pin is what makes the python execution below non-paraphrasable: these exact lines are
    // the ones extracted, inserted, and then executed.
    expect(script).toContain("# PIPEFF-2: carry only the SAME ITEM's prior chunks");
    expect(script).toContain("if previous_episode_uuids is None:");
    expect(script).toContain("_own = (name or '').split('#')[0]");
    expect(script).toContain("if (_ep.name or '').split('#')[0] == _own");
  });

  it("is purely additive — it inserts, and removes nothing", () => {
    // The spec's "17 lines inserted, 0 removed": the retrieval call expression is left alone and the
    // filter runs after it, so an explicit `previous_episode_uuids` caller is never silently ignored.
    expect(script).toContain("src.insert(i + 2, ins)");
    expect(script.includes("src.pop(")).toBe(false);
    expect(script.includes("del src[")).toBe(false);
    // It parses what it wrote before writing it — a syntactically broken venv would otherwise ship.
    expect(script).toContain("ast.parse(out)");
  });
});

describe("graphiti/Dockerfile PATCH 3 gates — every one of them fails the BUILD, loudly", () => {
  it("copies the script from the graphiti/ build context", () => {
    // The service builds with `graphiti/` as the context (docker-compose `context: .`, Railway
    // "build from repo graphiti/"), same as constraints.txt — so the COPY source has no directory
    // prefix. A `graphiti/patch-same-item.py` source would fail the build with "file not found".
    expect(dockerfile).toContain("COPY patch-same-item.py /tmp/patch-same-item.py");
    expect(dockerfile).toContain("COPY constraints.txt /tmp/constraints.txt");
  });

  it("pre-state: the anchor exists EXACTLY once, matched as a fixed string", () => {
    expect(dockerfile).toContain(`test "$(grep -cF '${ANCHOR}' "$F")" = "1"`);
  });

  it("runs the script with the VENV python, on the venv's graphiti.py", () => {
    // The venv is the interpreter the server actually imports from (Trap 1 in this file's header).
    expect(dockerfile).toContain("/app/.venv/bin/python /tmp/patch-same-item.py");
    expect(dockerfile).toContain("F=/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py");
  });

  it("post-state: the marker must be present in the patched file", () => {
    expect(dockerfile).toContain("grep -q 'PIPEFF-2: carry only the SAME ITEM' \"$F\"");
  });

  it("untouched-elsewhere: RELEVANT_SCHEMA_LIMIT still appears 15x in search_utils.py", () => {
    // The retrieval-quality knob the parent spec REJECTED changing. Pinning its occurrence count is
    // how this patch is stopped from ever quietly widening into that change.
    expect(dockerfile).toContain(
      'test "$(grep -c RELEVANT_SCHEMA_LIMIT /app/.venv/lib/python3.12/site-packages/graphiti_core/search/search_utils.py)" = "15"'
    );
  });

  it("runs AFTER the pip install and AFTER patch 2 — pip would overwrite an earlier edit", () => {
    const pip = dockerfile.indexOf("'graphiti-core==0.29.3'");
    const patch2 = dockerfile.indexOf("PATCH 2:");
    const patch3 = dockerfile.indexOf("PATCH 3:");
    expect(pip).toBeGreaterThan(-1);
    expect(patch2).toBeGreaterThan(pip);
    expect(patch3).toBeGreaterThan(patch2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * SEMANTICS — the committed script, applied and executed.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * `graphiti.py`'s anchor context, reproduced at the exact indentation the patch requires (the
 * assignment at 16 spaces, the paren continuation at 20). `EpisodicNode`/`self` are injected by the
 * runner below so BOTH branches of the `previous_episode_uuids` guard are actually executable — the
 * guard is part of what is being pinned, so it cannot be a branch this test can never reach.
 */
const HOST_PY = `async def host(name, previous_episodes, previous_episode_uuids):
    if True:
        if True:
            if True:
                previous_episodes = (
                    previous_episodes
                    if previous_episode_uuids is None
${ANCHOR}
                )
                return previous_episodes
`;

const RUNNER_PY = `import asyncio, json, sys, types

class Ep:
    def __init__(self, name):
        self.name = name

class EpisodicNode:
    @staticmethod
    async def get_by_uuids(driver, uuids):
        return [Ep(u) for u in uuids]

host_path, name, prev_json, uuids_json = sys.argv[1:5]
g = {"EpisodicNode": EpisodicNode, "self": types.SimpleNamespace(driver=None)}
exec(compile(open(host_path).read(), "host.py", "exec"), g)
prev = [Ep(n) for n in json.loads(prev_json)]
uuids = json.loads(uuids_json)
out = asyncio.run(g["host"](name, prev, uuids))
print(json.dumps([e.name for e in out]))
`;

let workdir = "";

/** Apply the committed patch script to the synthetic host, exactly as the Dockerfile does. */
beforeAll(() => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  expect(
    py.status,
    "python3 is REQUIRED for this guard — it executes the shipped Python rather than paraphrasing it. Install python3 rather than skipping."
  ).toBe(0);

  workdir = mkdtempSync(join(tmpdir(), "pipeff2-"));
  const hostPath = join(workdir, "host.py");
  writeFileSync(hostPath, HOST_PY);
  writeFileSync(join(workdir, "runner.py"), RUNNER_PY);

  const patched = spawnSync("python3", [SCRIPT, hostPath], { encoding: "utf8" });
  expect(patched.stderr).toBe("");
  expect(patched.status).toBe(0);
  // The script's own success line — its asserts (anchor count, the line that must follow it) and its
  // `ast.parse` all passed. This is the same signal the Dockerfile's RUN relies on.
  expect(patched.stdout.trim()).toBe("patched + parses");
  expect(readFileSync(hostPath, "utf8")).toContain("PIPEFF-2: carry only the SAME ITEM");
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** Run the patched code and return the surviving predecessor names. */
function predecessorsFor(
  name: string,
  previous: (string | null)[],
  uuids: string[] | null
): (string | null)[] {
  const r = spawnSync(
    "python3",
    [
      join(workdir, "runner.py"),
      join(workdir, "host.py"),
      name,
      JSON.stringify(previous),
      JSON.stringify(uuids),
    ],
    { encoding: "utf8" }
  );
  expect(r.stderr, `python runner failed: ${r.stderr}`).toBe("");
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as (string | null)[];
}

describe("the inserted filter, EXECUTED (not paraphrased)", () => {
  it("a non-`items:` episode gets ZERO predecessors — the `correction:<arc_id>` pin", () => {
    // Carried here from the PARENT spec's Risks section so it doesn't fall between two documents.
    // Arc writeback episodes are named `correction:<arc_id>` — no `items:` prefix — so the same-item
    // filter matches nothing and they extract with no predecessor context at all. That IS the
    // intended semantics (a correction is not a chunk of a document), and the requirement was that it
    // be STATED AND PINNED rather than discovered later in a bill or a quality drift.
    const kept = predecessorsFor(
      "correction:arc-42",
      ["items:abc", "items:abc#1", "items:def#3", "correction:arc-7"],
      null
    );
    expect(kept).toEqual([]);
  });

  it("…and two DIFFERENT correction episodes do not carry each other either", () => {
    // The prefix is the whole episode name for a correction (no `#`), so `correction:arc-42` and
    // `correction:arc-7` are different documents. A test that only checked "no items: survive" would
    // pass on a filter that grouped all corrections together.
    expect(predecessorsFor("correction:arc-42", ["correction:arc-7"], null)).toEqual([]);
    // Its own name would survive, which is the honest statement of the rule (identity, not exclusion).
    expect(predecessorsFor("correction:arc-42", ["correction:arc-42"], null)).toEqual([
      "correction:arc-42",
    ]);
  });

  it("a multi-chunk item keeps ALL of its own prior chunks and drops every other document", () => {
    // The claim the whole cost saving rests on: what is removed is other documents, not this
    // document's own context. If this ever reddened, the lever would be a quality change.
    const kept = predecessorsFor(
      "items:abc#3",
      ["items:abc", "items:abc#1", "items:abc#2", "items:def", "items:def#1", "items:ghi#9"],
      null
    );
    expect(kept).toEqual(["items:abc", "items:abc#1", "items:abc#2"]);
  });

  it("a single-chunk item gets ZERO predecessors", () => {
    expect(predecessorsFor("items:solo", ["items:abc#1", "items:def"], null)).toEqual([]);
  });

  it("an explicit `previous_episode_uuids` caller is NOT filtered — the guard, exercised", () => {
    // Guarded on the same condition as the retrieval above it. The REST server never passes uuids, so
    // this branch is dead in prod — but a patch that filtered a caller's deliberate choice would be
    // silently discarding an explicit instruction, and a dead branch nobody executes is how that
    // stays invisible.
    const kept = predecessorsFor("items:abc#3", [], ["items:zzz#1", "correction:arc-7"]);
    expect(kept).toEqual(["items:zzz#1", "correction:arc-7"]);
  });

  it("a null/empty episode name is handled, not crashed on", () => {
    // `(name or '')` / `(_ep.name or '')`: Graphiti's EpisodicNode.name is nullable in principle, and
    // a TypeError inside add_episode would take extraction down for the whole group — a crash in the
    // filter is strictly worse than the ten-episode window it replaces.
    expect(predecessorsFor("", ["items:abc"], null)).toEqual([]);
    // A null-named predecessor normalises to '' and so belongs to a '' -named episode, not to
    // everyone: the `or ''` must not become a wildcard.
    expect(predecessorsFor("", [null, "items:abc"], null)).toEqual([null]);
    expect(predecessorsFor("items:abc", [null], null)).toEqual([]);
  });
});
