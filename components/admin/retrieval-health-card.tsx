import type { RetrievalHealth, DenseState, LegState } from "@/lib/query/retrieval-health";
import { timeAgo } from "@/components/format";

/**
 * Admin → Integrations "Retrieval health" card. Surfaces the per-leg state of the context stack so a
 * silently-degraded semantic index (the OpenAI-quota failure mode) is visible instead of invisible.
 * Keyword FTS is always on; dense/graph/rerank are optional + externally dependent.
 */

const DOT: Record<DenseState | LegState, string> = {
  healthy: "bg-emerald-500",
  on: "bg-emerald-500",
  building: "bg-amber-500",
  degraded: "bg-red-500",
  off: "bg-ink-tertiary/40",
};

const LABEL: Record<DenseState | LegState, string> = {
  healthy: "healthy",
  on: "on",
  building: "building",
  degraded: "degraded",
  off: "off",
};

function Leg({ name, state, detail }: { name: string; state: DenseState | LegState; detail?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className={`size-2 shrink-0 rounded-full ${DOT[state]}`} />
      <span className="w-24 shrink-0 text-sm text-ink">{name}</span>
      <span className={`text-xs font-medium ${state === "degraded" ? "text-red-600" : state === "building" ? "text-amber-600" : "text-ink-secondary"}`}>
        {LABEL[state]}
      </span>
      {detail ? <span className="text-xs text-ink-tertiary">· {detail}</span> : null}
    </div>
  );
}

export function RetrievalHealthCard({ health }: { health: RetrievalHealth }) {
  const d = health.dense;
  const denseDetail =
    d.state === "off"
      ? undefined
      : `${d.coveragePct}% embedded (${d.embeddedItems}/${d.embeddableItems})${d.pendingItems ? `, ${d.pendingItems} pending` : ""}${d.lastEmbeddedAt ? `, last ${timeAgo(d.lastEmbeddedAt)}` : ""}`;
  // Reachable but no projection in > 6h ⇒ the projector has stalled even though /healthcheck answers
  // (the 2026-07 failure: writes 422'd for days while the service stayed "up"). The server flags this
  // (`graphStalled`) so the banner tells the admin which failure it actually is.
  const graphStalled = health.graphStalled;
  // Reachable + writing episodes, but the extractor turns none of them into facts (Graphiti's
  // entity-extraction worker is failing on every job). A distinct, more specific cause than a stalled
  // projector, so it gets its own detail + banner and takes priority.
  const graphExtractionStalled = health.graphExtractionStalled;
  const graphFreshness =
    health.graphEpisodes != null
      ? `${health.graphEpisodes} episodes${health.graphLastProjectedAt ? ` · last projected ${timeAgo(health.graphLastProjectedAt)}` : " · none projected yet"}`
      : undefined;
  const graphDetail =
    health.graph === "off"
      ? "not configured"
      : graphExtractionStalled
        ? `accepting episodes but extracting 0 facts — ${graphFreshness}`
        : graphStalled
          ? `projector stalled — ${graphFreshness}`
          : health.graph === "degraded"
            ? "configured but unreachable"
            : graphFreshness;
  // A configured-but-unreachable OR stalled-projector graph is a real failure — flag it loudly (red),
  // like a degraded semantic leg.
  const graphDegraded = health.graph === "degraded";
  const worst = d.state === "degraded" || health.graph === "off";

  // Answering-model leg: map the LLM health state onto the shared leg vocabulary (unknown → the grey
  // "off" dot, since nothing's been recorded yet). This is the leg that was missing when a reasoning
  // model silently blanked Learning.
  const llm = health.llm;
  const llmLeg: DenseState | LegState =
    llm.state === "healthy" ? "healthy" : llm.state === "degraded" ? "degraded" : "off";
  const llmDetail =
    llm.state === "healthy"
      ? `${llm.lastModel ?? "model"}${llm.lastOkAt ? ` · last ok ${timeAgo(llm.lastOkAt)}` : ""}`
      : llm.state === "degraded"
        ? `${llm.lastModel ?? "model"} returned no output${llm.lastFailedAt ? ` · ${timeAgo(llm.lastFailedAt)}` : ""}`
        : "no recent activity recorded";

  return (
    <div className="prism-card flex flex-col gap-1 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Retrieval health</h2>
        <span className="text-xs text-ink-tertiary">how the brain answers questions</span>
      </div>
      <p className="mb-1 text-xs text-ink-secondary">
        The context stack behind every query. Keyword search always works; the others are optional and
        depend on external services, so a quiet failure is flagged here.
      </p>

      <Leg name="Answering model" state={llmLeg} detail={llmDetail} />
      <Leg name="Keyword" state="on" detail="always on (local Postgres FTS)" />
      <Leg name="Semantic" state={d.state} detail={denseDetail} />
      <Leg name="Graph memory" state={health.graph} detail={graphDetail} />
      <Leg name="Reranker" state={health.rerank} detail={health.rerank === "off" ? "not configured" : undefined} />
      <Leg
        name="Augment"
        state={health.augment}
        detail={health.augment === "off" ? "no external augment service" : undefined}
      />

      {llm.state === "degraded" && llm.note ? (
        <p className="mt-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {llm.note}
        </p>
      ) : null}
      {graphDegraded ? (
        <p className="mt-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {graphExtractionStalled ? (
            <>
              Graph memory is reachable and <strong>accepting episodes, but its extractor is producing no
              facts</strong> ({health.graphEpisodes} projected · {health.graphFacts ?? 0} facts). Graphiti
              returns <code>202</code> then fails entity extraction on every job — commonly the LLM
              output-token cap (<code>Output length exceeded max tokens</code>). New activity isn&apos;t
              becoming graph facts, so narrative arcs can&apos;t update. Check the Graphiti service logs.
              Keyword and semantic search are unaffected.
            </>
          ) : graphStalled ? (
            <>
              Graph memory is reachable but the <strong>projector has stalled</strong> — no new episodes
              since {timeAgo(health.graphLastProjectedAt!)}. New activity isn&apos;t reaching the graph
              (writes may be failing — check the logs for a Graphiti <code>422</code>). Existing memory
              still answers; keyword and semantic search are unaffected.
            </>
          ) : (
            <>
              Graph memory is configured but not responding — <code>GRAPHITI_URL</code> is set, but its
              <code> /healthcheck</code> failed (service down or unreachable). Keyword and semantic search
              are unaffected; check the Graphiti service.
            </>
          )}
        </p>
      ) : null}
      {d.note ? (
        <p
          className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
            d.state === "degraded"
              ? "border-red-400/30 bg-red-400/10 text-red-600 dark:text-red-300"
              : "border-border-subtle bg-white/[0.02] text-ink-tertiary"
          }`}
        >
          {d.note}
        </p>
      ) : null}
      {worst && !d.note ? (
        <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          Some retrieval legs are off — answers rely on keyword search alone. That&apos;s fine at small
          scale but weaker for paraphrased questions across a large corpus.
        </p>
      ) : null}
      {!health.emailDeliverable ? (
        <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          No email provider is configured (<code>RESEND_API_KEY</code> / <code>SMTP_URL</code>) — member
          invites and the degraded-stack ops alerts above can&apos;t be delivered, so a problem here
          won&apos;t reach anyone by email. Password login still works.
        </p>
      ) : null}
    </div>
  );
}
