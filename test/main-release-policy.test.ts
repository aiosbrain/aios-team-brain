/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
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
    expect(desired[1].rules[0].parameters.required_status_checks).toHaveLength(11);
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
