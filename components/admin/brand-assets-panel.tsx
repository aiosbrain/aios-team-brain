"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Image as ImageIcon, BookOpen, Plus, X } from "lucide-react";
import { addAsset, removeAsset } from "@/app/t/[team]/admin/brand/actions";
import type { BrandAssetRow } from "@/lib/brand/assets";

type Kind = "url" | "asset" | "reference";

const KIND_META: Record<Kind, { label: string; icon: typeof Link2; hint: string }> = {
  url: { label: "URL", icon: Link2, hint: "a website or link to reference" },
  asset: { label: "Asset", icon: ImageIcon, hint: "a logo/image asset link" },
  reference: { label: "Reference", icon: BookOpen, hint: "an example to emulate (URL optional)" },
};

export function BrandAssetsPanel({ teamSlug, assets }: { teamSlug: string; assets: BrandAssetRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>("url");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await addAsset(teamSlug, { kind, label: label.trim(), url: url.trim(), notes: notes.trim() });
      if (!res.ok) return setError(res.error ?? "could not add asset");
      setLabel("");
      setUrl("");
      setNotes("");
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await removeAsset(teamSlug, id);
      if (!res.ok) return setError(res.error ?? "could not remove asset");
      router.refresh();
    });
  }

  return (
    <div className="prism-card flex flex-col gap-3 p-4">
      <div>
        <p className="text-sm font-medium text-ink">Brand assets</p>
        <p className="text-xs text-ink-tertiary">
          Reference material the Social Brain layers into generation — your site, logos, and examples
          to emulate.
        </p>
      </div>

      {assets.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border-subtle/60">
          {assets.map((a) => {
            const Icon = KIND_META[a.kind].icon;
            return (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <Icon className="size-4 shrink-0 text-violet" />
                <span className="font-medium text-ink">{a.label}</span>
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="truncate text-xs text-violet hover:underline">
                    {a.url}
                  </a>
                ) : null}
                {a.notes ? <span className="truncate text-xs text-ink-tertiary">— {a.notes}</span> : null}
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  disabled={pending}
                  className="ml-auto text-ink-tertiary hover:text-red"
                  aria-label="Remove asset"
                >
                  <X className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-ink-tertiary">No assets yet.</p>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex flex-col gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:items-end"
      >
        <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
          Kind
          <select className="prism-input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_META) as Kind[]).map((k) => (
              <option key={k} value={k}>{KIND_META[k].label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-tertiary">
          Label
          <input className="prism-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Marketing site" />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-tertiary">
          URL {kind === "reference" ? "(optional)" : ""}
          <input className="prism-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <button type="submit" disabled={pending || !label.trim()} className="btn-prism justify-center">
          <Plus className="size-4" /> Add
        </button>
      </form>
      {error ? <p className="text-sm text-red">{error}</p> : null}
    </div>
  );
}
