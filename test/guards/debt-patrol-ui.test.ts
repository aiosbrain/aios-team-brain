import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DebtPatrol } from "@/components/codebases/debt-patrol";
import { buildDebtPatrol } from "@/lib/codebases/debt-ranking";
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
    expect(html).not.toContain("Record operator decision");
  });
});
