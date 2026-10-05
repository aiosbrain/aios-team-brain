import { describe, expect, it } from "vitest";
import { formatAccessHealth, healthVerdict, HEALTH_VIOLATIONS } from "@/lib/admin/access-health-format";
import type { AccessHealth } from "@/lib/admin/access-health";

const base: AccessHealth = {
  healthy: false,
  blockers: [],
  warnings: [],
  itemsScanned: 0,
  unpartitioned: { count: 0, examples: [] },
  humanPrincipals: 1,
  agentPrincipals: 0,
  blindHumans: [],
  unplacedAgents: [],
  activeConnectors: [],
  externalTierInEveryone: [],
};

describe("AUDITFIX-23 AC13: the CLI verdict says what blockers now MEAN", () => {
  it("prints ACCESS VIOLATIONS for a team whose only blocker is an over-exposure", () => {
    // The whole point of the widening: this team has NO lockout. Printing "LOCKOUTS" would be a
    // flatly false word, and a slice whose purpose is stopping untrue reports may not ship one.
    const r: AccessHealth = {
      ...base,
      blockers: ["1 unsanctioned edge(s) on system projects: general→vendors — …"],
    };
    const lines = formatAccessHealth(r);
    expect(lines[0]).toContain(HEALTH_VIOLATIONS);
    expect(lines[0], "the retired word must be gone, not merely joined").not.toContain("LOCKOUTS");
    expect(lines.some((l) => l.includes("general→vendors")), "the finding is printed").toBe(true);
  });

  it("TIERRET-1 AC-10: the external-tier-in-Everyone drift blocker prints each identity", () => {
    const r: AccessHealth = {
      ...base,
      blockers: ["1 active external-tier human member(s) are in the builtin Everyone group — Everyone grants General"],
      externalTierInEveryone: [{ memberId: "m-drift-1", email: "contractor@example.test", kind: "human", tier: "external" }],
    };
    const text = formatAccessHealth(r).join("\n");
    expect(text).toContain(HEALTH_VIOLATIONS);
    expect(text, "the member id an operator can act on").toContain("m-drift-1");
    expect(text).toContain("contractor@example.test");
  });

  it("prints OK for a healthy team", () => {
    expect(healthVerdict({ healthy: true })).toBe("OK");
    expect(formatAccessHealth({ ...base, healthy: true })[0]).toContain("OK");
  });
});
