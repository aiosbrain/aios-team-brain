import { AlertTriangle, Radio } from "lucide-react";
import type { AttributionHealth, SourceAttribution } from "@/lib/attribution/health";
import { MemberDrilldown } from "@/components/admin/member-drilldown";

/**
 * Admin → Attribution. Renders the attribution-health read (per-source + per-person) so misattribution
 * is visible at a glance: which data streams land on a real human vs a connector/nobody, and what each
 * person actually "owns". Presentational — data comes from `lib/attribution/health.getAttributionHealth`
 * (admin-gated by the admin layout). See docs/design/attribution-architecture.md.
 */

function pctTone(s: SourceAttribution): string {
  if (s.isSignal) return "text-ink-tertiary";
  if (s.pctHuman >= 90) return "text-emerald";
  if (s.pctHuman >= 50) return "text-amber";
  return "text-rose";
}

function AttributionBar({ s }: { s: SourceAttribution }) {
  const seg = (n: number) => (s.items > 0 ? `${(100 * n) / s.items}%` : "0%");
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-surface-sunken" title={`${s.human} human · ${s.connector} connector · ${s.unattributed} unattributed`}>
      <div className="bg-emerald" style={{ width: seg(s.human) }} />
      <div className="bg-amber" style={{ width: seg(s.connector) }} />
      <div className="bg-rose/60" style={{ width: seg(s.unattributed) }} />
    </div>
  );
}

export function AttributionHealthView({ health, teamSlug }: { health: AttributionHealth; teamSlug: string }) {
  const { bySource, byMember, lowAttributionSources, divergentItems } = health;
  const unattributedTotal = bySource.reduce((n, s) => n + s.unattributed, 0);
  // The null bucket's per-source chips = each source's unattributed count (so it's filterable too).
  const unattributedChips = bySource
    .filter((s) => s.unattributed > 0)
    .map((s) => ({ source: s.source, isSignal: s.isSignal, items: s.unattributed }));

  if (bySource.length === 0) {
    return <p className="text-sm text-ink-secondary">No ingested content yet — attribution health will appear once items are synced.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-secondary">
        Who each data stream is attributed to. <span className="text-emerald">Green</span> = a real person,{" "}
        <span className="text-amber">amber</span> = a connector service-account, <span className="text-rose">red</span> = nobody.
        Meeting/calendar streams are <span className="inline-flex items-center gap-0.5"><Radio className="size-3" />signal</span> — evidence about who is doing what, not one person&apos;s output.
      </p>

      {divergentItems > 0 && (
        <p className="text-xs text-ink-tertiary">
          {divergentItems} item{divergentItems === 1 ? "" : "s"} credited to a different (or additional) person than their current owner —
          reassignments &amp; co-authored work. The Timeline and arcs show the <em>credit</em>; this page lets you correct the <em>owner</em>.
        </p>
      )}

      {lowAttributionSources.length > 0 && (
        <div className="prism-card flex items-start gap-3 border-amber/40 px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" strokeWidth={2} />
          <div className="text-sm text-ink">
            <span className="font-medium">{lowAttributionSources.length} stream{lowAttributionSources.length > 1 ? "s" : ""} mostly cannot be attributed to a person:</span>{" "}
            {lowAttributionSources.map((s) => `${s.source} (${s.pctHuman}%)`).join(", ")}. These need an author mapping or a source normalizer.
          </div>
        </div>
      )}

      {/* Per-source */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">By source</h2>
        <div className="prism-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Items</th>
                <th className="px-4 py-2 text-right font-medium">Human</th>
                <th className="px-4 py-2 text-right font-medium">Connector</th>
                <th className="px-4 py-2 text-right font-medium">None</th>
                <th className="px-4 py-2 font-medium">Attribution</th>
              </tr>
            </thead>
            <tbody>
              {bySource.map((s) => (
                <tr key={s.source} className="border-b border-border-subtle/50 last:border-0">
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 text-ink">
                      {s.source}
                      {s.isSignal && <Radio className="size-3 text-ink-tertiary" aria-label="signal source" />}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">{s.items}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">{s.human}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">{s.connector || "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">{s.unattributed || "—"}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <AttributionBar s={s} />
                      <span className={`tabular-nums text-xs ${pctTone(s)}`}>{s.isSignal ? "signal" : `${s.pctHuman}%`}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-person — expand a row to the actual items (each linkable), filter by source chip, correct inline. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">By person</h2>
        <p className="mb-3 text-xs text-ink-tertiary">What each member owns, by source — a person carrying the wrong kind of work (e.g. many meeting transcripts) is a misattribution clue. Expand a row to see the actual items, or click a source to filter.</p>
        <MemberDrilldown teamSlug={teamSlug} members={byMember} unattributedTotal={unattributedTotal} unattributedChips={unattributedChips} />
      </section>
    </div>
  );
}
