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
import { linearGraphql, linearMutation, parseExt, withFooter, stripFooter } from "@/lib/pm-sync/linear-client";

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
  /** ADOPTDECL-1 — human identifier ("AIO-877") → issue, for rows that DECLARED one. */
  issuesByIdentifier: Map<string, LinearIssue>;
  /** The team's issue-key prefix ("AIO"), so an unresolved key can be called foreign instead of a typo. */
  teamKey: string | null;
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
      key?: string | null;
      states: { nodes: LinearState[] };
      labels: { nodes: LinearLabel[] };
    } | null;
  }>(
    ctx.fetchImpl,
    ctx.apiKey,
    `query ProjectionBootstrap($teamId: String!) {
      team(id: $teamId) {
        key
        states(first: 100) { nodes { id name type } }
        labels(first: 250) { nodes { id name } }
      }
    }`,
    { teamId }
  );
  const teamKey = data.team?.key ?? null;
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
  const issuesByIdentifier = new Map<string, LinearIssue>();
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
      // Free: `identifier` is already on every node this query returns. No extra round-trip.
      if (issue.identifier) issuesByIdentifier.set(issue.identifier, issue);
      const ext = parseExt(issue.description);
      if (ext) issuesByExt.set(ext, issue);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { teamId, states, labels, members, issuesByExt, issuesById, issuesByIdentifier, teamKey };
}

