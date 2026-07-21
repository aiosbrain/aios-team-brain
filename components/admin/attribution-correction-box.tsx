"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wand2, ArrowRight } from "lucide-react";
import {
  previewAttributionCorrectionAction,
  applyAttributionCorrectionAction,
} from "@/app/t/[team]/admin/attribution/actions";
import type { CorrectionPreview } from "@/lib/attribution/correction";

/**
 * Natural-language attribution correction. An admin types a plain-language fix; we preview the exact
 * blast radius (never mutate on parse); the admin confirms; it applies through the audited single-writer.
 */
export function AttributionCorrectionBox({ teamSlug }: { teamSlug: string }) {
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runPreview() {
    setError(null);
    setDone(null);
    setPreview(null);
    startTransition(async () => {
      const res = await previewAttributionCorrectionAction(teamSlug, instruction);
      if (!res.ok) setError(res.error);
      else if (res.preview.error) setError(res.preview.error);
      else setPreview(res.preview);
    });
  }

  function apply() {
    if (!preview) return;
    startTransition(async () => {
      const res = await applyAttributionCorrectionAction(teamSlug, preview.plan, preview.matchedCount);
      if (!res.ok) setError(res.error ?? "failed");
      else {
        setDone(
          `Re-attributed ${res.updated} item${res.updated === 1 ? "" : "s"} to ${res.target}.` +
            (res.capped ? " More still match — run it again to continue." : "")
        );
        setPreview(null);
        setInstruction("");
        router.refresh();
      }
    });
  }

  return (
    <section className="prism-card flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Wand2 className="size-4 text-violet" strokeWidth={2} />
        <h2 className="text-sm font-semibold text-ink">Fix attribution in plain language</h2>
      </div>
      <p className="text-xs text-ink-tertiary">
        e.g. &ldquo;the linear docs are Fatma&rsquo;s&rdquo; · &ldquo;meeting notes aren&rsquo;t anyone&rsquo;s work&rdquo; ·
        &ldquo;attribute everything under github/ to John&rdquo;. You&rsquo;ll see exactly what changes before it applies.
      </p>

      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
        placeholder="Describe the correction…"
        className="w-full resize-none rounded-lg border border-border-default bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-violet focus:outline-none"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={runPreview}
          disabled={pending || !instruction.trim()}
          className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink disabled:opacity-50"
        >
          <Wand2 className={`size-3.5 ${pending && !preview ? "animate-pulse" : ""}`} /> Preview
        </button>
        {done && <span className="text-xs text-emerald">{done}</span>}
        {error && <span className="text-xs text-rose">{error}</span>}
      </div>

      {preview && (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-sunken px-3 py-3">
          <p className="text-sm text-ink">
            Re-attribute <span className="font-semibold tabular-nums">{preview.matchedCount}</span> item
            {preview.matchedCount === 1 ? "" : "s"} <ArrowRight className="inline size-3.5 text-ink-tertiary" />{" "}
            <span className="font-semibold">{preview.target.clear ? "nobody (unattributed)" : preview.target.label}</span>
            {preview.capped && <span className="text-ink-tertiary"> (showing first 5000)</span>}
          </p>
          {preview.samplePaths.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-ink-tertiary">
              {preview.samplePaths.map((p) => (
                <li key={p} className="truncate font-mono">{p}</li>
              ))}
              {preview.matchedCount > preview.samplePaths.length && <li>…and {preview.matchedCount - preview.samplePaths.length} more</li>}
            </ul>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={apply}
              disabled={pending || preview.matchedCount === 0}
              className="rounded-lg bg-violet px-3 py-1.5 text-xs font-medium text-white hover:bg-violet/90 disabled:opacity-50"
            >
              {pending ? "Applying…" : `Apply to ${preview.matchedCount} item${preview.matchedCount === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              disabled={pending}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-tertiary hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
