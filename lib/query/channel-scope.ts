import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { parseSlackItemPath, scopedSlackItemPath } from "@/lib/ingest/sources/slack-namespace";

/** The visible Slack identities for one display name, plus the historical non-Slack name rule. */
export interface VisibleChannelScope {
  name: string;
  legacyPrefixes: readonly string[];
  scopedPrefixes: readonly string[];
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Resolve every visible identity. A legacy path never acquires a guessed workspace. */
export async function resolveVisibleChannelScope(
  teamId: string,
  tier: "team" | "external",
  name: string,
  visibleIds?: readonly string[] | null
): Promise<VisibleChannelScope> {
  if (visibleIds && visibleIds.length === 0) {
    return { name, legacyPrefixes: [], scopedPrefixes: [] };
  }
  const params: unknown[] = [teamId, name, `${escapeLike(`slack/${name}/`)}%`];
  // The legacy second segment may itself be the display name, including rows with no
  // frontmatter.channel. The parser below refuses scoped rows whose *workspace* equals name.
  let where = "team_id = $1 and path like 'slack/%' and " +
    "(lower(frontmatter->>'channel') = lower($2) or path like $3 escape '\\')";
  if (visibleIds) {
    params.push(visibleIds);
    where += ` and id = any($${params.length}::uuid[])`;
  } else if (tier === "external") {
    where += " and access = 'external'";
  }
  let rows: { path: string; channel: string | null }[];
  try {
    rows = (await runSql<{ path: string; channel: string | null }>(
      `select path, frontmatter->>'channel' as channel from items where ${where}`, params
    )).rows;
  } catch (cause) {
    throw new Error(`Channel scope lookup failed for team ${teamId}; retry or inspect the items query`, { cause });
  }
  const legacy = new Set<string>();
  const scoped = new Set<string>();
  for (const { path, channel } of rows) {
    const parsed = parseSlackItemPath(path);
    if (parsed?.kind === "legacy") legacy.add(`slack/${parsed.channelSegment}/`);
    if (parsed?.kind === "scoped" &&
        // The fallback path match may have hit a scoped *workspace* named like the channel.
        channel?.toLowerCase() === name.toLowerCase() &&
        scopedSlackItemPath(parsed.workspaceSegment, parsed.channelSegment, parsed.rootTs) === path) {
      scoped.add(`slack/${parsed.workspaceSegment}/${parsed.channelSegment}/`);
    }
  }
  return { name, legacyPrefixes: [...legacy].sort(), scopedPrefixes: [...scoped].sort() };
}

/** Append one identical SQL predicate to FTS and both recency legs, before their ORDER/LIMIT. */
export function channelScopeSql(scope: VisibleChannelScope, alias: string, params: unknown[]): string {
  params.push(scope.name);
  const name = `$${params.length}`;
  const arms = [`(${alias}.path not like 'slack/%' and
    (split_part(${alias}.path, '/', 2) = ${name} or
     lower(${alias}.frontmatter->>'channel') = lower(${name})))`];
  for (const prefixes of [scope.legacyPrefixes, scope.scopedPrefixes]) {
    for (const prefix of prefixes) {
      params.push(`${escapeLike(prefix)}%`);
      const pattern = `$${params.length}`;
      // A prefix ending in slash and a parser-shaped filename keep legacy and scoped identities
      // separate even when a legacy channel segment equals a scoped workspace segment.
      const filename = `substring(${alias}.path from ${prefix.length + 1})`;
      const seconds = `trim(leading '0' from split_part(${filename}, '.', 1))`;
      arms.push(`(${alias}.path like ${pattern} escape '\\' and
        case when ${filename} ~ '^[0-9]+[.][0-9]{1,6}[.]md$' then
          length(${seconds}) between 1 and 12 and lpad(${seconds}, 12, '0') <= '253402300799'
        else false end)`);
    }
  }
  return `(${arms.join(" or ")})`;
}