async function ensureLabelIds(ctx: LinearCtx, boot: LinearBootstrap, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    if (!name) continue;
    let id = boot.labels.get(name);
    if (!id) {
      // `success` was the one mutation that never even ASKED for it (PMSUCCESS-1); it does now, so no
      // call site depends on a tolerated absence.
      const data = await linearMutation<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CreateLabel($name: String!, $teamId: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId }) { success issueLabel { id } }
        }`,
        { name, teamId: boot.teamId },
        { payload: "issueLabelCreate", entity: "issueLabel" }
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

  async upsertWorkItem({ task, link, integration, desiredFingerprint, statusOnly, bootstrap, fetchImpl, ownedResourceIds }: UpsertWorkItemInput): Promise<UpsertWorkItemResult> {
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
        // The result used to be discarded outright. That is the site whose refusal is REVERTED in the
        // brain: it returns the DESIRED state below, `persistSuccess` records it as projected, and the
        // next inbound pass sees Linear's real state over an "unchanged" brain row and writes it back.
        await linearMutation(
          ctx.fetchImpl,
          ctx.apiKey,
          `mutation SetIssueState($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id } }
          }`,
          { id: issue.id, stateId: state.id },
          { payload: "issueUpdate", entity: "issue" }
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
    const desiredFields = { title: task.title, stateId: state.id, priority, labelIds, parent, body: task.body, assigneeId };

    /**
     * ADOPTDECL-1 — the third rung: an issue a HUMAN named on this row.
     *
     * `declared_external_id` is non-null only when the task markdown carried `pm_external_id`
     * (`lib/ingest/tasks.ts` is its single writer). `provider_external_id` cannot be used here:
     * `ensureLink` defaults it to `row_key`, so a value there proves nothing and matching on it would
     * adopt a stranger's issue for any row whose key happens to look like an identifier.
     *
     * Ordered LAST so it never overrides a link that already knows its issue, and only consulted when
     * the first two rungs miss — which is what makes it an adoption rather than a re-resolution.
     */
    const declared = (link?.declared_external_id ?? "").trim();
    const byResourceId = link?.provider_resource_id ? boot.issuesById.get(link.provider_resource_id) : undefined;
    const byFooter = boot.issuesByExt.get(task.row_key);
    let adopted: LinearIssue | undefined;
    if (!byResourceId && !byFooter && declared) {
      const candidate = boot.issuesByIdentifier.get(declared);
      if (!candidate) {
        // A declared key we cannot honour is an ERROR, not a licence to invent a second issue —
        // creating one is the silent-duplicate behaviour this whole slice exists to remove.
        const foreign = boot.teamKey && declared.split("-")[0] !== boot.teamKey;
        throw new PmSyncError(
          foreign
            ? `Linear issue ${declared} declared on ${task.row_key} is not in team ${boot.teamKey} — probably another team's issue`
            : `Linear issue ${declared} declared on ${task.row_key} was not found in this team`
        );
      }
      // Refuse to take an issue that already belongs to someone — by EITHER means. A footer-only check
      // misses the shape that actually happens in prod: three TT1 links across three projects share
      // Linear issue AIO-444, and that issue carries NO footer. `ownedResourceIds` comes from the
      // caller, the only layer that can see other rows' links.
      const ownerExt = parseExt(candidate.description);
      if (ownerExt && ownerExt !== task.row_key) {
        throw new PmSyncError(
          `Linear issue ${declared} declared on ${task.row_key} already belongs to ${ownerExt} — refusing to give one issue two writers`
        );
      }
      if (ownedResourceIds?.has(candidate.id)) {
        throw new PmSyncError(
          `Linear issue ${declared} declared on ${task.row_key} is already linked to another task row — refusing to give one issue two writers`
        );
      }
      adopted = candidate;
    }

    /**
     * The adoption body SEEDS from the issue when the brain has nothing to say.
     *
     * A sync-pushed task has no body — `materializeTasks` never writes one and the schema says so
     * outright ("body is dashboard/DB-only — it never round-trips through the sync push"). So sending
     * the brain's body on adoption would erase a human's whole write-up down to a footer, every time.
     * `lib/pm-sync/inbound.ts` already solves this the same way for its own adoption path.
     *
     * Seeding only — once the brain HAS a body, the brain's body wins, exactly as for an issue the
     * brain created.
     */
    const adoptionBody = adopted && !(task.body ?? "").trim() ? stripFooter(adopted.description) : task.body;
    const description = withFooter(adoptionBody, task.row_key, ctx.externalSource);

    const existing = byResourceId || byFooter || adopted;

    let issue: LinearIssue;
    let mutated = false;
    if (existing?.id) {
      issue = existing;
      if (!linearIssueMatches(issue, desiredFields)) {
        // A refusal here used to LATCH: the desired fingerprint was persisted with a real resource id,
        // so `project.ts`'s short-circuit skipped the row on every future run and Linear stayed wrong
        // under `0 errors`. Throwing routes to `persistError`, which leaves the fingerprint stale.
        const data = await linearMutation<{ issueUpdate: { issue: LinearIssue } }>(
          ctx.fetchImpl,
          ctx.apiKey,
          `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
          }`,
          { id: issue.id, input: { title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent, ...(assigneeId !== undefined ? { assigneeId } : {}) } },
          { payload: "issueUpdate", entity: "issue" }
        );
        issue = { ...issue, ...data.issueUpdate.issue, state: { id: state.id }, priority, labels: { nodes: labelIds.map((id) => ({ id, name: "" })) }, parent: parent ? { id: parent } : null, assignee: assigneeId !== undefined ? { id: assigneeId } : issue.assignee, title: task.title, description };
        // ALL THREE indexes, not just the first. Refreshing only `issuesById` left `issuesByExt` and
        // `issuesByIdentifier` holding the PRE-update object, so a second row in the same batch
        // declaring the same key read a description with no footer and adopted the issue too —
        // deterministically, no race required.
        boot.issuesById.set(issue.id, issue);
        if (issue.identifier) boot.issuesByIdentifier.set(issue.identifier, issue);
        boot.issuesByExt.set(task.row_key, issue);
        mutated = true;
      }
    } else {
      const data = await linearMutation<{ issueCreate: { issue: LinearIssue } }>(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier url } }
        }`,
        { input: { teamId, title: task.title, description, stateId: state.id, priority, labelIds, parentId: parent, ...(assigneeId !== undefined ? { assigneeId } : {}) } },
        { payload: "issueCreate", entity: "issue" }
      );
      issue = { ...data.issueCreate.issue, description, title: task.title, assignee: assigneeId !== undefined ? { id: assigneeId } : null };
      boot.issuesById.set(issue.id, issue);
      boot.issuesByExt.set(task.row_key, issue);
      mutated = true;
    }

    return {
      provider: "linear",
      // An adoption reports as an adoption even when no mutation was needed: the row DID change hands,
      // and burying that under `synced`/`skipped` is how the duplicate damage stayed invisible.
      status: adopted ? "adopted" : mutated ? "synced" : "skipped",
      // The caller persists this into `tasks.body` and fingerprints over it — see
      // `ProviderSyncResult.seededBody`. Without that the seed evaporates on the next push.
      seededBody: adopted && adoptionBody !== task.body ? adoptionBody : null,
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
      await linearMutation(
        ctx.fetchImpl,
        ctx.apiKey,
        `mutation CompleteIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id identifier url state { id name type } } }
        }`,
        { id: issue.id, stateId: state.id },
        { payload: "issueUpdate", entity: "issue" }
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
