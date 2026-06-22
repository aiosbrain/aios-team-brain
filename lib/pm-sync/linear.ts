import "server-only";

import {
  desiredStateForStatus,
  normalizeName,
  PmSyncError,
  priorityToLinearInt,
  requireString,
  sameLabelSet,
  type DesiredState,
  type FetchSeenStatesInput,
  type PmAdapter,
  type PrepareInput,
  type ProviderSyncInput,
  type ProviderSyncResult,
  type StateGroup,
  type UpsertWorkItemInput,
  type UpsertWorkItemResult,
} from "@/lib/pm-sync/provider";

type LinearGraphqlResponse<T> = { data?: T; errors?: { message: string }[] };
type LinearState = { id: string; name: string; type: string };
type LinearLabel = { id: string; name: string };
type LinearIssue = {
  id: string;
  identifier?: string;
  url?: string;
  title?: string;
  description?: string | null;
  priority?: number | null;
  parent?: { id: string } | null;
  state?: { id: string; name?: string; type?: string } | null;
  labels?: { nodes: LinearLabel[] } | null;
  team?: { id: string } | null;
};

interface LinearBootstrap {
  teamId: string;
  states: LinearState[];
  labels: Map<string, string>; // name → id
  issuesByExt: Map<string, LinearIssue>; // row_key → issue
  issuesById: Map<string, LinearIssue>;
}

// Plane↔Linear share five groups; Linear state.type uses "canceled" (one l).
const GROUP_TO_TYPE: Record<StateGroup, string> = {
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  cancelled: "canceled",
};

const EXT_RE = /aios-ext:\s*([A-Za-z0-9._-]+)\s*[·•]\s*source:\s*([A-Za-z0-9._-]+)/;
const extMarker = (rowKey: string, source: string) => `aios-ext: ${rowKey} · source: ${source}`;
function parseExt(description: string | null | undefined): string | null {
  const m = String(description ?? "").match(EXT_RE);
  return m ? m[1] : null;
}
// Body that Linear stores = plain text + the idempotency footer. Strip the footer to compare to tasks.body.
function withFooter(body: string, rowKey: string, source: string): string {
  const text = (body ?? "").trim();
  return `${text}\n\n${extMarker(rowKey, source)}`;
}
function stripFooter(description: string | null | undefined): string {
  return String(description ?? "").replace(EXT_RE, "").trim();
}

async function graphql<T>(fetchImpl: typeof fetch, apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
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

interface LinearCtx {
  fetchImpl: typeof fetch;
  apiKey: string;
  externalSource: string;
  teamIdConfig?: string;
}

function linearCtx(input: { integration: { config?: Record<string, unknown> | null; secret: string | null }; link?: { provider_external_source?: string } | null; fetchImpl?: typeof fetch }): LinearCtx {
  const config = input.integration.config ?? {};
  const apiKey = requireString(input.integration.secret, "Linear API key");
  const externalSource = (config.externalSource as string | undefined) || input.link?.provider_external_source || "aios-backlog";
  return { fetchImpl: input.fetchImpl ?? fetch, apiKey, externalSource, teamIdConfig: config.teamId as string | undefined };
}

function resolveStateByGroup(states: LinearState[], desired: DesiredState): LinearState {
  const type = GROUP_TO_TYPE[desired.group];
  const ofType = states.filter((s) => s.type === type);
  const wantName = normalizeName(desired.preferredName);
  const named = ofType.find((s) => normalizeName(s.name) === wantName) || states.find((s) => normalizeName(s.name) === wantName && desired.group === "started");
  const target = named || ofType[0];
  if (!target?.id) throw new PmSyncError(`Linear workflow state not found for group=${desired.group}`);
  return target;
}

async function buildBootstrap(ctx: LinearCtx, teamId: string): Promise<LinearBootstrap> {
  const data = await graphql<{
    team: {
      states: { nodes: LinearState[] };
      labels: { nodes: LinearLabel[] };
    } | null;
  }>(
    ctx.fetchImpl,
    ctx.apiKey,
    `query ProjectionBootstrap($teamId: String!) {
      team(id: $teamId) {
        states(first: 100) { nodes { id name type } }
        labels(first: 250) { nodes { id name } }
      }
    }`,
    { teamId }
  );
  const states = data.team?.states.nodes ?? [];
  const labels = new Map<string, string>((data.team?.labels.nodes ?? []).map((l) => [l.name, l.id]));

  const issuesByExt = new Map<string, LinearIssue>();
  const issuesById = new Map<string, LinearIssue>();
  type IssuesPage = { team: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: LinearIssue[] } } | null };
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page: IssuesPage = await graphql<IssuesPage>(
      ctx.fetchImpl,
      ctx.apiKey,
      `query ProjectionIssues($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id identifier url title description priority parent { id } state { id name type } labels { nodes { id name } } team { id } }
          }
        }
      }`,
      { teamId, after }
    );
    const conn = page.team?.issues;
    if (!conn) break;
    for (const issue of conn.nodes) {
      issuesById.set(issue.id, issue);
      const ext = parseExt(issue.description);
      if (ext) issuesByExt.set(ext, issue);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { teamId, states, labels, issuesByExt, issuesById };
}

