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

  it("prints OK for a healthy team", () => {
    expect(healthVerdict({ healthy: true })).toBe("OK");
    expect(formatAccessHealth({ ...base, healthy: true })[0]).toContain("OK");
  });
});
