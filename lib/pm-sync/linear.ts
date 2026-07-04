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
  type SeenState,
  type StateGroup,
  type UpsertWorkItemInput,
  type UpsertWorkItemResult,
} from "@/lib/pm-sync/provider";
import { linearGraphql, parseExt, withFooter, stripFooter } from "@/lib/pm-sync/linear-client";

type LinearState = { id: string; name: string; type: string };
type LinearLabel = { id: string; name: string };
type LinearUser = { id: string; name?: string; displayName?: string; email?: string };
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
  assignee?: { id: string } | null;
  team?: { id: string } | null;
};

interface LinearBootstrap {
  teamId: string;
  states: LinearState[];
  labels: Map<string, string>; // name → id
  members: Map<string, string>; // normalized name / displayName / email → user id
  issuesByExt: Map<string, LinearIssue>; // row_key → issue
  issuesById: Map<string, LinearIssue>;
}

// Build the assignee resolver index from team members. A normalized name OR displayName shared by two
// different users is AMBIGUOUS and dropped — we never guess an owner (resolveAssigneeId then returns
// undefined = leave untouched). Email is unique, so it is always authoritative (added after the drop).
function indexMembers(nodes: LinearUser[]): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  const addName = (key: string, id: string) => {
    if (!key) return;
    const prev = map.get(key);
    if (prev && prev !== id) ambiguous.add(key);
    else map.set(key, id);
  };
  for (const u of nodes) {
    if (u.name) addName(normalizeName(u.name), u.id);
    if (u.displayName) addName(normalizeName(u.displayName), u.id);
  }
  for (const key of ambiguous) map.delete(key);
  for (const u of nodes) if (u.email) map.set(u.email.trim().toLowerCase(), u.id);
  return map;
}

// Resolve a brain `assignee` free-text value to a Linear user id. Returns undefined when the text is
// empty OR matches no (unambiguous) member — callers treat undefined as "leave the provider assignee
// untouched" (the brain never force-unassigns; it only sets an owner it can positively resolve).
function resolveAssigneeId(members: Map<string, string>, assignee: string): string | undefined {
  const key = normalizeName(assignee || "");
  if (!key) return undefined;
  return members.get(key) ?? members.get((assignee || "").trim().toLowerCase());
}

