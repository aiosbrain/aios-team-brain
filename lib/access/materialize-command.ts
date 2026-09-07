import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { PRET4_MATERIALIZE_MARKER, materializeBuiltinMembershipOnce } from "@/lib/access/groups";
import { readStagingMarker } from "@/lib/env/staging-marker";

/**
 * STAGINGMARK-1 — the operator entry point for PRET-4's one-time builtin materialization.
 * Spec: docs/design/stagingmark1-materialize-oneshot.md.
 *
 * WHY THIS EXISTS. STAGINGMARK-1 provided attended recovery for the markerless fleet
 * observed on staging 2026-09-05 (deploy 2e67246e). STAGINGMARK-2 now reconciles such
 * fleets during PRET-6 preDeploy through the frozen SQL function in schema.sql.
 * The TypeScript materializer remains callable from boot, scheduler and this command;
 * both historical writers stamp only after reconciliation. This command remains useful
 * for an operator inspecting a fleet or recovering an older release.
 *
 * WHY THE BEHAVIOUR LIVES HERE AND NOT IN `scripts/admin.ts`. That file USED TO call `main()` at
 * module scope, so a test importing it executed the CLI — the same reason `formatAccessHealth` was
 * extracted. Since STAGINGMARK-4 the entry is argv-guarded and `main(argv)` is importable, so that
 * particular reason is gone; the seam stays here because the SECOND reason is the load-bearing one.
 * Dependencies are INJECTED rather than imported by the handler so the real decisions
 * (which branch runs, what exits non-zero, whether --confirm gates the write) are observable
 * against fakes in the unit tier. A source-text guard cannot do that: a `case` whose body is only
 * a comment naming the function would satisfy it while doing nothing.
 */

export type FleetState = {
  /** the PRET-4 marker — present means the fleet is already materialized */
  marker: boolean;
  teams: number;
  /** `staging_marker` is the repo's purpose-built staging/production discriminator. It is
   *  deliberately absent from schema.sql and every migration, so a `--clean` restore cannot carry
   *  it to production. Measured 2026-09-05: `t` on staging, `f` on prod. Team identity does NOT
   *  discriminate — staging is a restore of prod and holds the SAME team row. */
  stagingMarker: boolean;
  /** STAGINGMARK-2: the fleet has content but nothing partitioned. The SQL function refuses this
   *  shape, because repairing membership is not repairing VISIBILITY — enforcement fails closed for
   *  an item with no context unit and the only UNATTENDED partitioner is budgeted. This command must refuse it
   *  too: it stamps the SAME marker, and the SQL gate sits AFTER the marker short-circuit, so a
   *  stamp here would silently clear the migration's refusal and the next deploy would proceed over
   *  a dark corpus. The diff review found exactly that hole in the first version of this fold. */
  contentWithoutSubstrate: boolean;
};

export type MaterializeResult = { ok: boolean; ran?: boolean; error?: string };

export type MaterializeDeps = {
  readState: () => Promise<FleetState>;
  materialize: () => Promise<MaterializeResult>;
};

export type MaterializeOpts = { confirm: boolean; confirmProduction: boolean };

export type MaterializeOutcome = { lines: string[]; exitCode: number };

export type ConfirmParse =
  | { ok: true; confirm: boolean; confirmProduction: boolean }
  | { ok: false; error: string };

const CONFIRM_KEYS = ["confirm", "confirm-production"] as const;

/**
 * Strict parsing of the two confirmation flags, at the CLI boundary.
 *
 * `parseArgs` (scripts/admin.ts) assigns the FOLLOWING token as a string, so `--confirm false`
 * yields the string "false" — truthy as confirmation. The shared argv boundary now blocks that trap
 * on `purge-items` too. As defense in depth, this command still refuses any
 * value form instead of guessing which way the operator meant it.
 *
 * `--confirm=false` is a DIFFERENT shape: parseArgs makes the whole token the key, so the flag
 * would simply go unseen and the command would dry-run (fail-closed, but silently ignoring what the
 * operator typed). It is refused explicitly so the mistake is reported rather than absorbed.
 *
 * A repeated `--confirm --confirm` is NOT detectable here and is not treated as an error: parseArgs
 * collapses both to the same `true`, so the two spellings are indistinguishable by construction and
 * mean the same thing.
 */
export function parseConfirmFlags(flags: Record<string, string | boolean>): ConfirmParse {
  for (const key of Object.keys(flags)) {
    const equalsForm = /^(confirm|confirm-production)=/.exec(key);
    if (equalsForm) {
      return { ok: false, error: `--${key} uses '='; pass the flag bare: --${equalsForm[1]}` };
    }
  }
  for (const key of CONFIRM_KEYS) {
    const value = flags[key];
    if (value === undefined) continue;
    if (value !== true) {
      return { ok: false, error: `--${key} takes no value (got '${String(value)}'); pass the flag bare: --${key}` };
    }
  }
  return {
    ok: true,
    confirm: flags.confirm === true,
    confirmProduction: flags["confirm-production"] === true,
  };
}

/**
 * The real dependencies. `readState` is read-only by construction — three reads, no write — and
 * `materialize` is the SHIPPED function, passed in rather than reached for, so the manual path and
 * the boot path cannot drift apart.
 */
