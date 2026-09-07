/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRE_EXISTING_MAIN_CONTEXTS,
  REQUIRED_MAIN_CONTEXTS,
  buildMainRulesets,
  evaluateMainOperation,
  verifyEffectiveMainPolicy,
} from "../scripts/staging-ops/main-policy.mjs";

const CHECKS = {
  "Docs drift guard": 15368,
  "Static checks (lint + typecheck)": 15368,
  "Secret scan (gitleaks)": 15368,
  "Brain unit tests (vitest)": 15368,
  "Data-mechanics tests (real Postgres)": 15368,
  "Integration tests (HTTP)": 15368,
  "Graph Neo4j tier (real Neo4j)": 15368,
  "Ingestion tests (pytest)": 15368,
  "NDA confidentiality gate": 15368,
  "Staging paired refresh integration": 15368,
  "Release candidate gate": 15368,
  "Staging candidate validation": 777,
};

const desired = buildMainRulesets({ normalAppId: 111, emergencyAppId: 222, producerIds: CHECKS });

describe("main release protection contract", () => {
  it("builds exactly three active main-only rulesets with capability-separated bypasses", () => {
    expect(desired).toHaveLength(3);
    expect(desired.map((r) => r.name)).toEqual(["main-integrity", "main-release-evidence", "main-release-writer"]);
    for (const r of desired) {
      expect(r.enforcement).toBe("active");
      expect(r.conditions.ref_name).toEqual({ include: ["refs/heads/main"], exclude: [] });
    }
    expect(desired[0].bypass_actors).toEqual([]);
    expect(desired[1].bypass_actors.map((x) => x.actor_id)).toEqual([222]);
    expect(desired[2].bypass_actors.map((x) => x.actor_id)).toEqual([111, 222]);
    expect(desired[1].rules[0].parameters.required_status_checks).toHaveLength(12);
  });

  it("requires the paired refresh integration lane, and still every pre-existing context", () => {
    // M6: shipping the CI job while leaving it out of the desired policy makes it a job that can go
    // red without blocking a release, which is the same as not requiring it.
    const contexts = desired[1].rules[0].parameters.required_status_checks.map((c: any) => c.context);
    expect(contexts).toContain("Staging paired refresh integration");
    for (const preExisting of PRE_EXISTING_MAIN_CONTEXTS) expect(contexts).toContain(preExisting);
    expect(PRE_EXISTING_MAIN_CONTEXTS).toHaveLength(9);
    expect(REQUIRED_MAIN_CONTEXTS).toEqual([...PRE_EXISTING_MAIN_CONTEXTS, "Staging paired refresh integration", "Release candidate gate", "Staging candidate validation"]);
  });

  it("refuses to build a policy that cannot pin the new lane's producer", () => {
    const withoutPaired = { ...CHECKS } as Record<string, number>;
    delete withoutPaired["Staging paired refresh integration"];
    expect(() => buildMainRulesets({ normalAppId: 111, emergencyAppId: 222, producerIds: withoutPaired }))
      .toThrow(/producer integration ID is required for Staging paired refresh integration/);
  });

  it("names lanes some workflow in this repository actually produces", () => {
    // A required context nothing emits blocks every release forever; a required context misspelt
    // blocks nothing at all. Both are cheap to catch here.
    const workflows = ["ci.yml", "nda-gate.yml", "release-candidate.yml"]
      .map((file) => readFileSync(`./.github/workflows/${file}`, "utf8")).join("\n");
    for (const context of REQUIRED_MAIN_CONTEXTS) {
      // `Staging candidate validation` is published by the release controller as a check run on the
      // candidate SHA, not by a workflow job name.
      if (context === "Staging candidate validation") continue;
      expect(workflows, `no workflow job is named ${context}`).toContain(`name: ${context}`);
    }
  });

  it.each([
    ["human direct push", "human", "update", true, false],
    ["admin direct push", "admin", "update", true, false],
    ["admin PR merge", "admin", "merge", true, false],
    ["normal release with green checks", "normal", "update", true, true],
    ["normal release with pending checks", "normal", "update", false, false],
    ["emergency non-force update", "emergency", "update", false, true],
    ["normal force push", "normal", "force", true, false],
    ["emergency force push", "emergency", "force", false, false],
    ["emergency delete", "emergency", "delete", false, false],
  ] as const)("enforces %s", (_label, actor, operation, checksGreen, allowed) => {
    expect(evaluateMainOperation({ actor, operation, checksGreen })).toBe(allowed);
  });

  it("verifies the effective rulesets plus absence of conflicting classic PR/check constraints", () => {
    expect(verifyEffectiveMainPolicy({
      applicableRulesets: desired,
      classicProtection: {
        enforce_admins: { enabled: true },
        required_status_checks: null,
        required_pull_request_reviews: null,
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
      expected: { normalAppId: 111, emergencyAppId: 222, producerIds: CHECKS },
    })).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["evaluate enforcement", (r: any[]) => (r[0].enforcement = "evaluate")],
    ["admin bypass", (r: any[]) => r[0].bypass_actors.push({ actor_type: "OrganizationAdmin", actor_id: 1, bypass_mode: "always" })],
    ["missing producer pin", (r: any[]) => delete r[1].rules[0].parameters.required_status_checks[0].integration_id],
    ["wrong normal actor", (r: any[]) => (r[2].bypass_actors[0].actor_id = 999)],
    ["extra branch", (r: any[]) => r[0].conditions.ref_name.include.push("refs/heads/staging")],
  ])("refuses %s", (_label, mutate) => {
    const fixture = structuredClone(desired);
    mutate(fixture);
    expect(verifyEffectiveMainPolicy({
      applicableRulesets: fixture,
      classicProtection: { required_status_checks: null, required_pull_request_reviews: null },
      expected: { normalAppId: 111, emergencyAppId: 222, producerIds: CHECKS },
    }).ok).toBe(false);
  });

  it("refuses classic constraints which would silently block the intended App bypasses", () => {
    expect(verifyEffectiveMainPolicy({
      applicableRulesets: desired,
      classicProtection: { required_status_checks: { contexts: [] }, required_pull_request_reviews: null },
      expected: { normalAppId: 111, emergencyAppId: 222, producerIds: CHECKS },
    }).ok).toBe(false);
  });
});