// Plane↔Linear share five groups; Linear state.type uses "canceled" (one l).
const GROUP_TO_TYPE: Record<StateGroup, string> = {
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  completed: "completed",
  cancelled: "canceled",
};

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
  const data = await linearGraphql<{
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

  // Page ALL team members (one page caps at 250 → silently un-resolvable assignees on a large team),
  // then index by normalized name + displayName + lowercased email (see indexMembers).
  type MembersPage = { team: { members: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: LinearUser[] } } | null };
  const memberNodes: LinearUser[] = [];
  let mAfter: string | null = null;
  for (let i = 0; i < 50; i++) {
    const mp: MembersPage = await linearGraphql<MembersPage>(
      ctx.fetchImpl,
      ctx.apiKey,
      `query ProjectionMembers($teamId: String!, $after: String) {
        team(id: $teamId) { members(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name displayName email } } }
      }`,
      { teamId, after: mAfter }
    );
    const conn = mp.team?.members;
    if (!conn) break;
    memberNodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    mAfter = conn.pageInfo.endCursor;
  }
  const members = indexMembers(memberNodes);

  const issuesByExt = new Map<string, LinearIssue>();
  const issuesById = new Map<string, LinearIssue>();
  type IssuesPage = { team: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: LinearIssue[] } } | null };
  let after: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page: IssuesPage = await linearGraphql<IssuesPage>(
      ctx.fetchImpl,
      ctx.apiKey,
      `query ProjectionIssues($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id identifier url title description priority parent { id } state { id name type } labels { nodes { id name } } assignee { id } team { id } }
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
  return { teamId, states, labels, members, issuesByExt, issuesById };
}

async function ensureLabelIds(ctx: LinearCtx, boot: LinearBootstrap, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    if (!name) continue;
    let id = boot.labels.get(name);
    if (!id) {
      const data = await linearGraphql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
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
  const data = await linearGraphql<{ issue: LinearIssue | null }>(
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
  const data = await linearGraphql<{ team: { states: { nodes: LinearState[] } } | null }>(
    ctx.fetchImpl,
    ctx.apiKey,
    `query TeamDoneStates($teamId: String!) {
      team(id: $teamId) { states(first: 100) { nodes { id name type } } }
    }`,
    { teamId }
  );
  return data.team?.states.nodes ?? [];
}

function linearIssueMatches(issue: LinearIssue, desired: { title: string; stateId: string; priority: number; labelIds: string[]; parent: string | null; body: string; assigneeId: string | undefined }): boolean {
  if ((issue.title ?? "") !== desired.title) return false;
  if ((issue.state?.id ?? "") !== desired.stateId) return false;
  if ((issue.priority ?? 0) !== desired.priority) return false;
  if ((issue.parent?.id ?? null) !== desired.parent) return false;
  if (!sameLabelSet((issue.labels?.nodes ?? []).map((l) => l.id), desired.labelIds)) return false;
  // Only a positively-resolved owner participates in the diff: undefined = "leave as-is", so a brain
  // task with no resolvable owner never reports a mismatch on assignee (and never blanks it).
  if (desired.assigneeId !== undefined && (issue.assignee?.id ?? null) !== desired.assigneeId) return false;
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

  // Phase 5 inbound reconcile / v1.4 inbound apply: list every issue once and return resource id →
  // current state { name, type }. Read-only (reuses the projection bootstrap queries; no mutations).
  async fetchSeenStates({ integration, fetchImpl }: FetchSeenStatesInput): Promise<Map<string, SeenState>> {
    const ctx = linearCtx({ integration, fetchImpl });
    const teamId = requireString(ctx.teamIdConfig, "Linear teamId (config.teamId) for reconcile");
    const boot = await buildBootstrap(ctx, teamId);
    const seen = new Map<string, SeenState>();
    for (const [id, issue] of boot.issuesById) {
      if (issue.state?.name) seen.set(id, { name: issue.state.name, type: issue.state.type ?? "" });
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
        await linearGraphql(
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
    const assigneeId = resolveAssigneeId(boot.members, task.assignee);
    const description = withFooter(task.body, task.row_key, ctx.externalSource);
    const desiredFields = { title: task.title, stateId: state.id, priority, labelIds, parent, body: task.body, assigneeId };

    // Adopt-or-create: resource id wins, else the footer marker carrying the row_key.
    const existing = (link?.provider_resource_id ? boot.issuesById.get(link.provider_resource_id) : undefined) || boot.issuesByExt.get(task.row_key);

    let issue: LinearIssue;
    let mutated = false;
    if (existing?.id) {
      issue = existing;
      if (!linearIssueMatches(issue, desiredFields)) {
        const data = await linearGraphql<{ issueUpdate: { issue: LinearIssue } }>(
          ctx.fetchImpl,
          ctx.apiKey,
          `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
          }`,
          { id: issue.id, input: { title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent, ...(assigneeId !== undefined ? { assigneeId } : {}) } }
        );
        issue = { ...issue, ...data.issueUpdate.issue, state: { id: state.id }, priority, labels: { nodes: labelIds.map((id) => ({ id, name: "" })) }, parent: parent ? { id: parent } : null, assignee: assigneeId !== undefined ? { id: assigneeId } : issue.assignee, title: task.title, description };
        boot.issuesById.set(issue.id, issue);
        mutated = true;
      }
    } else {
      const data = await linearGraphql<{ issueCreate: { issue: LinearIssue } }>(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier url } }
        }`,
        { input: { teamId, title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent, ...(assigneeId !== undefined ? { assigneeId } : {}) } }
      );
      issue = { ...data.issueCreate.issue, description, title: task.title, assignee: assigneeId !== undefined ? { id: assigneeId } : null };
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
      await linearGraphql(
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
