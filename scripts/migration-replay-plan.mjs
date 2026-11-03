/**
 * migration-replay-plan — the versioned REPLAY-SUPERSESSION contract for shipped migrations.
 *
 * WHY THIS EXISTS
 * `pg-load-schema.mjs` replays every file in `postgres/migrations/` on every deploy, with no
 * applied-tracking table. A migration that drops and re-adds an enumerated CHECK carries the value
 * set as of its own write date, so once a LATER migration widens that set and a live row uses the
 * new value, replaying the EARLIER file re-imposes a CHECK the row violates and the release aborts
 * (the 2026-07-13 `integrations_type_check` incident).
 *
 * The old answer was to edit every earlier migration to the new complete set. That rewrites shipped
 * history: the file a database was upgraded with is no longer the file in the repository. This
 * contract replaces it. A shipped migration is IMMUTABLE — pinned here by its git blob id — and a
 * CHECK definition in it that a later migration has widened is declared OBSOLETE: the effective
 * replay plan omits exactly those statements and nothing else, and the later migration that owns
 * the constraint re-adds it with the complete current set on the same pass.
 *
 * WHAT A SUPERSESSION IS, PRECISELY
 *   · it names one shipped migration, the constraint, the exact obsolete statements, and the later
 *     migration that owns the constraint now;
 *   · the file must still be byte-identical to the shipped blob, and must contain the obsolete
 *     statements exactly once — otherwise the plan THROWS (a deploy aborts rather than replaying SQL
 *     nobody reviewed);
 *   · every other statement in the file replays unchanged. `20260711160000_publishing.sql` is
 *     mixed-purpose: it also adds a column and a table, and those still run;
 *   · the owning migration must sort AFTER the superseded file and itself still (re-)add the
 *     constraint — so no pass ends with the constraint narrower than, or missing relative to, what
 *     the owner defines. (A replay that does not contain the owner at all is a historical set; the
 *     supersession is not in force there — see `effectiveReplayPlan`.)
 *
 * It is NOT "skip this migration", and it is not a general statement filter: an entry can remove
 * only the text it pins.
 *
 * BOTH replay paths consume this module — `pg-load-schema.mjs` (the deploy) and
 * `migrate-from-existing.mjs` (the lane that proves an upgrade equals a from-zero build) — so the
 * plan that is tested is the plan that ships. Pure node, no dependencies: it runs in the pruned
 * production image.
 *
 * ADDING AN ENTRY (see postgres/migrations/README.md): when a new migration widens an enumerated
 * CHECK, add an entry here for every earlier migration that re-adds that constraint, pointing at
 * the new file. Never edit the earlier file. `test/guards/migration-replay-plan.test.ts` and the
 * two enum-CHECK replay guards fail the build if an obsolete definition is left replaying.
 */
import { createHash } from "node:crypto";

/** Bumped when the MEANING of an entry changes (not when entries are added). */
export const REPLAY_PLAN_VERSION = 1;

/** The comment left where an obsolete definition used to replay — greppable in a deploy log dump. */
export const SUPERSESSION_MARKER = "[replay-supersession v1]";

const INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE = [
  "alter table integrations drop constraint if exists integrations_type_check;",
  "alter table integrations add constraint integrations_type_check",
  "  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully','notion','clickup'));",
].join("\n");

const PCM_METHOD_CHECK_PRE_GDRIVE_CLAIM = [
  "alter table project_context_memberships",
  "  drop constraint if exists project_context_memberships_method_check;",
  "alter table project_context_memberships",
  "  add constraint project_context_memberships_method_check",
  "  check (method in ('ingestion_project','explicit_ref','rule','embedding','llm','manual','exclude_shadow_repair'));",
].join("\n");

const INTEGRATIONS_TYPE_OWNER = "20260922090000_integrations_gdrive_type.sql";
const PCM_METHOD_OWNER = "20260922130000_gdrive_audience_claims.sql";

/**
 * @typedef {object} ReplaySupersession
 * @property {string} migration     the shipped, immutable migration file
 * @property {string} gitBlob       its git blob id — the content pin (`git rev-parse <rev>:<path>`)
 * @property {string} constraint    the enumerated CHECK whose definition here is obsolete
 * @property {string} obsoleteSql   the exact statements omitted from replay (must occur exactly once)
 * @property {string} supersededBy  the later migration that owns the constraint
 */

