"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { browserClient } from "@/lib/supabase/client";
import { TierBadge } from "@/components/tier-badge";
import { fmtDate, truncate } from "@/components/format";

export type Decision = {
  id: string;
  row_key: string;
  decided_at: string | null;
  title: string;
  rationale: string;
  decided_by: string;
  impact: string;
  tier: number | null;
  audience: "team" | "external";
  still_valid: boolean;
  projects: { slug: string } | null;
};

export function DecisionsTable({
  initialDecisions,
  canToggle,
}: {
  initialDecisions: Decision[];
  canToggle: boolean;
}) {
  const [decisions, setDecisions] = useState(initialDecisions);
  const [text, setText] = useState("");
  const [validOnly, setValidOnly] = useState(false);
  const [audience, setAudience] = useState<"all" | "team" | "external">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return decisions.filter((d) => {
      if (validOnly && !d.still_valid) return false;
      if (audience !== "all" && d.audience !== audience) return false;
      if (
        q &&
        ![d.title, d.rationale, d.decided_by, d.impact, d.row_key]
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [decisions, text, validOnly, audience]);

  const open = decisions.find((d) => d.id === openId) ?? null;

  async function toggleValid(d: Decision) {
    if (!canToggle) return;
    const next = !d.still_valid;
    const previous = decisions;
    setDecisions((ds) => ds.map((x) => (x.id === d.id ? { ...x, still_valid: next } : x)));
    setError("");
    const supabase = browserClient();
    const { error: err } = await supabase
      .from("decisions")
      .update({ still_valid: next, updated_at: new Date().toISOString() })
      .eq("id", d.id);
    if (err) {
      setDecisions(previous);
      setError(`Could not update #${d.row_key}: ${err.message}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter decisions…"
            className="prism-input !pl-9"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={validOnly}
            onChange={(e) => setValidOnly(e.target.checked)}
            className="size-4 accent-violet"
          />
          Still valid only
        </label>
        <select
          value={audience}
          onChange={(e) => setAudience(e.target.value as typeof audience)}
          className="prism-input !w-auto"
        >
          <option value="all">All audiences</option>
          <option value="team">Team</option>
          <option value="external">External</option>
        </select>
      </div>

      {error ? (
        <p className="rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-sm text-red">{error}</p>
      ) : null}

      <div className="prism-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-default text-left text-xs uppercase tracking-wider text-ink-tertiary">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Audience</th>
              <th className="px-4 py-3 font-medium">Valid</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-tertiary">
                  No decisions match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((d) => (
                <tr
                  key={d.id}
                  className="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-violet/4"
                  onClick={() => setOpenId(d.id)}
                >
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-tertiary">{d.row_key}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-ink-secondary">
                    {fmtDate(d.decided_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-ink">
                      {truncate(d.title, 80)}
                      <ChevronRight className="size-3.5 shrink-0 text-ink-tertiary" />
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-secondary">{d.tier ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <TierBadge tier={d.audience} />
                  </td>
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {canToggle ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={d.still_valid}
                        onClick={() => toggleValid(d)}
                        className={`relative h-5 w-9 rounded-full transition-colors ${
                          d.still_valid ? "bg-violet" : "bg-border-strong"
                        }`}
                        title={d.still_valid ? "Mark as superseded" : "Mark as still valid"}
                      >
                        <span
                          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
                            d.still_valid ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    ) : (
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          d.still_valid
                            ? "border-emerald/30 bg-emerald/10 text-emerald-700"
                            : "border-red/25 bg-red/8 text-red"
                        }`}
                      >
                        {d.still_valid ? "valid" : "superseded"}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Detail drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20 backdrop-blur-sm" onClick={() => setOpenId(null)}>
          <aside
            className="flex h-full w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-border-subtle bg-surface-inset px-7 py-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs text-ink-tertiary">
                  {open.row_key} · {fmtDate(open.decided_at)}
                  {open.projects?.slug ? ` · ${open.projects.slug}` : ""}
                </p>
                <h2 className="mt-1 text-xl font-semibold text-ink">{open.title}</h2>
              </div>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded-md p-1.5 text-ink-tertiary hover:bg-surface-overlay hover:text-ink"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <TierBadge tier={open.audience} />
              {open.tier != null ? (
                <span className="inline-flex rounded-full border border-border-default px-2 py-0.5 text-[11px] text-ink-secondary">
                  Type {open.tier}
                </span>
              ) : null}
              {!open.still_valid ? (
                <span className="inline-flex rounded-full border border-red/25 bg-red/8 px-2 py-0.5 text-[11px] font-medium text-red">
                  superseded
                </span>
              ) : null}
            </div>
            <dl className="flex flex-col gap-4 text-sm">
              <div>
                <dt className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                  Rationale
                </dt>
                <dd className="leading-relaxed text-ink-secondary">{open.rationale || "—"}</dd>
              </div>
              <div>
                <dt className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                  Impact
                </dt>
                <dd className="leading-relaxed text-ink-secondary">{open.impact || "—"}</dd>
              </div>
              <div>
                <dt className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
                  Decided by
                </dt>
                <dd className="text-ink-secondary">{open.decided_by || "—"}</dd>
              </div>
            </dl>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
