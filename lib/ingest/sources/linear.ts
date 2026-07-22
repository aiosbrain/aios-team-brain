import "server-only";

import { linearGraphql } from "@/lib/pm-sync/linear-client";
import { timeoutFetch } from "@/lib/http";
import type { LinearImportIssue } from "./linear-normalize";

/**
 * Read-only Linear fetch for the inbound ingestion runner. Pulls a team's issues (plus the team
 * key for the brain project slug) via the shared GraphQL client, with cursor pagination.
 */

export interface LinearMember {
  id: string;
  displayName?: string;
  email?: string;
}

export interface FetchedLinearTeam {
  teamKey: string;
  issues: LinearImportIssue[];
  /** Team members (incl. email) for identity reconciliation. Captured from the first page. */
  members: LinearMember[];
}

interface IssuesPage {
  team: {
    key: string;
    members?: { nodes: LinearMember[] };
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearImportIssue[];
    };
  } | null;
}

const ISSUES_QUERY = `query ImportIssues($teamId: String!, $after: String) {
  team(id: $teamId) {
    key
    members(first: 250) { nodes { id displayName email } }
    issues(first: 100, after: $after, orderBy: updatedAt) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title description url priority
        state { name type }
        assignee { id displayName }
        parent { identifier }
        labels { nodes { name } }
        project { name }
        cycle { name number }
        startedAt completedAt canceledAt
      }
    }
  }
}`;

export async function fetchLinearTeam(opts: {
  apiKey: string;
  teamId: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchedLinearTeam> {
  const fetchImpl = opts.fetchImpl ?? timeoutFetch;
  const issues: LinearImportIssue[] = [];
  let teamKey = opts.teamId;
  let members: LinearMember[] = [];
  let after: string | null = null;

  for (let i = 0; i < 200; i++) {
    const data: IssuesPage = await linearGraphql<IssuesPage>(fetchImpl, opts.apiKey, ISSUES_QUERY, {
      teamId: opts.teamId,
      after,
    });
    const team = data.team;
    if (!team) break;
    if (team.key) teamKey = team.key;
    if (i === 0 && team.members?.nodes) members = team.members.nodes; // team membership is page-invariant
    issues.push(...(team.issues.nodes ?? []));
    if (!team.issues.pageInfo.hasNextPage || !team.issues.pageInfo.endCursor) break;
    after = team.issues.pageInfo.endCursor;
  }

  return { teamKey, issues, members };
}
