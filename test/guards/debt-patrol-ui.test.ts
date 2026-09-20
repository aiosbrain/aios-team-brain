import { codebaseHealthSchema } from "@/lib/api/schemas";
import { isCodebaseStale } from "@/lib/metrics/codebases";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DebtPatrol } from "@/components/codebases/debt-patrol";
import {
  DebtMovement,
  ScannerCheckCoverage,
} from "@/components/codebases/debt-dashboard";
import { buildDebtPatrol } from "@/lib/codebases/debt-ranking";
import { deriveCodebaseDebtKpis } from "@/lib/codebases/debt-kpis";
import type { CodebaseFinding } from "@/lib/metrics/codebases";

const finding: CodebaseFinding = {
  id: "00000000-0000-4000-8000-000000000001",
  fingerprint: "a".repeat(64),
  status: "open",
  check_id: "coverage_lines_pct",
  axis: "test_rigor",
  kind: "quality_issue",
  severity: "high",
  evidence_status: "complete",
  remediation_tier: 1,
  first_seen_sha: "1".repeat(40),
  last_seen_sha: "2".repeat(40),
  first_seen_at: "2026-07-01T00:00:00.000Z",
  last_seen_at: "2026-08-04T00:00:00.000Z",
  resolved_at: null,
  occurrence_count: 2,
  decision_reason: null,
  decision_owner_member_id: null,
  decision_owner_name: null,
  decision_by_member_id: null,
  decision_by_member_name: null,
  decision_at: null,
  decision_expires_at: null,
  events: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      event_type: "detected",
      from_status: null,
      to_status: "open",
      head_sha: "1".repeat(40),
      observed_at: "2026-07-01T00:00:00.000Z",
      details: {},
    },
  ],
};

describe("debt patrol accessibility guard", () => {
  it("renders an accessible, explainable, report-only ranking without hiding unknowns", () => {
    const patrol = buildDebtPatrol([finding], {
      commitsWindow: 30,
      windowDays: 90,
      now: "2026-08-04T12:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      DebtPatrol({
        patrol,
        findings: [finding],
        decisionOwners: [],
        teamSlug: "test-team",
        codebaseSlug: "test-codebase",
        currentMemberId: "00000000-0000-4000-8000-000000000003",
        canDecide: false,
      }),
    );

    expect(html).toContain('aria-labelledby="debt-patrol-heading"');
    expect(html).toContain("Repository patrol · report only");
    expect(html).toContain("Principal");
    expect(html).toContain("Interest");
    expect(html).toContain("Why this rank");
    expect(html).toContain("unknown");
    expect(html).toContain("North Star reconciliation and admission gaps");
    expect(html).toContain('<th scope="row"');
    expect(html).toContain("Ranking evidence coverage");
    expect(html).toContain("ranking evidence");
    expect(html).toContain(
      "Recurring counts active ranked findings whose fingerprint the scanner observed more than once",
    );
    expect(html).not.toContain("Record operator decision");
    expect(html).not.toContain("Score coverage");
    expect(html).not.toContain("score admission");
  });

  it("names the scanner-admitted population and the absent UltraHarden intake", () => {
    const debt = deriveCodebaseDebtKpis({
      findings: [finding],
      commits: [],
      rangeStart: "2026-07-01T00:00:00.000Z",
      rangeEnd: "2026-08-04T12:00:00.000Z",
      asOf: "2026-08-04T12:00:00.000Z",
      commitsWindow: 30,
      scannerWindowDays: 90,
    });
    const html = renderToStaticMarkup(DebtMovement({ debt }));

    expect(html).toContain('aria-labelledby="debt-movement-heading"');
    expect(html).toContain("Scanner-admitted debt");
    expect(html).toContain(
      "What has the deterministic health scanner admitted?",
    );
    expect(html).toContain("scanner-admitted");
    expect(html).toContain("not a count of all defects");
    expect(html).toContain("UltraHarden intake");
    expect(html).toContain(
      "candidate intake is not connected yet, so candidates that were rejected, deduplicated, or never filed do not appear here",
    );

    // The three "Active scanner findings" sites are asserted SEPARATELY on purpose. A bare
    // toContain("Active scanner findings") is satisfied by either aria-label alone, so the metric
    // label could regress to "Actionable" — or a chart could lose its accessible name — while the
    // guard stayed green. That is a test passing for the wrong reason, which is worse than no test:
    // it certifies copy nobody checked.
    expect(html).toContain(">Active scanner findings</dt>");
    expect(html).toContain(
      'aria-label="Active scanner findings by open-age bucket"',
    );
    expect(html).toContain(
      'aria-label="Active scanner findings by current severity"',
    );

    expect(html).not.toContain("Debt movement");
    expect(html).not.toContain("Is the codebase paying debt down?");
    expect(html).not.toContain(">Actionable</dt>");
    expect(html).not.toContain("Actionable findings by");
  });

  it("keeps movement before patrol and evidence after it", () => {
    const page = readFileSync(
      join(
        process.cwd(),
        "app",
        "t",
        "[team]",
        "codebases",
        "[slug]",
        "page.tsx",
      ),
      "utf8",
    );
    const movement = page.indexOf("<DebtMovement");
    const patrol = page.indexOf("<DebtPatrol");
    const evidence = page.indexOf("<DebtEvidence");
    expect(movement).toBeGreaterThan(-1);
    expect(patrol).toBeGreaterThan(movement);
    expect(evidence).toBeGreaterThan(patrol);
  });

  it("reads the complete team-scoped finding ledger without row caps", () => {
    const source = readFileSync(
      join(process.cwd(), "lib", "metrics", "codebases.ts"),
      "utf8",
    );
    const findingsStart = source.indexOf('.from("codebase_findings")');
    const eventsStart = source.indexOf('.from("codebase_finding_events")');
    const queryEnd = source.indexOf("  ]);", eventsStart);
    const findingsQuery = source.slice(findingsStart, eventsStart);
    const eventsQuery = source.slice(eventsStart, queryEnd);
    expect(findingsStart).toBeGreaterThan(-1);
    expect(eventsStart).toBeGreaterThan(findingsStart);
    for (const query of [findingsQuery, eventsQuery]) {
      expect(query).toContain('.eq("team_id", teamId)');
      expect(query).toContain('.eq("codebase_id", codebaseId)');
      expect(query).not.toContain(".limit(");
    }
  });
});

