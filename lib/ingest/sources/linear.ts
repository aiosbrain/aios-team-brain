import "server-only";

import { linearGraphql } from "@/lib/pm-sync/linear-client";
import type { LinearImportIssue } from "./linear-normalize";

/**
 * Read-only Linear fetch for the inbound ingestion runner. Pulls a team's issues (plus the team
 * key for the brain project slug) via the shared GraphQL client, with cursor pagination.
 */

export interface FetchedLinearTeam {
  teamKey: string;
  issues: LinearImportIssue[];
}

interface IssuesPage {
  team: {
    key: string;
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearImportIssue[];
    };
  } | null;
}

const ISSUES_QUERY = `query ImportIssues($teamId: String!, $after: String) {
  team(id: $teamId) {
    key
    issues(first: 100, after: $after, orderBy: updatedAt) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title description url priority
        state { name type }
        assignee { displayName }
        parent { identifier }
        labels { nodes { name } }
        project { name }
        cycle { name number }
      }
    }
  }
}`;

export async function fetchLinearTeam(opts: {
  apiKey: string;
  teamId: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchedLinearTeam> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const issues: LinearImportIssue[] = [];
  let teamKey = opts.teamId;
  let after: string | null = null;

  for (let i = 0; i < 200; i++) {
    const data: IssuesPage = await linearGraphql<IssuesPage>(fetchImpl, opts.apiKey, ISSUES_QUERY, {
      teamId: opts.teamId,
      after,
    });
    const team = data.team;
    if (!team) break;
    if (team.key) teamKey = team.key;
    issues.push(...(team.issues.nodes ?? []));
    if (!team.issues.pageInfo.hasNextPage || !team.issues.pageInfo.endCursor) break;
    after = team.issues.pageInfo.endCursor;
  }

  return { teamKey, issues };
}
