/**
 * Inactive, read-only planning for the attended Slack identity cutover. The future discovery
 * step must load every team Slack row, including provider spelling variants recognized by
 * String.trim().toLowerCase(), and establish the historical source census from durable integration/auth history,
 * then verify a complete account inventory for every workspace in that census. Evidence IDs
 * refer to retained operator-reviewable records. A current integration, display name, email,
 * item frontmatter, or one mapped qualified row cannot establish this closed world.
 *
 * This function only evaluates supplied evidence. It cannot verify that the future discovery
 * step was honest or that writes stayed paused; its output is never authorization to set the
 * cutover marker. Account existence and account-to-member mapping are separate observations;
 * mappings must come from verified auth/link history, never an email or handle inference.
 * Missing census or workspace inventory leaves rows pending. Any qualified row that
 * contradicts the census or an observed inventory blocks all raw qualifications;
 * qualified rows are never used as substitute account or member observations.
 */

export interface SlackCutoverIdentityRow {
  id: string;
  teamId: string;
  provider: string;
  memberId: string;
  externalId: string;
}

export interface VerifiedSlackAccountInventory {
  teamId: string;
  workspaceId: string;
  evidenceId: string;
  accounts: readonly {
    userId: string;
    /** Null means the provider account was observed but has no verified roster mapping. */
    memberId: string | null;
    evidenceId: string;
  }[];
}

export interface SlackHistoricalSourceCensus {
  teamId: string;
  evidenceId: string;
  sources: readonly {
    sourceId: string;
    workspaceId: string;
    evidenceId: string;
  }[];
}

export interface SlackCutoverDiscovery {
  /** Omit until every historical integration/auth source has been enumerated and verified. */
  historicalSourceCensus?: SlackHistoricalSourceCensus;
  /** Each inventory must be a completed provider/account observation, not a partial page. */
  workspaceAccountInventories: readonly VerifiedSlackAccountInventory[];
}

export interface SlackCutoverInput {
  teamId: string;
  rows: readonly SlackCutoverIdentityRow[];
  discovery: SlackCutoverDiscovery;
}

export type SlackCutoverOutcome =
  | { status: "qualify_in_place"; rowId: string; memberId: string; fromExternalId: string; toExternalId: string }
  | { status: "qualified_noop"; rowId: string; externalId: string }
  | { status: "qualified_pending_incomplete_provenance"; rowId: string }
  | { status: "qualified_workspace_outside_census"; rowId: string; workspaceId: string }
  | { status: "qualified_unknown_account"; rowId: string; workspaceId: string }
  | { status: "qualified_unmapped_account"; rowId: string; workspaceId: string }
  | { status: "qualified_mismatched_member"; rowId: string; workspaceId: string }
  | { status: "noncanonical_qualified_account"; rowId: string }
  | { status: "noncanonical_slack_provider"; rowId: string }
  | { status: "pending_incomplete_provenance"; rowId: string }
  | { status: "pending_conflicting_provenance"; rowId: string }
  | { status: "qualified_pending_conflicting_provenance"; rowId: string }
  | { status: "unknown_account"; rowId: string }
  | { status: "unmapped_account"; rowId: string; workspaceId: string }
  | { status: "ambiguous_workspaces"; rowId: string; workspaceIds: string[] }
  | { status: "mismatched_member"; rowId: string; workspaceId: string }
  | { status: "qualified_collision_same_member"; rowId: string; qualifiedRowIds: string[] }
  | { status: "qualified_collision_conflicting_member"; rowId: string; qualifiedRowIds: string[] }
  | { status: "duplicate_raw_account"; rowId: string; rawRowIds: string[] }
  | { status: "duplicate_qualified_account"; rowId: string; qualifiedRowIds: string[] };

const opaqueId = /^[A-Za-z0-9_-]+$/;
const slackPart = /^[A-Za-z0-9]+$/;

function requireId(value: unknown): string {
  if (typeof value !== "string" || !opaqueId.test(value)) {
    throw new Error("invalid Slack cutover input");
  }
  return value;
}

function requireSlackPart(value: unknown): string {
  if (typeof value !== "string" || !slackPart.test(value)) {
    throw new Error("invalid Slack cutover input");
  }
  return value.toUpperCase();
}

