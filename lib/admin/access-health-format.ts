import type { AccessHealth } from "@/lib/admin/access-health";

/**
 * AUDITFIX-23 — the access-health verdict as TEXT, in an import-safe module.
 *
 * WHY IT IS ITS OWN FILE. The formatter lived inside `scripts/admin.ts`, which USED TO call `main()`
 * at module scope — so importing it to test the wording ran the CLI. (STAGINGMARK-4 has since made
 * that entry argv-guarded and `main(argv)` importable, so the hazard is gone; this file stays split
 * because the wording deserves its own tested surface.) There was no seam then, and a criterion
 * asserting what an operator reads had nowhere to stand (spec round 3 HIGH 4 on the previous draft).
 *
 * WHY THE WORD CHANGED. AUDITFIX-23 widened `blockers` from lock-OUT only to "a human locked OUT, or a
 * group let IN that the substrate never sanctioned". Leaving the verdict as `LOCKOUTS` would print a
 * flatly false word for a team with no lockout and one forbidden grant — the census exists to stop
 * exactly that kind of untrue report, so it may not ship one itself.
 */
export const HEALTH_OK = "OK";
export const HEALTH_VIOLATIONS = "ACCESS VIOLATIONS";

/** The verdict word alone — `blockers` are fatal whichever kind they are. */
export function healthVerdict(r: Pick<AccessHealth, "healthy">): string {
  return r.healthy ? HEALTH_OK : HEALTH_VIOLATIONS;
}

/** The operator-facing block, newest-style: verdict line, then blockers, then warnings. */
export function formatAccessHealth(r: AccessHealth): string[] {
  const lines = [
    `  health: ${healthVerdict(r)} · ${r.humanPrincipals} human(s), ${r.agentPrincipals} agent(s), ${r.itemsScanned} item(s) scanned`,
  ];
  for (const b of r.blockers) lines.push(`  ✗ ${b}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines;
}
