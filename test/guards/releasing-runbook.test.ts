import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RELPTR-3 — the runbook must keep describing mechanisms that actually exist.
 * Spec: `docs/design/release-pointer-cutover-guard.md` (criteria 11, 13, 14).
 *
 * WHY GUARD PROSE AT ALL. `docs/RELEASING.md` carries the answers to two things no in-repo check can
 * enforce: the tag ruleset (constraint 7) and the `staging` fast-forward (constraint 8). Those answers
 * live in prose precisely because they are human, outward-facing acts — which is also what makes them
 * easy to lose in an edit. A guard cannot make someone install a ruleset; it can stop the instruction
 * to install one from silently disappearing.
 *
 * WHAT THESE GUARDS DO NOT CLAIM: none of them observes the live repository. Criterion 10's honest
 * scope, restated — a green here means the runbook still SAYS the right thing, never that the ruleset
 * was installed.
 */

const RUNBOOK = readFileSync(join(__dirname, "..", "..", "docs", "RELEASING.md"), "utf8");

describe("guard: the cutover constraints survive editing (criterion 13)", () => {
  it("constraint 7 names the tag ruleset AND its ordering sharp edge", () => {
    expect(RUNBOOK).toMatch(/\|\s*7\s*\|/);
    expect(RUNBOOK, "must name the ref pattern").toMatch(/refs\/tags\/v\*/);
    expect(RUNBOOK, "must say deletion/update are denied").toMatch(/denying deletion and update/);
    // The sharp edge is the whole point: installing the ruleset later does not retroactively
    // invalidate a green that was already minted.
    expect(RUNBOOK).toMatch(/before the first candidate context is issued/);
  });

  it("constraint 8 names assertion D's precondition", () => {
    expect(RUNBOOK).toMatch(/\|\s*8\s*\|/);
    expect(RUNBOOK).toMatch(/Assertion D is false until `staging` is fast-forwarded/);
  });

  it("constraint 9 names the statuses forge route AND corrects the app-pinning claim", () => {
    // The third route to a green on an unexamined commit, found during the CODE review after two
    // design rounds had centred on the first two. It is unguardable from inside the repo beyond the
    // permissions guard, so the runbook carries the part a human must not forget: keep the app
    // pinning when the gate becomes required.
    // Anchored INSIDE row 9, not merely "these phrases appear somewhere in the file" — Codex noted the
    // first version would pass if row 9 were replaced with unrelated text while the phrases survived
    // elsewhere. A constraint table row is the unit that has to be right.
    const row9 = RUNBOOK.split("\n").find((l) => l.startsWith("| 9 |")) ?? "";
    expect(row9, "constraint row 9 must exist").not.toBe("");
    expect(row9).toMatch(/statuses: write` is a third context-forging route/);
    // And the correction round 2 forced: app pinning is NOT the mitigation, because a forged status
    // and the genuine check share one app identity.
    expect(row9).toMatch(/App pinning is NOT a mitigation here/);
    expect(row9).toMatch(/conditional on it keeping a `pull_request_target`-only trigger/);
    expect(row9, "must not restate the claim it corrects").not.toMatch(/which a status from another app cannot satisfy/);
  });

  it("§3.2 carries BOTH new ordering pairs", () => {
    expect(RUNBOOK).toMatch(/tag-ruleset: before the release-candidate context is FIRST MINTED/);
    expect(RUNBOOK).toMatch(/fast-forward-staging: before any candidate tag is pushed/);
  });

  it("the constraint count in the prose matches the table", () => {
    // A table that grows while the sentence above it still says "six" is the drift these guards exist
    // for — and it is the exact shape of the claim this slice corrected in constraint 1.
    // Scoped to the §3.1 constraint table, not the whole file: a `Math.max` over every `| N |` row in
    // the document would break the day an unrelated numbered table is added — a guard that reddens for
    // a reason it does not name is one that gets deleted.
    const section = RUNBOOK.slice(
      RUNBOOK.indexOf("### 3.1 The constraints the cutover must satisfy"),
      RUNBOOK.indexOf("### 3.1a")
    );
    expect(section.length, "the §3.1 section must be locatable").toBeGreaterThan(200);
    const rows = [...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    const highest = Math.max(...rows);
    expect(highest, "constraint table should reach 9").toBe(9);
    // …and they must READ in order. The fold inserted 9 above 8, which no assertion noticed because
    // `Math.max` is order-insensitive — a table a human scans during a cutover should not go 7, 9, 8.
    expect(rows, "constraint rows must be in ascending order").toEqual([...rows].sort((a, b) => a - b));
    expect(RUNBOOK, "the prose must not still say six").not.toMatch(/^Six, each verified/m);
    expect(RUNBOOK).toMatch(/\*\*Nine\*\*, each verified/);
  });
});

describe("guard: constraint 1's correction cannot silently revert (criterion 11)", () => {
  it("names `PR records a diff review` as the SINGLE pull_request-only context", () => {
    expect(RUNBOOK).toMatch(/9 of the 10 required contexts are present/);
    expect(RUNBOOK).toMatch(/`PR records a diff review`/);
    expect(RUNBOOK).toMatch(/relocated/);
  });

  it("labels the count as a DATED MEASUREMENT, not an invariant", () => {
    // Codex's finding: a test pinning a sentence about live configuration stays green while the
    // sentence goes false. It cannot be fixed by asserting harder — so the doc is required to carry
    // its own date and an instruction to re-measure, which makes it stale-by-construction rather
    // than silently wrong.
    expect(RUNBOOK).toMatch(/MEASURED 2026-08-26/);
    expect(RUNBOOK).toMatch(/A dated measurement, not an invariant/);
    expect(RUNBOOK).toMatch(/re-measure rather than trusting this row/);
  });
});

describe("guard: the cost of requiring the gate is written down (criterion 14)", () => {
  it("records that only tagged releases can then reach main", () => {
    expect(RUNBOOK).toMatch(/nothing that is not a tagged release can\s*\n?>?\s*reach `main`/);
    expect(RUNBOOK, "hotfixes become tagged patch releases").toMatch(/every hotfix and every revert becomes a tagged patch release/);
  });

  it("records the two-act operational ordering (tag, wait for green, then fast-forward)", () => {
    // A fast-forward attempted while the context is pending is rejected — a foot-gun that costs a
    // confused ten minutes on release day if it is not written down.
    expect(RUNBOOK).toMatch(/wait for `Release candidate gate` to go green/);
  });

  it("§2 no longer claims a tag push triggers nothing — this slice made that false", () => {
    // An operator following the old §2 would ignore the new gate's red result and publish anyway.
    expect(RUNBOOK, "the stale claim must be gone").not.toMatch(/\*\*Pushing a tag triggers nothing\*\*/);
    expect(RUNBOOK).toMatch(/Pushing a tag now runs the release-candidate/);
    expect(RUNBOOK, "and it must say what a red D means before the cutover").toMatch(/expected to fail assertion D/);
  });

  it("points at the files that implement the gate, so the section cannot describe a ghost", () => {
    expect(RUNBOOK).toMatch(/scripts\/release-candidate-guard\.mjs/);
    expect(RUNBOOK).toMatch(/\.github\/workflows\/release-candidate\.yml/);
  });
});