async function ensureLabelIds(ctx: LinearCtx, boot: LinearBootstrap, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    if (!name) continue;
    let id = boot.labels.get(name);
    if (!id) {
      const data = await graphql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CreateLabel($name: String!, $teamId: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId }) { issueLabel { id } }
        }`,
        { name, teamId: boot.teamId }
      );
      id = data.issueLabelCreate.issueLabel.id;
      boot.labels.set(name, id);
    }
    ids.push(id);
  }
  return ids;
}

async function resolveIssueLite(ctx: LinearCtx, id: string): Promise<LinearIssue> {
  const data = await graphql<{ issue: LinearIssue | null }>(
    ctx.fetchImpl,
    ctx.apiKey,
    `query IssueForPmSync($id: String!) {
      issue(id: $id) { id identifier url team { id } state { id name type } }
    }`,
    { id }
  );
  if (!data.issue) throw new PmSyncError(`Linear issue not found for ${id}`);
  return data.issue;
}

async function resolveStatesForTeam(ctx: LinearCtx, teamId: string): Promise<LinearState[]> {
  const data = await graphql<{ team: { states: { nodes: LinearState[] } } | null }>(
    ctx.fetchImpl,
    ctx.apiKey,
    `query TeamDoneStates($teamId: String!) {
      team(id: $teamId) { states(first: 100) { nodes { id name type } } }
    }`,
    { teamId }
  );
  return data.team?.states.nodes ?? [];
}

function linearIssueMatches(issue: LinearIssue, desired: { title: string; stateId: string; priority: number; labelIds: string[]; parent: string | null; body: string }): boolean {
  if ((issue.title ?? "") !== desired.title) return false;
  if ((issue.state?.id ?? "") !== desired.stateId) return false;
  if ((issue.priority ?? 0) !== desired.priority) return false;
  if ((issue.parent?.id ?? null) !== desired.parent) return false;
  if (!sameLabelSet((issue.labels?.nodes ?? []).map((l) => l.id), desired.labelIds)) return false;
  if (stripFooter(issue.description) !== desired.body.trim()) return false;
  return true;
}

export const linearAdapter: PmAdapter = {
  provider: "linear",

  async prepare({ integration, fetchImpl }: PrepareInput): Promise<LinearBootstrap> {
    const ctx = linearCtx({ integration, fetchImpl });
    const teamId = requireString(ctx.teamIdConfig, "Linear teamId (config.teamId) for projection");
    return buildBootstrap(ctx, teamId);
  },

  // Phase 5 inbound reconcile: list every issue once and return resource id → current state NAME.
  // Read-only (reuses the projection bootstrap queries; performs no mutations).
  async fetchSeenStates({ integration, fetchImpl }: FetchSeenStatesInput): Promise<Map<string, string>> {
    const ctx = linearCtx({ integration, fetchImpl });
    const teamId = requireString(ctx.teamIdConfig, "Linear teamId (config.teamId) for reconcile");
    const boot = await buildBootstrap(ctx, teamId);
    const seen = new Map<string, string>();
    for (const [id, issue] of boot.issuesById) {
      if (issue.state?.name) seen.set(id, issue.state.name);
    }
    return seen;
  },

  async upsertWorkItem({ task, link, integration, desiredFingerprint, statusOnly, bootstrap, fetchImpl }: UpsertWorkItemInput): Promise<UpsertWorkItemResult> {
    const ctx = linearCtx({ integration, link, fetchImpl });
    const desired = desiredStateForStatus(task.status);

    // statusOnly: resolve the issue (by resource id) and reconcile only its workflow state.
    if (statusOnly) {
      if (!link) throw new PmSyncError("Linear statusOnly upsert requires an existing link");
      const ref = link.provider_resource_id || link.provider_external_id;
      const issue = await resolveIssueLite(ctx, ref);
      const teamId = ctx.teamIdConfig || issue.team?.id;
      if (!teamId) throw new PmSyncError("Linear team could not be resolved for statusOnly upsert");
      const states = await resolveStatesForTeam(ctx, teamId);
      const state = resolveStateByGroup(states, desired);
      const changed = issue.state?.id !== state.id;
      if (changed) {
        await graphql(
          ctx.fetchImpl,
          ctx.apiKey,
          `mutation SetIssueState($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id } }
          }`,
          { id: issue.id, stateId: state.id }
        );
      }
      return {
        provider: "linear",
        status: changed ? "synced" : "skipped",
        providerResourceId: issue.id,
        providerUrl: issue.url || link.provider_url || "",
        externalSource: ctx.externalSource,
        syncedStatus: state.name,
        fingerprint: desiredFingerprint,
      };
    }

    const teamId = requireString(ctx.teamIdConfig, "Linear teamId (config.teamId) for projection");
    const boot = (bootstrap as LinearBootstrap | undefined) ?? (await buildBootstrap(ctx, teamId));
    const state = resolveStateByGroup(boot.states, desired);
    const labelIds = await ensureLabelIds(ctx, boot, task.labels);
    const priority = priorityToLinearInt(task.priority);
    const parent = task.parentResourceId ?? null;
    const description = withFooter(task.body, task.row_key, ctx.externalSource);
    const desiredFields = { title: task.title, stateId: state.id, priority, labelIds, parent, body: task.body };

    // Adopt-or-create: resource id wins, else the footer marker carrying the row_key.
    const existing = (link?.provider_resource_id ? boot.issuesById.get(link.provider_resource_id) : undefined) || boot.issuesByExt.get(task.row_key);

    let issue: LinearIssue;
    let mutated = false;
    if (existing?.id) {
      issue = existing;
      if (!linearIssueMatches(issue, desiredFields)) {
        const data = await graphql<{ issueUpdate: { issue: LinearIssue } }>(
          ctx.fetchImpl,
          ctx.apiKey,
          `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
          }`,
          { id: issue.id, input: { title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent } }
        );
        issue = { ...issue, ...data.issueUpdate.issue, state: { id: state.id }, priority, labels: { nodes: labelIds.map((id) => ({ id, name: "" })) }, parent: parent ? { id: parent } : null, title: task.title, description };
        boot.issuesById.set(issue.id, issue);
        mutated = true;
      }
    } else {
      const data = await graphql<{ issueCreate: { issue: LinearIssue } }>(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier url } }
        }`,
        { input: { teamId, title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent } }
      );
      issue = { ...data.issueCreate.issue, description, title: task.title };
      boot.issuesById.set(issue.id, issue);
      boot.issuesByExt.set(task.row_key, issue);
      mutated = true;
    }

    return {
      provider: "linear",
      status: mutated ? "synced" : "skipped",
      providerResourceId: issue.id,
      providerUrl: issue.url || link?.provider_url || "",
      parentResourceId: parent,
      externalSource: ctx.externalSource,
      syncedStatus: state.name,
      fingerprint: desiredFingerprint,
    };
  },

  // Thin delegate: reconcile only the workflow state of an already-linked issue to "done".
  async moveToDone({ link, integration, fetchImpl }: ProviderSyncInput): Promise<ProviderSyncResult> {
    const ctx = linearCtx({ integration, link, fetchImpl });
    const ref = link.provider_resource_id || link.provider_external_id;
    const issue = await resolveIssueLite(ctx, ref);
    const teamId = ctx.teamIdConfig || issue.team?.id;
    if (!teamId) throw new PmSyncError("Linear team could not be resolved");
    const states = await resolveStatesForTeam(ctx, teamId);
    const state = resolveStateByGroup(states, desiredStateForStatus("done"));
    const changed = issue.state?.id !== state.id;
    if (changed) {
      await graphql(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CompleteIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id identifier url state { id name type } } }
        }`,
        { id: issue.id, stateId: state.id }
      );
    }
    return {
      provider: "linear",
      status: changed ? "synced" : "skipped",
      providerResourceId: issue.id,
      providerUrl: issue.url,
      syncedStatus: state.name,
    };
  },
};
