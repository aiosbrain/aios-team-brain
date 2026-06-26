"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Shield, Plus, Trash2, Pencil } from "lucide-react";
import { savePolicy, togglePolicy, removePolicy, type PolicyForm } from "@/app/t/[team]/admin/policies/actions";

type Effect = "allow" | "deny" | "require_approval";

export interface PolicyRow {
  id: string;
  priority: number;
  description: string;
  subject_role: string | null;
  subject_tier: string | null;
  subject_actor: string | null;
  action: string;
  resource: string;
  effect: Effect;
  enabled: boolean;
}

const EFFECT_STYLE: Record<Effect, string> = {
  allow: "bg-emerald/10 text-emerald-700",
  deny: "bg-red/10 text-red",
  require_approval: "bg-amber/10 text-amber-700",
};

const EMPTY: PolicyForm = { action: "", resource: "*", effect: "allow", priority: 0, description: "", subjectRole: null, subjectTier: null, subjectActor: "", enabled: true };

function subjectLabel(p: PolicyRow): string {
  const parts = [p.subject_role, p.subject_tier, p.subject_actor].filter(Boolean);
  return parts.length ? parts.join(" · ") : "anyone";
}

export function PoliciesManager({ teamSlug, policies }: { teamSlug: string; policies: PolicyRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyForm>(EMPTY);
  const editing = !!form.id;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "something went wrong");
      after?.();
      router.refresh();
    });
  }

  function edit(p: PolicyRow) {
    setForm({
      id: p.id, description: p.description, priority: p.priority,
      subjectRole: (p.subject_role as PolicyForm["subjectRole"]) ?? null,
      subjectTier: (p.subject_tier as PolicyForm["subjectTier"]) ?? null,
      subjectActor: p.subject_actor ?? "", action: p.action, resource: p.resource, effect: p.effect, enabled: p.enabled,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => { e.preventDefault(); run(() => savePolicy(teamSlug, form), () => setForm(EMPTY)); }}
        className="prism-card flex flex-col gap-3 p-4"
      >
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          {editing ? <Pencil className="size-4 text-violet" /> : <Plus className="size-4 text-violet" />}
          {editing ? "Edit policy" : "Add a policy"}
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Subject role
            <select className="prism-input" value={form.subjectRole ?? ""} onChange={(e) => setForm({ ...form, subjectRole: (e.target.value || null) as PolicyForm["subjectRole"] })}>
              <option value="">any</option><option value="admin">admin</option><option value="lead">lead</option><option value="member">member</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Subject tier
            <select className="prism-input" value={form.subjectTier ?? ""} onChange={(e) => setForm({ ...form, subjectTier: (e.target.value || null) as PolicyForm["subjectTier"] })}>
              <option value="">any</option><option value="team">team</option><option value="external">external</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Subject actor
            <input className="prism-input" placeholder="any (actor handle)" value={form.subjectActor ?? ""} onChange={(e) => setForm({ ...form, subjectActor: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Priority
            <input type="number" className="prism-input" value={form.priority ?? 0} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Action (glob)
            <input className="prism-input" placeholder="code.run" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} required />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Resource (glob)
            <input className="prism-input" placeholder="*" value={form.resource ?? "*"} onChange={(e) => setForm({ ...form, resource: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Effect
            <select className="prism-input" value={form.effect} onChange={(e) => setForm({ ...form, effect: e.target.value as Effect })}>
              <option value="allow">allow</option><option value="require_approval">require_approval</option><option value="deny">deny</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-tertiary">Description
            <input className="prism-input" placeholder="why" value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button type="submit" disabled={pending} className="btn-prism justify-center"><Shield className="size-4" /> {editing ? "Save changes" : "Add policy"}</button>
          {editing ? <button type="button" onClick={() => setForm(EMPTY)} className="rounded-lg border border-border-default px-3 py-1.5 text-sm text-ink-secondary">Cancel</button> : null}
          {error ? <p className="text-sm text-red">{error}</p> : null}
        </div>
      </form>

      {policies.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No policies yet — with none, every agent action is denied by default. Add an <code>allow</code> rule to permit something.</p>
      ) : (
        <div className="prism-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <th className="px-3 py-2">Pri</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Resource</th><th className="px-3 py-2">Effect</th><th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} className={`border-b border-border-subtle last:border-0 ${p.enabled ? "" : "opacity-50"}`}>
                  <td className="px-3 py-2 font-mono text-xs text-ink-secondary">{p.priority}</td>
                  <td className="px-3 py-2 text-ink-secondary">{subjectLabel(p)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-ink">{p.action}</td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-secondary">{p.resource}</td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs ${EFFECT_STYLE[p.effect]}`}>{p.effect}</span></td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => run(() => togglePolicy(teamSlug, p.id, !p.enabled))} disabled={pending} className={`rounded-lg border px-2 py-0.5 text-xs ${p.enabled ? "border-violet/40 bg-violet/10 text-violet" : "border-border-default text-ink-tertiary"}`}>{p.enabled ? "On" : "Off"}</button>
                      <button onClick={() => edit(p)} className="rounded-lg border border-border-default p-1 text-ink-secondary hover:text-ink" aria-label="Edit"><Pencil className="size-3.5" /></button>
                      <button onClick={() => { if (window.confirm("Delete this policy?")) run(() => removePolicy(teamSlug, p.id)); }} disabled={pending} className="rounded-lg border border-border-default p-1 text-ink-secondary hover:text-red" aria-label="Delete"><Trash2 className="size-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
