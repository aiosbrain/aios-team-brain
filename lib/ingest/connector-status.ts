/**
 * connector-status.ts — "did my connector token actually work, and what landed?"
 *
 * A different question from `pipeline-health.ts`, which asks "is the ingestion pipeline healthy"
 * across every leg (dense, graph_project, llm, …) for a banner. This one is scoped to the four
 * credential-bearing connectors a human just pasted a token for, and answers the thing they
 * actually want to know right then: is it configured, did it run, and did anything arrive.
 *
 * Why it exists: after saving a token in Admin → Integrations there is no feedback until the next
 * scheduler tick (≤30 min), and a wrong scope fails inside that tick where nobody is watching. The
 * loop was: paste, wait, guess. This closes it.
 *
 * Pure by construction — rows in, verdicts out, `now` injected. The DB reads and the forced sync
 * live in `scripts/connectors.ts`, so all the judgement here is unit-testable without a database.
 */
import { relativeAge } from "./runs-format";

/** The connectors that carry a credential and are polled by the scheduler. */
export const CONNECTOR_TYPES = ["slack", "github", "linear", "plane"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/**
 * GitHub is the exception: per README §1.4 a PAT is optional there — public repos ingest
 * token-free — so a missing secret is normal, not a misconfiguration. For the other three a
 * missing secret means the connector cannot authenticate at all.
 */
const SECRET_OPTIONAL: ReadonlySet<string> = new Set(["github"]);

export type Verdict = "ok" | "warn" | "fail" | "pending" | "absent";

export interface IntegrationRow {
  type: string;
  name: string;
  status: string; // 'enabled' | 'disabled'
  has_secret: boolean;
}

export interface RunRow {
  source: string;
  ok: boolean;
  created: number;
  updated: number;
  unchanged: number;
  error_count: number;
  errors: unknown;
  finished_at: string | Date;
}

export interface ConnectorStatus {
  type: ConnectorType;
  verdict: Verdict;
  configured: boolean;
  enabled: boolean;
  hasSecret: boolean;
  lastRunAt: Date | null;
  lastRunAge: string | null;
  ok: boolean | null;
  created: number;
  updated: number;
  error: string | null;
  /** One line a human can act on — the whole point of the command. */
  detail: string;
}

/** `errors` is jsonb: an array of strings in practice, but tolerate a JSON-encoded string. */
export function firstError(errors: unknown): string | null {
  const arr = Array.isArray(errors)
    ? errors
    : typeof errors === "string"
      ? (() => {
          try {
            const p: unknown = JSON.parse(errors);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  return typeof arr[0] === "string" ? arr[0] : null;
}

function toMs(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Newest run per source. Input is expected newest-first, but sort defensively. */
export function latestBySource(runs: RunRow[]): Map<string, RunRow> {
  const out = new Map<string, RunRow>();
  for (const r of [...runs].sort((a, b) => toMs(b.finished_at) - toMs(a.finished_at))) {
    if (!out.has(r.source)) out.set(r.source, r);
  }
  return out;
}

/**
 * Judge one connector. The ordering of these branches is the specification:
 * absent → disabled → missing secret → never ran → failed → succeeded.
 */
export function summarizeConnector(
  type: ConnectorType,
  integration: IntegrationRow | undefined,
  run: RunRow | undefined,
  now: number
): ConnectorStatus {
  const base = {
    type,
    configured: Boolean(integration),
    enabled: integration?.status === "enabled",
    hasSecret: Boolean(integration?.has_secret),
    lastRunAt: run ? new Date(toMs(run.finished_at)) : null,
    lastRunAge: run ? relativeAge(toMs(run.finished_at), now) : null,
    ok: run ? run.ok : null,
    created: run?.created ?? 0,
    updated: run?.updated ?? 0,
    error: run ? firstError(run.errors) : null,
  };

  if (!integration) {
    return { ...base, verdict: "absent", detail: "not configured — add it in Admin → Integrations" };
  }
  if (integration.status !== "enabled") {
    return { ...base, verdict: "warn", detail: "disabled — the scheduler will not poll it" };
  }
  if (!integration.has_secret && !SECRET_OPTIONAL.has(type)) {
    return {
      ...base,
      verdict: "fail",
      detail: "no credential stored — saving one requires SECRETS_KEY to be set on the server",
    };
  }
  if (!run) {
    return {
      ...base,
      verdict: "pending",
      detail: "configured but has never run — the scheduler polls every 30 min; `verify` forces it now",
    };
  }
  if (!run.ok) {
    return { ...base, verdict: "fail", detail: base.error ?? "last run failed with no recorded message" };
  }
  const landed = run.created + run.updated;
  return {
    ...base,
    verdict: "ok",
    // relativeAge already carries the suffix ("4m ago", "just now") — don't add another.
    detail:
      landed > 0
        ? `${run.created} created, ${run.updated} updated · ${base.lastRunAge}`
        : `ran ${base.lastRunAge} — nothing new (not a failure)`,
  };
}

export function summarizeConnectors(
  integrations: IntegrationRow[],
  runs: RunRow[],
  now: number = Date.now()
): ConnectorStatus[] {
  const byType = new Map<string, IntegrationRow>();
  // Prefer an enabled row when a team has several of one type — that's the one being polled.
  for (const i of integrations) {
    const prev = byType.get(i.type);
    if (!prev || (prev.status !== "enabled" && i.status === "enabled")) byType.set(i.type, i);
  }
  const latest = latestBySource(runs);
  return CONNECTOR_TYPES.map((t) => summarizeConnector(t, byType.get(t), latest.get(t), now));
}

/** True when something needs a human — drives the CLI's exit code. */
export function hasActionableProblem(statuses: ConnectorStatus[]): boolean {
  return statuses.some((s) => s.verdict === "fail");
}

const ICON: Record<Verdict, string> = { ok: "✓", warn: "!", fail: "✗", pending: "…", absent: "·" };

export function formatConnectorTable(statuses: ConnectorStatus[]): string {
  return statuses
    .map((s) => `${ICON[s.verdict]} ${s.type.padEnd(8)} ${s.detail}`)
    .join("\n");
}
