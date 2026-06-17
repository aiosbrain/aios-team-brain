import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CodebaseScanPayload } from "@/lib/api/schemas";
import { computeScores } from "@/lib/codebases/score";
import { audit } from "@/lib/api/audit";

/**
 * The ONLY write path for codebase analytics tables (single-writer guarded). Runs
 * with the service role. The scanner posts RAW metrics; scores are computed HERE so
 * there is one scoring implementation. Idempotency:
 *   • codebases       — upsert (team_id, slug)
 *   • code_metrics    — upsert (codebase_id, head_sha): same commit = no new point
 *   • contributions   — recompute + upsert (codebase_id, author_key, day)
 *   • github_issues   — upsert (codebase_id, number)
 */
export async function ingestCodebaseScan(
  supabase: SupabaseClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  payload: CodebaseScanPayload
): Promise<{ codebase_id: string; metrics_id: string; contributions: number; issues: number }> {
  const now = new Date().toISOString();
  const c = payload.codebase;

  // 1. upsert codebase identity + last_scan_at
  const { data: codebase, error: cbErr } = await supabase
    .from("codebases")
    .upsert(
      {
        team_id: auth.teamId,
        slug: c.slug,
        full_name: c.full_name,
        provider: c.provider,
        default_branch: c.default_branch,
        description: c.description,
        homepage: c.homepage,
        primary_language: c.primary_language,
        languages: c.languages,
        stars: c.stars,
        forks: c.forks,
        open_issues: c.open_issues,
        is_archived: c.is_archived,
        last_scan_at: now,
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (cbErr || !codebase) throw new Error(`codebase upsert failed: ${cbErr?.message}`);

  // 2. compute scores from raw metrics
  const m = payload.metrics;
  const scores = computeScores({
    commits_window: m.commits_window,
    ai_commits_window: m.ai_commits_window,
    test_coverage_pct: m.test_coverage_pct,
    has_claude_md: m.has_claude_md,
    has_agents_md: m.has_agents_md,
    agents_md_count: m.agents_md_count,
    skills_count: m.skills_count,
    commands_count: m.commands_count,
    active_days: m.active_days,
    window_days: m.window_days,
    days_since_last_commit: m.days_since_last_commit,
    open_issues: c.open_issues,
    loc: m.loc,
  });

  // 3. upsert the metrics snapshot (time-series point, keyed by head_sha)
  const { data: metrics, error: mErr } = await supabase
    .from("code_metrics")
    .upsert(
      {
        team_id: auth.teamId,
        codebase_id: codebase.id,
        head_sha: m.head_sha,
        window_days: m.window_days,
        scanned_at: m.scanned_at || now,
        loc: m.loc,
        files: m.files,
        commits_window: m.commits_window,
        ai_commits_window: m.ai_commits_window,
        additions_window: m.additions_window,
        deletions_window: m.deletions_window,
        test_coverage_pct: m.test_coverage_pct,
        // jsonb ARRAY column: the pg adapter only auto-casts plain objects to
        // ::jsonb, not arrays — stringify so Postgres parses it as jsonb (this
        // feature is postgres-only). Empty + non-empty both round-trip correctly.
        recent_commits: JSON.stringify(m.recent_commits),
        has_claude_md: m.has_claude_md,
        has_agents_md: m.has_agents_md,
        agents_md_count: m.agents_md_count,
        skills_count: m.skills_count,
        commands_count: m.commands_count,
        ...scores,
      },
      { onConflict: "codebase_id,head_sha" }
    )
    .select("id")
    .single();
  if (mErr || !metrics) throw new Error(`code_metrics upsert failed: ${mErr?.message}`);

  // 4. contributions — map author → member, then recompute + upsert daily aggregates
  let contribCount = 0;
  if (payload.contributions.length) {
    const memberId = await buildAuthorMap(supabase, auth.teamId);
    for (const row of payload.contributions) {
      // Resolve to a roster member by exact email first. Only derive a handle from
      // an email local-part when that email uses a domain already present in the
      // roster; otherwise external contributors like alex@gmail.com could be
      // misattributed to an internal actor_handle "alex".
      const email = row.author_email.trim().toLowerCase();
      const keyLc = row.author_key.trim().toLowerCase();
      const [localPart, domain] = email.includes("@") ? email.split("@", 2) : ["", ""];
      const handleFromTeamDomain =
        localPart && domain && memberId.emailDomains.has(domain)
          ? memberId.byHandle.get(localPart)
          : undefined;
      const explicitHandle = keyLc && !keyLc.includes("@") ? memberId.byHandle.get(keyLc) : undefined;
      const mapped =
        memberId.byEmail.get(email) ??
        memberId.byEmail.get(keyLc) ??
        handleFromTeamDomain ??
        explicitHandle ??
        null;
      const { error } = await supabase.from("code_contributions").upsert(
        {
          team_id: auth.teamId,
          codebase_id: codebase.id,
          author_key: row.author_key,
          author_name: row.author_name,
          author_email: row.author_email,
          member_id: mapped,
          day: row.day,
          commits: row.commits,
          ai_commits: row.ai_commits,
          additions: row.additions,
          deletions: row.deletions,
        },
        { onConflict: "codebase_id,author_key,day" }
      );
      if (error) throw new Error(`contribution ${row.author_key}/${row.day}: ${error.message}`);
      contribCount++;
    }
  }

  // 5. issues — upsert by number
  let issueCount = 0;
  for (const iss of payload.issues) {
    const { error } = await supabase.from("github_issues").upsert(
      {
        team_id: auth.teamId,
        codebase_id: codebase.id,
        number: iss.number,
        title: iss.title,
        state: iss.state,
        is_pull_request: iss.is_pull_request,
        author_login: iss.author_login,
        assignee_login: iss.assignee_login,
        labels: JSON.stringify(iss.labels), // jsonb array — see recent_commits note above
        comments: iss.comments,
        url: iss.url,
        opened_at: iss.opened_at || null,
        closed_at: iss.closed_at || null,
        updated_at: now,
      },
      { onConflict: "codebase_id,number" }
    );
    if (error) throw new Error(`issue #${iss.number}: ${error.message}`);
    issueCount++;
  }

  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "api_key",
    member_id: auth.memberId,
    api_key_id: auth.apiKeyId,
    action: "codebase.scanned",
    target_type: "codebase",
    target_id: codebase.id,
    meta: {
      slug: c.slug,
      head_sha: m.head_sha,
      agentic_score: scores.agentic_score,
      health_score: scores.health_score,
      contributions: contribCount,
      issues: issueCount,
    },
  });

  return {
    codebase_id: codebase.id,
    metrics_id: metrics.id,
    contributions: contribCount,
    issues: issueCount,
  };
}

