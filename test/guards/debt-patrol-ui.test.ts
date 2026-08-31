import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DebtPatrol } from "@/components/codebases/debt-patrol";
import { DebtMovement } from "@/components/codebases/debt-dashboard";
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
      "Recurring counts a repeated scanner observation of the same fingerprint",
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
    expect(html).toContain("Active scanner findings");
    expect(html).toContain("UltraHarden intake");
    expect(html).toContain(
      "candidate intake is not connected yet, so candidates that were rejected, deduplicated, or never filed do not appear here",
    );
    expect(html).not.toContain("Debt movement");
    expect(html).not.toContain("Is the codebase paying debt down?");
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