function externalParts(value: unknown): { workspaceId: string | null; userId: string } {
  if (typeof value !== "string") throw new Error("invalid Slack cutover input");
  const parts = value.split(":");
  if (parts.length === 1) return { workspaceId: null, userId: requireSlackPart(parts[0]) };
  if (parts.length === 2) {
    return { workspaceId: requireSlackPart(parts[0]), userId: requireSlackPart(parts[1]) };
  }
  throw new Error("invalid Slack cutover input");
}

/** Same inputs in any row/source/inventory/account order yield the same sanitized plan. */
export function classifySlackIdentityCutover(input: SlackCutoverInput): SlackCutoverOutcome[] {
  const teamId = requireId(input.teamId);
  const rows = new Map<string, SlackCutoverIdentityRow>();
  const rawByUser = new Map<string, string[]>();
  const qualifiedByAccount = new Map<string, SlackCutoverIdentityRow[]>();

  for (const candidate of input.rows) {
    const id = requireId(candidate.id);
    if (requireId(candidate.teamId) !== teamId) throw new Error("invalid Slack cutover input");
    if (typeof candidate.provider !== "string" || candidate.provider.trim().toLowerCase() !== "slack") {
      throw new Error("invalid Slack cutover input");
    }
    const memberId = requireId(candidate.memberId);
    const { workspaceId, userId } = externalParts(candidate.externalId);
    const previous = rows.get(id);
    if (previous) {
      if (previous.teamId !== candidate.teamId || previous.provider !== candidate.provider || previous.memberId !== memberId ||
          previous.externalId !== candidate.externalId) throw new Error("conflicting Slack cutover rows");
      continue;
    }
    rows.set(id, { id, teamId, provider: candidate.provider, memberId, externalId: candidate.externalId });
    if (workspaceId) {
      const account = `${workspaceId}:${userId}`;
      qualifiedByAccount.set(account, [...(qualifiedByAccount.get(account) ?? []),
        { id, teamId, provider: candidate.provider, memberId, externalId: candidate.externalId }]);
    } else {
      rawByUser.set(userId, [...(rawByUser.get(userId) ?? []), id]);
    }
  }

  const sources = input.discovery.historicalSourceCensus;
  const sourceWorkspaces = new Set<string>();
  const sourceIds = new Map<string, string>();
  if (sources) {
    if (requireId(sources.teamId) !== teamId) throw new Error("invalid Slack cutover input");
    requireId(sources.evidenceId);
    for (const source of sources.sources) {
      const sourceId = requireId(source.sourceId);
      const workspaceId = requireSlackPart(source.workspaceId);
      requireId(source.evidenceId);
      const prior = sourceIds.get(sourceId);
      if (prior && prior !== workspaceId) throw new Error("conflicting Slack discovery evidence");
      sourceIds.set(sourceId, workspaceId);
      sourceWorkspaces.add(workspaceId);
    }
  }

  const inventories = new Map<string, Map<string, string | null>>();
  for (const inventory of input.discovery.workspaceAccountInventories) {
    if (requireId(inventory.teamId) !== teamId) throw new Error("invalid Slack cutover input");
    const workspaceId = requireSlackPart(inventory.workspaceId);
    requireId(inventory.evidenceId);
    if (inventories.has(workspaceId)) throw new Error("conflicting Slack discovery evidence");
    const accounts = new Map<string, string | null>();
    for (const account of inventory.accounts) {
      const userId = requireSlackPart(account.userId);
      const memberId = account.memberId === null ? null : requireId(account.memberId);
      requireId(account.evidenceId);
      const prior = accounts.get(userId);
      if (accounts.has(userId) && prior !== memberId) throw new Error("conflicting Slack discovery evidence");
      accounts.set(userId, memberId);
    }
    inventories.set(workspaceId, accounts);
  }
  if (sources && [...inventories.keys()].some((workspaceId) => !sourceWorkspaces.has(workspaceId))) {
    throw new Error("conflicting Slack discovery evidence");
  }

  const complete = !!sources && sourceWorkspaces.size > 0 &&
    [...sourceWorkspaces].every((workspaceId) => inventories.has(workspaceId));
  // A claimed closed world is unusable for every raw row if even one existing
  // qualified row disagrees with it. Duplicates and noncanonical qualified rows
  // also require review before the attended cutover can rely on that world.
  const qualifiedEvidenceConflict = [...rows.values()].some((row) => {
    const { workspaceId, userId } = externalParts(row.externalId);
    if (!workspaceId) return false;
    const account = `${workspaceId}:${userId}`;
    const accounts = inventories.get(workspaceId);
    return row.provider !== "slack" || row.externalId !== account ||
      (qualifiedByAccount.get(account)?.length ?? 0) > 1 ||
      (!!sources && !sourceWorkspaces.has(workspaceId)) ||
      (accounts !== undefined && (!accounts.has(userId) || accounts.get(userId) !== row.memberId));
  });
  const plan: SlackCutoverOutcome[] = [];
  for (const row of [...rows.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const { workspaceId, userId } = externalParts(row.externalId);
    if (workspaceId) {
      const duplicates = qualifiedByAccount.get(`${workspaceId}:${userId}`) ?? [];
      if (duplicates.length > 1) {
        plan.push({ status: "duplicate_qualified_account", rowId: row.id,
          qualifiedRowIds: duplicates.map((r) => r.id).sort() });
      } else if (row.provider !== "slack" || row.externalId !== `${workspaceId}:${userId}`) {
        plan.push({ status: "noncanonical_qualified_account", rowId: row.id });
      } else if (sources && !sourceWorkspaces.has(workspaceId)) {
        plan.push({ status: "qualified_workspace_outside_census", rowId: row.id, workspaceId });
      } else {
        const accounts = inventories.get(workspaceId);
        const observedMemberId = accounts?.get(userId);
        if (accounts?.has(userId) && observedMemberId === null) {
          plan.push({ status: "qualified_unmapped_account", rowId: row.id, workspaceId });
        } else if (accounts?.has(userId) && observedMemberId !== row.memberId) {
          plan.push({ status: "qualified_mismatched_member", rowId: row.id, workspaceId });
        } else if (!complete) {
          plan.push({ status: "qualified_pending_incomplete_provenance", rowId: row.id });
        } else if (!accounts?.has(userId)) {
          plan.push({ status: "qualified_unknown_account", rowId: row.id, workspaceId });
        } else if (qualifiedEvidenceConflict) {
          plan.push({ status: "qualified_pending_conflicting_provenance", rowId: row.id });
        } else {
          plan.push({ status: "qualified_noop", rowId: row.id, externalId: row.externalId });
        }
      }
      continue;
    }
    if (row.provider !== "slack") {
      plan.push({ status: "noncanonical_slack_provider", rowId: row.id });
      continue;
    }
    const rawDuplicates = rawByUser.get(userId) ?? [];
    if (rawDuplicates.length > 1) {
      plan.push({ status: "duplicate_raw_account", rowId: row.id, rawRowIds: [...rawDuplicates].sort() });
      continue;
    }
    const observed = [...inventories.entries()]
      .filter(([, accounts]) => accounts.has(userId))
      .map(([workspaceId, accounts]) => ({ workspaceId, memberId: accounts.get(userId) ?? null }))
      .sort((a, b) => a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0);
    if (observed.length > 1) {
      plan.push({ status: "ambiguous_workspaces", rowId: row.id, workspaceIds: observed.map((o) => o.workspaceId) });
      continue;
    }
    if (!complete) {
      plan.push({ status: "pending_incomplete_provenance", rowId: row.id });
      continue;
    }
    if (observed.length === 0) {
      plan.push({ status: "unknown_account", rowId: row.id });
      continue;
    }
    const only = observed[0];
    if (only.memberId === null) {
      plan.push({ status: "unmapped_account", rowId: row.id, workspaceId: only.workspaceId });
      continue;
    }
    if (only.memberId !== row.memberId) {
      plan.push({ status: "mismatched_member", rowId: row.id, workspaceId: only.workspaceId });
      continue;
    }
    const target = `${only.workspaceId}:${userId}`;
    const qualified = qualifiedByAccount.get(target) ?? [];
    if (qualified.length) {
      const qualifiedRowIds = qualified.map((r) => r.id).sort();
      plan.push({ status: qualified.every((r) => r.memberId === row.memberId)
        ? "qualified_collision_same_member" : "qualified_collision_conflicting_member",
      rowId: row.id, qualifiedRowIds });
      continue;
    }
    if (qualifiedEvidenceConflict) {
      plan.push({ status: "pending_conflicting_provenance", rowId: row.id });
      continue;
    }
    plan.push({ status: "qualify_in_place", rowId: row.id, memberId: row.memberId,
      fromExternalId: row.externalId, toExternalId: target });
  }
  return plan;
}
