import "server-only";
import type { PoolClient } from "pg";
import type { ApiAuth } from "@/lib/api/auth";
import { auditRequired } from "@/lib/api/audit";
import { withTransaction } from "@/lib/db/pg/tx";
import type { IntakeRegistry } from "./debt-intake-registry";
import {
  canonicalRecord, validateRecord, validateTransition, validateRunSummary,
  type CandidateRecord, type CandidateState, type FindingRecord, type RunSummaryRecord,
} from "./debt-intake-validation";

export class DebtIntakeError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
const invalid = (): never => { throw new DebtIntakeError(422, "invalid_events"); };
const runKey = (record: FindingRecord) => `${record.producer.name}\0${record.producer.run_id}`;
export type IntakeAcknowledgment = {
  status: 200 | 201; accepted_event_ids: string[]; duplicate_event_ids: string[];
};

async function recheckAuthorization(client: PoolClient, auth: ApiAuth) {
  const result = await client.query<{ team_posture: boolean }>(
    `select exists (
       select 1 from group_members gm join groups g on g.id = gm.group_id and g.team_id = gm.team_id
       where gm.team_id = k.team_id and gm.member_id = m.id and g.is_builtin and g.slug = 'everyone'
     ) as team_posture
     from api_keys k join members m on m.id = k.member_id and m.team_id = k.team_id
     where k.id = $1 and k.team_id = $2 and k.member_id = $3
       and k.revoked_at is null and m.status = 'active'`,
    [auth.apiKeyId, auth.teamId, auth.memberId],
  );
  if (!result.rows[0]) throw new DebtIntakeError(401, "unauthorized");
  if (!result.rows[0].team_posture) throw new DebtIntakeError(403, "forbidden_tier");
}

