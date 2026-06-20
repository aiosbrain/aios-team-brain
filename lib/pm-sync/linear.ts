import "server-only";

import {
  normalizeName,
  PmSyncError,
  requireString,
  type PmAdapter,
  type ProviderSyncInput,
  type ProviderSyncResult,
} from "@/lib/pm-sync/provider";

type LinearGraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

async function graphql<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const res = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => null)) as LinearGraphqlResponse<T> | null;
  if (!res.ok || json?.errors?.length || !json?.data) {
    const message = json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new PmSyncError(`Linear GraphQL failed: ${message}`);
  }
  return json.data;
}

async function resolveIssue(
  fetchImpl: typeof fetch,
  apiKey: string,
  id: string
): Promise<{ id: string; identifier: string; url?: string; team: { id: string }; state?: { id: string; name: string; type: string } }> {
  const data = await graphql<{
    issue: {
      id: string;
      identifier: string;
      url?: string;
      team: { id: string };
      state?: { id: string; name: string; type: string };
    } | null;
  }>(
    fetchImpl,
    apiKey,
    `query IssueForPmSync($id: String!) {
      issue(id: $id) {
        id identifier url
        team { id }
        state { id name type }
      }
    }`,
    { id }
  );
  if (!data.issue) throw new PmSyncError(`Linear issue not found for ${id}`);
  return data.issue;
}

async function resolveDoneState(
  fetchImpl: typeof fetch,
  apiKey: string,
  teamId: string,
  preferredName?: string
): Promise<{ id: string; name: string }> {
  const data = await graphql<{
    team: { states: { nodes: { id: string; name: string; type: string; position?: number }[] } } | null;
  }>(
    fetchImpl,
    apiKey,
    `query TeamDoneStates($teamId: String!) {
      team(id: $teamId) {
        states(filter: { type: { eq: "completed" } }) {
          nodes { id name type position }
        }
      }
    }`,
    { teamId }
  );
  const states = data.team?.states.nodes ?? [];
  const normalized = preferredName ? normalizeName(preferredName) : "";
  const byName = normalized ? states.find((s) => normalizeName(s.name) === normalized) : null;
  const done = states.find((s) => normalizeName(s.name) === "done");
  const target = byName || done || states[0];
  if (!target?.id) throw new PmSyncError("Linear completed workflow state not found");
  return target;
}

export const linearAdapter: PmAdapter = {
  provider: "linear",
  async moveToDone({ link, integration, fetchImpl = fetch }: ProviderSyncInput): Promise<ProviderSyncResult> {
    const apiKey = requireString(integration.secret, "Linear API key");
    const issueRef = link.provider_resource_id || link.provider_external_id;
    const issue = await resolveIssue(fetchImpl, apiKey, issueRef);
    const config = integration.config ?? {};
    const teamId = (config.teamId as string | undefined) || issue.team.id;
    const doneState = await resolveDoneState(fetchImpl, apiKey, teamId, config.doneStateName as string | undefined);

    if (issue.state?.id !== doneState.id) {
      await graphql(
        fetchImpl,
        apiKey,
        `mutation CompleteIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
            issue { id identifier url state { id name type } }
          }
        }`,
        { id: issue.id, stateId: doneState.id }
      );
    }

    return {
      provider: "linear",
      status: issue.state?.id === doneState.id ? "skipped" : "synced",
      providerResourceId: issue.id,
      providerUrl: issue.url,
      syncedStatus: doneState.name,
    };
  },
};
