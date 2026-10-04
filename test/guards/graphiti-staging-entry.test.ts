import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AIO-997 — the Graphiti sidecar's keyless staging mode.
 *
 * WHAT THIS TIER CAN AND CANNOT ESTABLISH, stated up front because the distinction is the whole
 * design. The scope matrix is a pure function that imports neither FastAPI nor the production
 * modules, so it can be *executed* here against real inputs — that is behaviour, not a grep. What
 * cannot be executed here is a real uvicorn process serving real HTTP with a real network stack:
 * `graphiti/staging-keyless-diagnostic.py`, run inside a freshly built image with the network
 * disabled (`graphiti/keyless-image-check.sh`), is the only thing that establishes the refusals, the
 * clean shutdown and the absence of outbound ATTEMPTS. Nothing below is offered as a substitute for
 * it, and the source-text assertions at the end are pins on wiring, not evidence of behaviour.
 *
 * The verifier is driven through its own mutation table because a gate that cannot fail is
 * decoration. Every mutation below must redden its OWN named check — the assertion is the message,
 * not merely a non-zero exit, since "something failed" is satisfied by any breakage at all.
 *
 * python3 is already a declared dependency of this tier (`graphiti-single-worker.test.ts` and
 * `graphiti-patch-same-item.test.ts` both spawn it; CI installs it).
 */

const root = join(import.meta.dirname, "..", "..");
const entrySource = join(root, "graphiti", "staging-entry.py");
const verifier = join(root, "graphiti", "verify-staging-entry.py");
const fixture = readFileSync(entrySource, "utf8");

function verify(source: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "staging-entry-"));
  const path = join(dir, "staging_entry.py");
  writeFileSync(path, source);
  const result = spawnSync("python3", [verifier, "--selector-only", path], { encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "") + (result.stderr ?? "") };
}

