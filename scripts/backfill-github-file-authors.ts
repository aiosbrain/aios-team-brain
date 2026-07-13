/**
 * One-time backfill: re-attribute GitHub repo-file `deliverable` items that were ingested BEFORE the
 * author-attribution fix and so landed on the "GitHub Sync" connector (member.is_connector) instead
 * of a human. For each such item we fetch the file's last-commit author from GitHub (the same
 * git-blame answer the runner now uses), resolve it to a member via the identity map, and update
 * member_id — persisting the author into frontmatter so it's never re-fetched.
 *
 * Dry-run by default (prints the plan, writes nothing). Pass --apply to write.
 *
 *   DATABASE_URL=<prod> SECRETS_KEY=<prod> npx tsx --conditions react-server \
 *     scripts/backfill-github-file-authors.ts [--team <slug>] [--apply]
 *
 * The GitHub token is read from the team's github integration secret (decrypted in-process), or the
 * GITHUB_TOKEN env. Public repos work token-free but the 60/hr unauth limit is too low at scale.
 */
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";
import { githubHeaders } from "@/lib/ingest/sources/github";

const APPLY = process.argv.includes("--apply");
const teamArg = (() => {
  const i = process.argv.indexOf("--team");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();

interface Row {
  id: string;
  frontmatter: Record<string, unknown>;
}

/** Last-commit author (login + git email + name) for a repo file, or undefined. */
async function lastAuthor(
  repo: string,
  path: string,
  ref: string,
  token: string | null
): Promise<{ login?: string; email?: string; name?: string } | undefined> {
  try {
    const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`;
    const res = await fetch(url, { headers: githubHeaders(token) });
    if (!res.ok) return undefined;
    const arr = (await res.json()) as {
      author?: { login?: string } | null;
      commit?: { author?: { email?: string; name?: string } | null } | null;
    }[];
    const c = Array.isArray(arr) ? arr[0] : undefined;
    return c ? { login: c.author?.login, email: c.commit?.author?.email, name: c.commit?.author?.name } : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const db = adminClient();
  const teams = (
    await runSql<{ id: string; slug: string }>(
      teamArg ? `select id, slug from teams where slug = $1` : `select id, slug from teams`,
      teamArg ? [teamArg] : []
    )
  ).rows;

  console.log(`Backfill GitHub file-author attribution — ${APPLY ? "APPLY" : "DRY-RUN"} — ${teams.length} team(s)\n`);
  let totalResolved = 0;
  let totalUnresolved = 0;

  for (const team of teams) {
    const integ = (await getEnabledIntegrationsWithSecrets(db, team.id)).find((i) => i.type === "github");
    const token = integ?.secret ?? process.env.GITHUB_TOKEN ?? null;
    const idMap = await buildIdentityMap(db, team.id);

    // Connector-owned GitHub file deliverables (the mis-attributed set).
    const rows = (
      await runSql<Row>(
        `select i.id, i.frontmatter
           from items i join members m on m.id = i.member_id
          where i.team_id = $1 and i.kind = 'deliverable'
            and i.frontmatter->>'source' = 'github' and m.is_connector = true`,
        [team.id]
      )
    ).rows;
    if (rows.length === 0) continue;

    let resolved = 0;
    let unresolved = 0;
    for (const r of rows) {
      const fm = r.frontmatter ?? {};
      const repo = String(fm.repo ?? "");
      const path = String(fm.repo_path ?? "");
      const ref = String(fm.ref ?? "main");
      if (!repo || !path) {
        unresolved++;
        continue;
      }
      const author = await lastAuthor(repo, path, ref, token);
      const memberId = author
        ? resolveMember(idMap, { email: author.email, key: author.login })
        : null;
      if (!memberId) {
        unresolved++;
        continue;
      }
      resolved++;
      if (APPLY) {
        // Update member_id + persist the author into frontmatter (so a re-run is a cheap no-op).
        await runSql(
          `update items
              set member_id = $1,
                  frontmatter = frontmatter
                    || jsonb_build_object('author', $2::text, 'author_email', $3::text, 'author_login', $4::text)
            where id = $5`,
          [memberId, author?.name ?? "", author?.email ?? "", author?.login ?? "", r.id]
        );
      }
    }
    console.log(`  ${team.slug}: ${rows.length} connector-owned files → ${resolved} attributable, ${unresolved} unresolved`);
    totalResolved += resolved;
    totalUnresolved += unresolved;
  }

  console.log(`\n${APPLY ? "Updated" : "Would update"} ${totalResolved} item(s); ${totalUnresolved} left unattributed (external/unmapped author).`);
  if (!APPLY) console.log("Re-run with --apply to write. Then delete arc_cache for the team to force re-synthesis.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