/** @type {readonly ReplaySupersession[]} */
export const REPLAY_SUPERSESSIONS = Object.freeze([
  {
    migration: "20260624120000_ai_provider_integration_types.sql",
    gitBlob: "3ea048a1d704be9e1a498497664140e39b664478",
    constraint: "integrations_type_check",
    obsoleteSql: INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE,
    supersededBy: INTEGRATIONS_TYPE_OWNER,
  },
  {
    migration: "20260710140000_integrations_openrouter_type.sql",
    gitBlob: "9969210286f77337874392f5bfc997b9e6c381ca",
    constraint: "integrations_type_check",
    obsoleteSql: INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE,
    supersededBy: INTEGRATIONS_TYPE_OWNER,
  },
  {
    migration: "20260711160000_publishing.sql",
    gitBlob: "df904104accb01a48688a40b22f1dc6922e054b4",
    constraint: "integrations_type_check",
    obsoleteSql: INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE,
    supersededBy: INTEGRATIONS_TYPE_OWNER,
  },
  {
    migration: "20260725160000_integrations_notion_type.sql",
    gitBlob: "9210c61e92cce6d8e24c90cb7bc9e16624639087",
    constraint: "integrations_type_check",
    obsoleteSql: INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE,
    supersededBy: INTEGRATIONS_TYPE_OWNER,
  },
  {
    migration: "20260817090000_integrations_clickup_type.sql",
    gitBlob: "8a35a8befbd9062c99a63a77b871aa64561bdf21",
    constraint: "integrations_type_check",
    obsoleteSql: INTEGRATIONS_TYPE_CHECK_PRE_GDRIVE,
    supersededBy: INTEGRATIONS_TYPE_OWNER,
  },
  {
    migration: "20260820150000_pcm_method_exclude_shadow_repair.sql",
    gitBlob: "903eb2afd4ccc5470f67d40b5de117c0520d2801",
    constraint: "project_context_memberships_method_check",
    obsoleteSql: PCM_METHOD_CHECK_PRE_GDRIVE_CLAIM,
    supersededBy: PCM_METHOD_OWNER,
  },
].map((entry) => Object.freeze(entry)));

const GDRIVE_LEGACY_SUPPRESSION_UNSCOPED = [
  "insert into gdrive_suppressed_units(unit_id,team_id)",
  "select u.id,u.team_id",
  "  from project_context_units u join items i on i.team_id=u.team_id and i.id=u.source_item_id",
  " where i.frontmatter->>'source'='gdrive'",
  "   and not exists (",
  "     select 1 from gdrive_item_claims c",
  "      where c.team_id=i.team_id and c.item_id=i.id and c.active",
  "   )",
  "on conflict do nothing;",
].join("\n");

/**
 * A DATA STEP superseded on replay — the second kind of supersession, same machinery.
 *
 * A migration may carry a one-time data step whose statement is only correct against the database
 * it was written for. Replayed on every deploy — and on every staging restore, over a database the
 * sanitized export has deliberately thinned — the same statement can be destructive. Such a
 * statement is pinned and omitted exactly like an obsolete CHECK, and a later migration OWNS the
 * step in a form that is safe to replay over populated data.
 *
 * @typedef {object} ReplayStepSupersession
 * @property {string} migration     the migration file carrying the statement (pinned, immutable)
 * @property {string} gitBlob       its git blob id — the content pin
 * @property {string} step          the named data step whose statement here must not replay
 * @property {string} obsoleteSql   the exact statement omitted from replay (must occur exactly once)
 * @property {string} supersededBy  the later migration that owns the step: it must carry the
 *                                  ownership line `-- [replay-step <step>]`
 */

/** The line an owning migration carries to declare that it performs a superseded data step. */
export function replayStepMarker(step) {
  return `[replay-step ${step}]`;
}

/**
 * `gdrive_legacy_context_suppression` (AIO-1167). 20260922130000 selects "every Drive item's unit
 * whose item has no active claim" and deletes it, to fail legacy pre-claim visibility closed. On a
 * paired staging restore the claim tables are excluded from the export (credentials, queues and
 * their FK dependents), so that selection is EVERY copied Drive unit and the replay deleted the
 * claim-authorized memberships of every copied document. The selection is omitted; with nothing
 * selected the rest of that block is inert, and 20260922135000 performs the suppression with a
 * predicate that never reads the claim tables.
 *
 * @type {readonly ReplayStepSupersession[]}
 */
export const REPLAY_STEP_SUPERSESSIONS = Object.freeze([
  {
    migration: "20260922130000_gdrive_audience_claims.sql",
    gitBlob: "f656298ac65ba009de7438b5a0f58769ba8e900e",
    step: "gdrive_legacy_context_suppression",
    obsoleteSql: GDRIVE_LEGACY_SUPPRESSION_UNSCOPED,
    supersededBy: "20260922135000_gdrive_legacy_context_suppression.sql",
  },
].map((entry) => Object.freeze(entry)));

/** Every supersession the current tree's replay is subject to: obsolete CHECKs and data steps. */
export const ALL_REPLAY_SUPERSESSIONS = Object.freeze([...REPLAY_SUPERSESSIONS, ...REPLAY_STEP_SUPERSESSIONS]);

/** What an entry supersedes, by name: its CHECK constraint or its data step. */
export function supersessionSubject(entry) {
  return entry.constraint ?? entry.step;
}

