import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { Range } from "./range";
import type { ViewerTier } from "@/lib/codebases/visibility";
import { getCodebaseSummaries } from "./codebases";

/**
 * Team-level Agentic Engineering Maturity rollup, derived from per-repo agent-readiness
 * (AEM codebase scope). Reuses the codebase-summaries choke-point, so it inherits the
 * team-tier gate — an external viewer gets an empty rollup, no leak path. There is no
 * RLS backstop on postgres; the gate in getCodebaseSummaries is the sole enforcement.
 *
 * Headline org metric: % of scored repos at L3+ ("agent-ready" or better).
 */

const LEVEL_ORDER = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type ReadinessLevel = (typeof LEVEL_ORDER)[number];

export interface RepoReadiness {
  slug: string;
  level: ReadinessLevel | null;
  pct: number | null;
}

export interface TeamMaturity {
  reposTotal: number; // repos with any scan
  reposScored: number; // repos with a readiness level
  atL3Plus: number; // count scored at L3 or better
  pctAtL3Plus: number; // headline metric (0 when none scored)
  distribution: Record<ReadinessLevel, number>;
  repos: RepoReadiness[]; // scored repos, worst-first (drives the "what to fix" list)
}

function rank(level: string | null): number {
  const i = level ? LEVEL_ORDER.indexOf(level as ReadinessLevel) : -1;
  return i; // -1 = unscored
}

export async function getTeamMaturity(
  db: DbClient,
  teamId: string,
  range: Range,
  tier: ViewerTier
): Promise<TeamMaturity> {
  const empty: TeamMaturity = {
    reposTotal: 0,
    reposScored: 0,
    atL3Plus: 0,
    pctAtL3Plus: 0,
    distribution: { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 },
    repos: [],
  };

  const { codebases } = await getCodebaseSummaries(db, teamId, range, tier);
  if (!codebases.length) return empty;

  const distribution = { ...empty.distribution };
  const scored: RepoReadiness[] = [];
  for (const cb of codebases) {
    if (cb.readiness_level && LEVEL_ORDER.includes(cb.readiness_level as ReadinessLevel)) {
      distribution[cb.readiness_level as ReadinessLevel]++;
      scored.push({ slug: cb.slug, level: cb.readiness_level as ReadinessLevel, pct: cb.readiness_pct });
    }
  }

  const atL3Plus = scored.filter((r) => rank(r.level) >= LEVEL_ORDER.indexOf("L3")).length;
  scored.sort((a, b) => rank(a.level) - rank(b.level)); // worst-first

  return {
    reposTotal: codebases.length,
    reposScored: scored.length,
    atL3Plus,
    pctAtL3Plus: scored.length ? Math.round((atL3Plus / scored.length) * 100) : 0,
    distribution,
    repos: scored,
  };
}
