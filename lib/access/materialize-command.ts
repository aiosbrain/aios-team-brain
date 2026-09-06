import "server-only";
import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { PRET4_MATERIALIZE_MARKER, materializeBuiltinMembershipOnce } from "@/lib/access/groups";

/**
 * STAGINGMARK-1 — the operator entry point for PRET-4's one-time builtin materialization.
 * Spec: docs/design/stagingmark1-materialize-oneshot.md.
 *
 * WHY THIS EXISTS. The PRET-6 preDeploy guard refuses a fleet that has teams but no
 * `pret4_builtin_materialize` marker, and that marker has exactly ONE writer
 * (`materializeBuiltinMembershipOnce`) reachable from exactly TWO call sites — boot
 * (`instrumentation.ts`) and the scheduler tick — both of which are downstream of a deploy that
 * SUCCEEDED. A fleet in that state therefore cannot get the marker by any amount of redeploying:
 * the guard refuses, the code never boots, the marker is never stamped. Observed on staging
 * 2026-09-05 (deploy 2e67246e).
 *
 * WHY THE BEHAVIOUR LIVES HERE AND NOT IN `scripts/admin.ts`. That file calls `main()` at module
 * scope, so a test importing it would execute the CLI — the same reason `formatAccessHealth` was
 * extracted. Dependencies are INJECTED rather than imported by the handler so the real decisions
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
 * yields the string "false" — and `if (!flags.confirm)` reads that as CONFIRMED. That trap is live
 * today on `purge-items`, a destructive command. Rather than inherit it, this command refuses any
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
      const staging = await runSql<{ present: boolean }>(
        "select to_regclass('public.staging_marker') is not null as present",
        []
      );
      return {
        marker: marker.rows[0]?.present === true,
        teams: Number(teams.rows[0]?.n ?? "0"),
        stagingMarker: staging.rows[0]?.present === true,
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

  if (!opts.confirm) {
    const extra = state.stagingMarker ? "--confirm" : "--confirm --confirm-production";
    return {
      lines: [
        fleet,
        `'${PRET4_MATERIALIZE_MARKER}' is ABSENT — this fleet refuses PRET-6 at preDeploy.`,
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