/** The git blob id of a file's content — the same id `git rev-parse <rev>:<path>` prints. */
export function gitBlobId(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** True when `sql` (re-)adds the named constraint. */
function addsConstraint(sql, constraint) {
  return new RegExp(String.raw`add\s+constraint\s+${constraint}\b`, "i").test(sql);
}

/**
 * The SQL a migration actually replays: the shipped file with its obsolete definitions omitted.
 * Fails closed — a pinned file that changed, or obsolete text that is not present exactly once, is
 * an error, never a silent pass-through of the historical statements.
 *
 * @param {string} name
 * @param {string} sql
 * @param {readonly ReplaySupersession[]} [supersessions]
 * @returns {{ sql: string, superseded: ReplaySupersession[] }}
 */
export function effectiveMigrationSql(name, sql, supersessions = ALL_REPLAY_SUPERSESSIONS) {
  const entries = supersessions.filter((entry) => entry.migration === name);
  if (entries.length === 0) return { sql, superseded: [] };

  const actual = gitBlobId(sql);
  let effective = sql;
  for (const entry of entries) {
    const subject = supersessionSubject(entry);
    if (actual !== entry.gitBlob) {
      throw new Error(
        `replay plan: shipped migration ${name} has changed (blob ${actual}, pinned ${entry.gitBlob}). ` +
        `Shipped migrations are immutable — restore the file and widen the constraint in a NEW ` +
        `migration with a supersession entry (postgres/migrations/README.md).`,
      );
    }
    const found = occurrences(effective, entry.obsoleteSql);
    if (found !== 1) {
      throw new Error(
        `replay plan: ${name} must contain the obsolete ${subject} definition exactly once ` +
        `(found ${found}); refusing to replay it unreviewed.`,
      );
    }
    effective = effective.replace(
      entry.obsoleteSql,
      () => `-- ${SUPERSESSION_MARKER} ${subject}: obsolete definition not replayed; owned by ${entry.supersededBy}`,
    );
  }
  return { sql: effective, superseded: entries };
}

/**
 * The effective replay plan for an ordered migration set — what both the deploy loader and the
 * migrate-from-existing lane execute.
 *
 * A supersession is IN FORCE only when its owner is part of the same replay. That is what makes it
 * safe to hand this function any migration set the loader is given:
 *   · the current tree — owners present — gets the full contract: the pinned blob, the exact
 *     omission, and the ordering checks below, all fail-closed;
 *   · a HISTORICAL set that predates an owner (a released tag materialized as that release shipped
 *     it; `scripts/debt-intake-migration-proof.mjs` feeds one through the production loader) is
 *     replayed verbatim for that constraint. Its narrower CHECK is simply the latest definition
 *     that release had, and there is no later one in the set to defer to. No pin is checked for an
 *     entry that is not in force: those files legitimately differ across history.
 * Deleting an owner from the current tree does not slip through this: the earlier files then replay
 * their narrower CHECK exactly as before the contract existed, which the replay guards catch at
 * build time and a populated database refuses at deploy time.
 *
 * @param {readonly {name: string, sql: string}[]} migrations  in apply order
 * @param {readonly ReplaySupersession[]} [supersessions]
 * @returns {{ name: string, sql: string, superseded: ReplaySupersession[] }[]}
 */
export function effectiveReplayPlan(migrations, supersessions = ALL_REPLAY_SUPERSESSIONS) {
  const order = new Map(migrations.map((m, index) => [m.name, index]));
  const inForce = supersessions.filter((entry) => order.has(entry.supersededBy));
  const plan = migrations.map((m) => ({ name: m.name, ...effectiveMigrationSql(m.name, m.sql, inForce) }));
  const byName = new Map(plan.map((step) => [step.name, step]));

  for (const step of plan) {
    for (const entry of step.superseded) {
      const owner = byName.get(entry.supersededBy);
      const subject = supersessionSubject(entry);
      if (order.get(owner.name) <= order.get(step.name)) {
        throw new Error(
          `replay plan: ${entry.supersededBy} must replay AFTER ${entry.migration} to own ${subject}.`,
        );
      }
      if (owner.superseded.some((other) => supersessionSubject(other) === subject)) {
        throw new Error(
          `replay plan: ${entry.supersededBy} is itself superseded for ${subject}; point ` +
          `${entry.migration} at the migration that owns it now.`,
        );
      }
      if (entry.step !== undefined) {
        // A data step has no catalog object to look for, so its owner says so in as many words.
        if (!owner.sql.includes(`-- ${replayStepMarker(entry.step)}`)) {
          throw new Error(
            `replay plan: ${entry.supersededBy} does not declare ownership of ${entry.step} ` +
            `(-- ${replayStepMarker(entry.step)}), so nothing in this replay would perform it after ` +
            `${entry.migration} stops doing so.`,
          );
        }
        continue;
      }
      if (!addsConstraint(owner.sql, entry.constraint)) {
        throw new Error(
          `replay plan: ${entry.supersededBy} does not (re-)add ${entry.constraint}, so nothing in this ` +
          `replay would define it after ${entry.migration} stops doing so.`,
        );
      }
    }
  }
  return plan;
}