describe("graphiti staging entry — the scope matrix, executed", () => {
  it("accepts the shipped entry module", () => {
    // The baseline must be green under the EXACT invocation the mutations use, or every "REDDENED"
    // below means nothing.
    const result = verify(fixture);
    expect(result.ok, result.out).toBe(true);
    expect(result.out).toMatch(/staging entry verified/);
  });

  /**
   * Each row: what breaks, how, and the message that must appear. The messages are deliberately
   * specific — several of these mutations would redden *some* check by accident (a matrix row that
   * now returns production makes `build_app` try to import `graph_service.main`, which is absent
   * here), and a loose assertion would accept the accident instead of the finding.
   */
  const mutations: [string, (source: string) => string, RegExp[]][] = [
    [
      "a copy claim with no pin silently selects production",
      (s) => s.replace("        if copy_claim:", "        if False:"),
      [/scope-matrix/, /unpinned, copy-ready declared/, /copy-claim-without-pin/],
    ],
    [
      "a pin with no actual environment id is not refused",
      (s) => s.replace("    if not actual:", "    if False:"),
      [/scope-matrix/, /pinned, actual environment absent/, /actual-environment-missing/],
    ],
    [
      "the environment-identity comparison is inverted",
      (s) => s.replace("    if actual != pin:", "    if actual == pin:"),
      [/scope-matrix/, /pinned match, nothing declared/],
    ],
    [
      "an unrecognised declaration inside pinned scope is accepted",
      (s) =>
        s.replace(
          "    if declared and declared not in KNOWN_MODE_DECLARATIONS:",
          "    if False:"
        ),
      [/scope-matrix/, /pinned match, unknown declaration/, /unknown-mode-declaration/],
    ],
    [
      "scope strings are no longer trimmed",
      (s) =>
        s.replace(
          '    return value.strip() if isinstance(value, str) else ""',
          '    return value if isinstance(value, str) else ""'
        ),
      [/scope-matrix/, /blank pin is an absent pin/],
    ],
    [
      "`app` becomes a module-level attribute again",
      (s) => `${s}\napp = "eager"\n`,
      [/lazy-import/, /constructed at import time/],
    ],
    [
      "importing the entry module pulls in FastAPI",
      // Synthetic, and the only way to reach this branch in a tier where FastAPI is not installed:
      // a real module-scope `import fastapi` would fail to load and redden a different check, which
      // would leave this branch unproven. It is a negative control for the branch, not a claim.
      (s) => `${s}\nimport sys as _probe\n_probe.modules["fastapi"] = _probe\n`,
      [/lazy-import/, /fastapi/],
    ],
    [
      "importing the entry module pulls in a provider client",
      (s) => `${s}\nimport sys as _probe\n_probe.modules["openai"] = _probe\n`,
      [/lazy-import/, /openai/],
    ],
    [
      // The regression the selector tier used to be blind to. `build_app` was only ever reached
      // here on REFUSALS, so swapping the two accepting branches — staging gets production, an
      // ordinary deployment gets the health-only app — passed every check in this file. The
      // verifier now dispatches against a restored `sys.modules` sentinel standing in for
      // `graph_service.main`, which is what makes the inversion an identity comparison rather than
      // an ImportError that could have come from anywhere.
      "the keyless and production branches are swapped",
      (s) =>
        s.replace(
          "    if selection.scope == SCOPE_KEYLESS:",
          "    if selection.scope == SCOPE_PRODUCTION:"
        ),
      [/production-dispatch/, /the branches are inverted/, /never read `graph_service\.main\.app`/],
    ],
    [
      "a refusing configuration returns instead of raising",
      (s) =>
        s.replace(
          "        raise StagingEntryConfigurationError(\n" +
            '            f"staging-entry refused startup [{selection.reason}]: {selection.detail}"\n' +
            "        )",
          "        return None"
        ),
      [/refusal-raises/, /returned an application instead of refusing/],
    ],
    [
      "the health mode name drifts",
      (s) => s.replace('KEYLESS_MODE_NAME = "staging-no-model"', 'KEYLESS_MODE_NAME = "staging"'),
      [/constants/, /KEYLESS_MODE_NAME/],
    ],
    [
      "the refusal code drifts",
      (s) => s.replace('REFUSAL_CODE = "staging_graphiti_no_model"', 'REFUSAL_CODE = "no_model"'),
      [/constants/, /REFUSAL_CODE/],
    ],
  ];

  for (const [label, mutate, expected] of mutations) {
    it(`rejects: ${label}`, () => {
      const mutated = mutate(fixture);
      // Without this, a mutation whose anchor moved would silently verify the UNMUTATED file and
      // report a pass for a check that never ran.
      expect(mutated, "the mutation's anchor no longer exists in the entry module").not.toBe(fixture);
      const result = verify(mutated);
      expect(result.ok, result.out).toBe(false);
      for (const pattern of expected) expect(result.out).toMatch(pattern);
    });
  }
});