/** Lookup tables mapping git author identity → member_id for the team. */
async function buildAuthorMap(supabase: SupabaseClient, teamId: string) {
  const { data } = await supabase
    .from("members")
    .select("id, email, actor_handle")
    .eq("team_id", teamId);
  const byEmail = new Map<string, string>();
  const byHandle = new Map<string, string>();
  const emailDomains = new Set<string>();
  for (const r of (data ?? []) as { id: string; email: string | null; actor_handle: string | null }[]) {
    if (r.email) {
      const email = r.email.toLowerCase();
      byEmail.set(email, r.id);
      const domain = email.split("@", 2)[1];
      if (domain) emailDomains.add(domain);
    }
    if (r.actor_handle) byHandle.set(r.actor_handle.toLowerCase(), r.id);
  }

  // Fold in explicit git-author aliases (e.g. GitHub noreply emails) as EXACT
  // byEmail matches. Deliberately NOT added to emailDomains — alias domains like
  // users.noreply.github.com are shared, so widening the handle heuristic with them
  // would re-introduce cross-author misattribution (the bug PR #11 closed).
  const { data: aliases } = await supabase
    .from("member_emails")
    .select("email, member_id")
    .eq("team_id", teamId);
  for (const a of (aliases ?? []) as { email: string; member_id: string }[]) {
    if (a.email) byEmail.set(a.email.toLowerCase(), a.member_id);
  }

  return { byEmail, byHandle, emailDomains };
}