export function makeMaterializeDeps(db: DbClient): MaterializeDeps {
  return {
    readState: async () => {
      const marker = await runSql<{ present: boolean }>(
        "select exists (select 1 from migration_markers where name = $1) as present",
        [PRET4_MATERIALIZE_MARKER]
      );
      const teams = await runSql<{ n: string }>("select count(*)::text as n from teams", []);
      // STGENV-3: the marker query has ONE owner under `lib/` (`lib/env/staging-marker.ts`). It used
      // to be spelled out here too, and a second copy of a discriminator is a second answer that can
      // drift — the graph projector's refusal and this command's production check must never disagree
      // about which database they are on.
      const stagingMarker = await readStagingMarker();
      // The SAME predicate the SQL function uses, deliberately worded identically. (STAGINGMARK-2.)
      const substrate = await runSql<{ bad: boolean }>(
        "select exists (select 1 from items) and not exists (select 1 from project_context_memberships) as bad",
        []
      );
      return {
        marker: marker.rows[0]?.present === true,
        teams: Number(teams.rows[0]?.n ?? "0"),
        stagingMarker,
        contentWithoutSubstrate: substrate.rows[0]?.bad === true,
      };
    },
    materialize: () => materializeBuiltinMembershipOnce(db),
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const fleetLine = (state: FleetState): string =>
  state.stagingMarker
    ? "fleet: this database carries `staging_marker` — a STAGING database."
    : "fleet: this database does NOT carry `staging_marker` — it may be PRODUCTION.";

/**
 * WORDING DISCIPLINE, from the second diff review. Two claims this must NOT make:
 *   • a failure cannot say "the marker is NOT stamped" — it is never re-read, and a concurrent boot
 *     or tick may have stamped it after our read. It says what this RUN did instead.
 *   • success cannot report `state.teams` as the number reconciled — that count came from the
 *     pre-write read, and the materializer re-reads teams itself (lib/access/groups.ts:213), so a
 *     team created in between is reconciled but uncounted. The count is labelled as of the check.
 *
 * Every reachable outcome has a contract. The ones that are easy to omit, and were: a failing
 * `readState`; a `materialize` that THROWS rather than returning `{ok:false}` (boot and tick both
 * anticipate that); the race where boot/tick stamps the marker between our read and our call, so
 * the materializer re-reads and returns `ran:false` — reporting that as "it ran" would be a lie;
 * and a zero-team fleet, where the marker is stamped but nothing was reconciled.
 */
export async function runMaterializeCommand(
  deps: MaterializeDeps,
  opts: MaterializeOpts
): Promise<MaterializeOutcome> {
  let state: FleetState;
  try {
    state = await deps.readState();
  } catch (err) {
    return { lines: [`✗ could not read the fleet state: ${errText(err)}`], exitCode: 1 };
  }

  const fleet = fleetLine(state);

  if (state.marker) {
    return {
      lines: [fleet, `✓ already materialized — '${PRET4_MATERIALIZE_MARKER}' is present. Nothing to do.`],
      exitCode: 0,
    };
  }

  // Refuse the shape the migration refuses, and refuse it BEFORE --confirm is considered: this is
  // not a confirmation question. Stamping here would clear the migration's gate for the next deploy.
  if (state.contentWithoutSubstrate) {
    return {
      lines: [
        fleet,
        "✗ refusing: this fleet has content but no context substrate.",
        "  Materializing it would stamp the marker and silently clear the PRET-6 refusal, letting the",
        "  next deploy proceed over a corpus nothing can see — enforcement fails closed for an item",
        "  with no context unit, and the only UNATTENDED partitioner is the budgeted scheduler stage.",
        "  Upgrade through the prior release so the corpus is partitioned (docs/RELEASING.md §3.4).",
      ],
      exitCode: 1,
    };
  }

  if (!opts.confirm) {
    const extra = state.stagingMarker ? "--confirm" : "--confirm --confirm-production";
    return {
      lines: [
        fleet,
        `'${PRET4_MATERIALIZE_MARKER}' is ABSENT. Since STAGINGMARK-2 the PRET-6 migration repairs`,
        "this shape itself at preDeploy; running it here is the attended equivalent.",
        `${state.teams} team(s) would have their builtin group membership reconciled.`,
        `DRY RUN — nothing written. Re-run with ${extra} to materialize.`,
      ],
      exitCode: 0,
    };
  }

  if (!state.stagingMarker && !opts.confirmProduction) {
    return {
      lines: [
        fleet,
        "✗ refusing: this may be production and it would rewrite builtin group membership fleet-wide.",
        "  If that is genuinely what you intend, pass --confirm-production as well.",
      ],
      exitCode: 1,
    };
  }

  let result: MaterializeResult;
  try {
    result = await deps.materialize();
  } catch (err) {
    return { lines: [fleet, `✗ materialization threw: ${errText(err)} — this run did not stamp the marker.`], exitCode: 1 };
  }

  if (!result.ok) {
    return {
      lines: [fleet, `✗ materialization failed: ${result.error ?? "unknown error"} — this run did not stamp the marker.`],
      exitCode: 1,
    };
  }
  if (!result.ran) {
    return {
      lines: [fleet, "✓ already completed concurrently — a boot or scheduler tick stamped the marker first."],
      exitCode: 0,
    };
  }
  if (state.teams === 0) {
    return { lines: [fleet, "✓ marker stamped; zero teams reconciled."], exitCode: 0 };
  }
  return {
    lines: [fleet, `✓ materialization ran and the marker is stamped (${state.teams} team(s) at the time of the check).`],
    exitCode: 0,
  };
}