describe("graphiti staging entry — image wiring", () => {
  const dockerfile = readFileSync(join(root, "graphiti", "Dockerfile"), "utf8");
  /** `uv run` and provider-key names both appear in this file's PROSE, which is not the image. */
  const instructions = dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("the CMD is the mode-selecting entry, started from the venv, on 0.0.0.0:8000", () => {
    // Host and port are pinned because the platform's healthcheck and private networking both depend
    // on them, and the base image bound the same pair.
    expect(instructions).toContain(
      'CMD ["/app/.venv/bin/uvicorn", "graph_service.staging_entry:app", "--host", "0.0.0.0", "--port", "8000"]'
    );
    // Exactly one CMD: a second would silently win and could name the old target.
    expect(dockerfile.split("\n").filter((l) => l.startsWith("CMD ")).length).toBe(1);
    // The runtime-revert trap this image already exists to avoid. In INSTRUCTIONS only — the
    // comments describe `uv run` at length, and banning the word would redden an honest file.
    expect(instructions).not.toMatch(/uv run/);
  });

  it("the entry module is copied in and gated at build time", () => {
    expect(instructions).toContain("COPY staging-entry.py /app/graph_service/staging_entry.py");
    expect(instructions).toContain(
      "RUN /app/.venv/bin/python /tmp/verify-staging-entry.py /app/graph_service/staging_entry.py"
    );
    // The gate must run AFTER the file it gates is in place.
    expect(instructions.indexOf("COPY staging-entry.py")).toBeLessThan(
      instructions.indexOf("/tmp/verify-staging-entry.py")
    );
    // ...and the second gate, which is about a different property: the CMD target must RESOLVE
    // through the venv the way uvicorn resolves it. The path-loading verifier cannot see that.
    expect(instructions).toContain("import graph_service.staging_entry as e");
    expect(instructions).toMatch(/RUN cd \/ &&/);
  });

  it("no test hook and no provider credential ships in the image", () => {
    // The tripwire is mounted for a diagnostic run and nothing else; copying it would put a socket
    // monkeypatch into a served artifact. The diagnostic likewise stays outside the image.
    expect(instructions).not.toMatch(/staging-keyless-tripwire\.py/);
    expect(instructions).not.toMatch(/staging-keyless-diagnostic\.py/);
    // A baked key would defeat the one thing this mode exists to establish. Anchored to real
    // instructions, not prose: the PATCH 1 comment names the variable legitimately.
    expect(instructions).not.toMatch(/^\s*(ENV|ARG)\s+OPENAI_API_KEY/m);
    expect(instructions).not.toMatch(/OPENAI_API_KEY\s*=/);
  });
});

describe("graphiti staging entry — the operator instructions that bound it", () => {
  it("OPS §11 excludes the keyless baseline from the legacy clear/re-projection journey", () => {
    // The accepted H1 correction. Without it an operator following §11 top to bottom would run a
    // clear the sidecar refuses, and then a re-projection that spends exactly what this mode avoids.
    const ops = readFileSync(join(root, "docs", "OPS.md"), "utf8");
    const section = ops.slice(ops.indexOf("## 11. Staging refresh"));
    // Flattened: these sentences are hard-wrapped and half of them live inside a blockquote, so
    // matching the raw text would pin the line breaks rather than the instruction.
    const flat = section.replace(/\n>\s?/g, " ").replace(/\s+/g, " ");
    expect(flat).toContain("keyless no-model mode");
    expect(flat).toContain("staging_graphiti_no_model");
    expect(flat).toContain("excluded from the legacy graph-clear and re-projection journey");
    // Each protection asserted separately, so dropping any one reddens its own line.
    expect(flat).toContain("Do not run `scripts/staging-graph-clear.mjs` against it");
    expect(flat).toContain("do not add a second `/clear` caller");
    // Unpinned legacy staging must still be told the old procedure applies to it.
    expect(flat).toContain("Unpinned legacy staging is unaffected");
    // The override that silently bypasses the image CMD is the step most likely to be skipped.
    expect(flat).toContain("Clear the service's custom start command");
    // ...and health must not be sold as more than liveness.
    expect(flat).toContain("not graph or database readiness");
    expect(flat).toContain("healthy keyless sidecar is not an activated copy");
    // The pointer at the head of the clear runbook, for a reader who jumps straight to it.
    expect(flat).toContain("Not if staging Graphiti is running the keyless no-model mode");
  });

  it("the design doc carries the accepted AC-07 clarification and its compatibility correction", () => {
    const design = readFileSync(join(root, "docs", "design", "staging-workflow-hardening.md"), "utf8");
    expect(design).toMatch(/#### Keyless staging Graphiti — the missing startup mechanism/);
    expect(design).toContain("staging_graphiti_no_model");
    expect(design).toContain("mode: staging-no-model");
    expect(design).toMatch(/Compatibility correction \(AIO-997/);
    expect(design).toMatch(/not permission to run the historical graph-clear-then-re-project sequence/);
    // The two limits the adjudication insisted on keeping visible.
    expect(design).toMatch(/adds no sidecar restart and no post-bootstrap preflight requirement/);
    expect(design).toMatch(/Invalid or contradictory staging identity fails startup/);
  });
});