// AIO-1096: census labels, unknowns and freshness are observable independently of color.
describe("scanner check coverage", () => {
  const fixtureSet = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "test/fixtures/contract/codebase-payload-1.25-fixtures.json",
      ),
      "utf8",
    ),
  );
  const makeHealth = (name = "valid-v3-complete") => {
    const health = codebaseHealthSchema.parse(
      fixtureSet.valid.find((f: { name: string }) => f.name === name).payload
        .metrics.codebase_health,
    );
    if (health.schema_version !== "3" || !("check_coverage" in health))
      throw new Error("v3 fixture required");
    return health;
  };
  it("labels every count, full provenance and capture time", () => {
    const health = makeHealth();
    const html = renderToStaticMarkup(
      ScannerCheckCoverage({ health, stale: false }),
    );
    for (const label of [
      "Scanner check coverage",
      "Complete scan",
      "Configured checks",
      "Complete required",
      "Findings emitted",
      "All checks",
      "Required checks",
      "Partial",
      "Missing",
      "Stale",
      "Error",
      "Profile",
      "Rubric",
      "Head",
      "Measured time",
    ])
      expect(html).toContain(label);
    for (const value of [
      health.profile_id,
      health.profile_version,
      health.rubric_version,
      health.head_sha,
      health.measured_at,
    ])
      expect(html).toContain(value);
    expect(html).toContain('<th scope="row"');
    expect(html).toContain(`dateTime="${health.measured_at}"`);
  });
  it("shows partial, stale and error cues together without claiming completeness", () => {
    const health = makeHealth("valid-v3-mixed");
    health.evidence_status = "error";
    const html = renderToStaticMarkup(
      ScannerCheckCoverage({ health, stale: true }),
    );
    for (const flag of ["Partial scan", "Stale scan", "Error evidence"])
      expect(html).toContain(flag);
    expect(html).not.toContain("Complete scan");
  });
  it("required completeness never means all-check completeness and zero is measured", () => {
    const health = makeHealth();
    health.check_coverage.all.complete -= 1;
    health.check_coverage.all.partial += 1;
    expect(
      renderToStaticMarkup(ScannerCheckCoverage({ health, stale: false })),
    ).toContain("Partial scan");
    const zero = renderToStaticMarkup(
      ScannerCheckCoverage({
        health: makeHealth("valid-v3-zero"),
        stale: false,
      }),
    );
    expect(zero).toContain("No configured checks");
    expect(zero).not.toContain("100%");
    expect(zero).not.toContain("Complete scan");
  });
  it("renders absent and v1/v2 census as unknown rather than zero", () => {
    const legacy = fixtureSet.valid.filter((f: { name: string }) =>
      [
        "valid-v2-unchanged",
        "valid-with-health: full metrics block plus codebase_health",
      ].includes(f.name),
    );
    expect(legacy).toHaveLength(2);
    for (const health of [
      null,
      ...legacy.map(
        (f: { payload: { metrics: { codebase_health: unknown } } }) =>
          codebaseHealthSchema.parse(f.payload.metrics.codebase_health),
      ),
    ]) {
      const html = renderToStaticMarkup(
        ScannerCheckCoverage({ health, stale: true }),
      );
      expect(html).toContain("Coverage unknown");
      expect(html).toContain("Configured checks: Unknown");
      expect(html).not.toContain("Complete scan");
      expect(html).not.toContain("<table");
    }
  });
  it("places coverage below the intake gap and above debt; page freshness uses health time", () => {
    const source = readFileSync(
      join(process.cwd(), "components/codebases/debt-dashboard.tsx"),
      "utf8",
    );
    const movement = source.slice(
      source.indexOf("export function DebtMovement"),
    );
    expect(movement.indexOf('label="UltraHarden intake"')).toBeLessThan(
      movement.indexOf("<ScannerCheckCoverage"),
    );
    expect(movement.indexOf("<ScannerCheckCoverage")).toBeLessThan(
      movement.indexOf('aria-labelledby="debt-movement-heading"'),
    );
    const page = readFileSync(
      join(process.cwd(), "app/t/[team]/codebases/[slug]/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /healthStale=\{isCodebaseStale\(\s*cb\.breakdown\?\.codebase_health\?\.measured_at/,
    );
    expect(
      isCodebaseStale(
        "2026-08-01T00:00:00Z",
        Date.parse("2026-09-01T00:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isCodebaseStale(
        "2026-09-01T00:00:00Z",
        Date.parse("2026-09-01T00:00:00Z"),
      ),
    ).toBe(false);
  });
});