/** Every caller passes through the same closed contract and immutable-ledger transaction. */
export async function ingestDebtIntake(
  auth: ApiAuth, slug: string, records: FindingRecord[], registry: IntakeRegistry,
): Promise<IntakeAcknowledgment> {
  if (auth.memberTier !== "team") throw new DebtIntakeError(403, "forbidden_tier");
  if (records.length < 1 || records.length > 256) invalid();
  const grants = Object.hasOwn(registry.uploaders, auth.apiKeyId) ? registry.uploaders[auth.apiKeyId] : undefined;
  if (!grants) throw new DebtIntakeError(403, "forbidden_producer");
  for (const record of records) {
    validateRecord(record, registry);
    if (!Object.hasOwn(grants, record.producer.name) || !grants[record.producer.name].includes(record.producer.version)) {
      throw new DebtIntakeError(403, "forbidden_producer");
    }
  }
  const unique = new Map<string, FindingRecord>();
  for (const record of records) {
    const prior = unique.get(record.event_id);
    if (prior && canonicalRecord(prior) !== canonicalRecord(record)) invalid();
    unique.set(record.event_id, record);
  }

  return withTransaction(async (client) => {
    await client.query("set local lock_timeout = '2s'");
    await client.query("set local statement_timeout = '15s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('debt-intake:' || $1, 0))", [auth.teamId]);
    await recheckAuthorization(client, auth);
    // Authorization is decided here, after queueing; no promise of commit-time admin revocation locking.
    const slugs = new Set([slug]);
    for (const record of unique.values()) if (record.record_type === "candidate") {
      for (const codebase of record.codebases) slugs.add(codebase);
      if (record.links.pull_request) slugs.add(record.links.pull_request.codebase);
      if (record.links.merge) slugs.add(record.links.merge.codebase);
    }
    if (!registry.codebases.includes(slug)) throw new DebtIntakeError(404, "not_found");
    const codebases = await client.query<{ slug: string }>(
      "select slug from codebases where team_id = $1 and slug = any($2::text[])", [auth.teamId, [...slugs]],
    );
    const visible = new Set(codebases.rows.map((row) => row.slug));
    if (!visible.has(slug)) throw new DebtIntakeError(404, "not_found");
    if ([...slugs].some((codebase) => !visible.has(codebase))) invalid();

    const replay = await client.query<{ event_id: string; canonical_record: string }>(
      "select event_id, canonical_record from codebase_debt_candidate_events where team_id = $1 and event_id = any($2::text[])",
      [auth.teamId, [...unique.keys()]],
    );
    const replayById = new Map(replay.rows.map((row) => [row.event_id, row.canonical_record]));
    const accepted: FindingRecord[] = [], duplicateIds: string[] = [];
    for (const record of unique.values()) {
      const stored = replayById.get(record.event_id);
      if (stored !== undefined) {
        if (stored !== canonicalRecord(record)) invalid();
        duplicateIds.push(record.event_id);
      } else accepted.push(record);
    }

    const candidates = accepted.filter((record): record is CandidateRecord => record.record_type === "candidate");
    const ids = [...new Set(candidates.map((record) => record.candidate_id))];
    const latest = await client.query<{ record: CandidateRecord }>(
      `select distinct on (candidate_id) record from codebase_debt_candidate_events
       where team_id = $1 and candidate_id = any($2::text[])
       order by candidate_id, sequence desc`, [auth.teamId, ids],
    );
    const globalLatestByCandidate = new Map(latest.rows.map(({ record }) => [record.candidate_id, record]));
    const newIdentities = new Map<string, CandidateRecord>();
    for (const record of [...candidates].sort((a, b) => a.sequence - b.sequence)) {
      const previous = globalLatestByCandidate.get(record.candidate_id) ?? null;
      validateTransition(previous, record);
      if (!previous) newIdentities.set(record.candidate_id, record);
      globalLatestByCandidate.set(record.candidate_id, record);
    }

    const edges = candidates.filter((record) => record.duplicate_target !== null)
      .map((record) => [record.candidate_id, record.duplicate_target!] as const);
    if (edges.length) {
      const targets = [...new Set(edges.map((edge) => edge[1]))];
      const storedTargets = await client.query<{ candidate_id: string }>(
        "select candidate_id from codebase_debt_candidates where team_id = $1 and candidate_id = any($2::text[])",
        [auth.teamId, targets],
      );
      const known = new Set([...storedTargets.rows.map((row) => row.candidate_id), ...newIdentities.keys()]);
      if (targets.some((target) => !known.has(target))) invalid();
      // Finite pair identity: adding path/depth to UNION would permit infinite recursive cycles.
      const cycles = await client.query<{ cycle: boolean }>(
        `with recursive incoming(source, target) as (
           select * from unnest($2::text[], $3::text[])
         ), edges(source, target) as (
           select candidate_id, duplicate_target from codebase_debt_candidate_events
           where team_id = $1 and duplicate_target is not null
           union select source, target from incoming
         ), reachable(source, target) as (
           select source, target from incoming
           union select r.source, e.target from reachable r join edges e on e.source = r.target
         ) select exists(select 1 from reachable where source = target) as cycle`,
        [auth.teamId, edges.map((edge) => edge[0]), edges.map((edge) => edge[1])],
      );
      if (cycles.rows[0].cycle) invalid();
    }

    const runs = new Map<string, FindingRecord[]>();
    for (const record of accepted) {
      const key = runKey(record);
      runs.set(key, [...(runs.get(key) ?? []), record]);
    }
    for (const incoming of runs.values()) {
      const first = incoming[0];
      const params = [auth.teamId, first.producer.name, first.producer.run_id];
      const finalized = await client.query(
        `select 1 from codebase_debt_candidate_events where team_id=$1 and producer_name=$2
         and producer_run_id=$3 and record_type='run_summary' limit 1`, params,
      );
      if (finalized.rowCount) invalid();
      const attribution = await client.query<{ attribution: FindingRecord["attribution"] }>(
        `select record->'attribution' as attribution from codebase_debt_candidate_events
         where team_id=$1 and producer_name=$2 and producer_run_id=$3 limit 1`, params,
      );
      const expectedAttribution = canonicalRecord(attribution.rows[0]?.attribution ?? first.attribution);
      if (incoming.some((record) => canonicalRecord(record.attribution) !== expectedAttribution)) invalid();
      const summaries = incoming.filter((record): record is RunSummaryRecord => record.record_type === "run_summary");
      if (summaries.length > 1) invalid();
      if (!summaries.length) continue;
      const countsResult = await client.query<{ state: CandidateState; count: string }>(
        `select state, count(*)::text as count from (
           select distinct on (candidate_id) record->>'state' as state
           from codebase_debt_candidate_events where team_id=$1 and producer_name=$2
             and producer_run_id=$3 and record_type='candidate' order by candidate_id, sequence desc
         ) latest group by state`, params,
      );
      const counts: Partial<Record<CandidateState, number>> = {};
      for (const row of countsResult.rows) counts[row.state] = Number(row.count);
      const incomingLatest = new Map<string, CandidateRecord>();
      for (const record of incoming) if (record.record_type === "candidate") {
        const prior = incomingLatest.get(record.candidate_id);
        if (!prior || prior.sequence < record.sequence) incomingLatest.set(record.candidate_id, record);
      }
      const priorRun = await client.query<{ record: CandidateRecord }>(
        `select distinct on (candidate_id) record from codebase_debt_candidate_events
         where team_id=$1 and producer_name=$2 and producer_run_id=$3 and candidate_id=any($4::text[])
         order by candidate_id, sequence desc`, [...params, [...incomingLatest.keys()]],
      );
      // This is deliberately run-scoped, not globalLatestByCandidate (late summaries stay historical).
      const runLatestByCandidate = new Map(priorRun.rows.map(({ record }) => [record.candidate_id, record]));
      for (const record of incomingLatest.values()) {
        const previous = runLatestByCandidate.get(record.candidate_id);
        if (previous) counts[previous.state] = (counts[previous.state] ?? 0) - 1;
        counts[record.state] = (counts[record.state] ?? 0) + 1;
      }
      validateRunSummary(summaries[0], counts);
    }

    // No domain mutation occurs until the entire stored-plus-incoming union has passed.
    for (const record of newIdentities.values()) await client.query(
      `insert into codebase_debt_candidates(team_id,candidate_id,identity,program_id)
       values($1,$2,$3::jsonb,$4)`,
      [auth.teamId, record.candidate_id, canonicalRecord(record.identity), record.attribution.program_id],
    );
    for (const record of candidates) for (const codebase of record.codebases) await client.query(
      `insert into codebase_debt_candidate_codebases(team_id,candidate_id,codebase_slug)
       values($1,$2,$3) on conflict do nothing`, [auth.teamId, record.candidate_id, codebase],
    );
    for (const record of accepted) await client.query(
      `insert into codebase_debt_candidate_events(team_id,event_id,record,canonical_record)
       values($1,$2,$3::jsonb,$4::text)`, [auth.teamId, record.event_id, canonicalRecord(record), canonicalRecord(record)],
    );
    await auditRequired(client, {
      team_id: auth.teamId, actor_kind: "api_key", member_id: auth.memberId, api_key_id: auth.apiKeyId,
      action: "codebase.debt_intake", target_type: "codebase", target_id: slug,
      meta: { request_count: records.length, accepted_count: accepted.length,
        duplicate_count: duplicateIds.length, result: accepted.length ? "accepted" : "replay" },
    });
    return { status: accepted.length ? 201 : 200, accepted_event_ids: accepted.map((record) => record.event_id), duplicate_event_ids: duplicateIds };
  });
}
