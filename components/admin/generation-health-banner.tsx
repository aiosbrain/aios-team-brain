"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LlmHealth } from "@/lib/query/llm-health";

/**
 * LOUD, hard-to-miss banner on Pulse when GENERATION is degraded — the answering model has stopped
 * producing output for one or more features (LLMOBS-1 / AIO-905).
 *
 * WHY IT EXISTS AS ITS OWN BANNER. `llm` used to be a leg on the ingestion banner, whose sentence is
 * "N ingestion legs are broken — the brain isn't getting fresh data". That is false for a model
 * failure: ingestion is fine, generation stopped. It also double-counted every arcs failure, since a
 * failed synthesis writes both a `source='arcs'` row and a `source='llm'` row — literally the "2
 * ingestion legs are broken" of the 2026-08-11 incident. So the leg moved OFF that banner and onto
 * this one, which can tell the truth.
 *
 * WHAT "A SPECIFIC REASON" MEANS HERE, because "generation is degraded" is the vague sentence this
 * replaces: WHICH feature (by operator name, not the `meeting-summary` slug), WHAT the model did
 * (that task's own error — empty output, a timeout, a quota refusal), and WHICH model (per task —
 * arcs runs the reasoning model and everything else the query model, so naming the wrong one sends an
 * admin to the wrong picker). It also says what is still working, because the complaint that started
 * this family was a banner implying total breakage from a partial signal.
 *
 * DEGRADED ONLY, never `unstable`. That is BANNERFLAP-1's rule: a lone failure heals on the next
 * attempt 6 times out of 10 on this install, and this is the loudest surface there is.
 */
export function GenerationHealthBanner({ health, href }: { health: LlmHealth; href: string }) {
  const failing = health.tasks.filter((t) => t.state === "degraded");
  // The dismissal signature mirrors `lib/ingest/pipeline-alert.alertSignature` — task, model AND
  // error, not just the failing set. The first version keyed on task names alone while its comment
  // claimed to mirror that contract, which was a weaker promise than it stated: dismissing an
  // empty-output failure on `arcs` then kept the banner hidden when `arcs` later failed on a DIFFERENT
  // model with a quota error, so the new actionable reason never re-showed. Both reviewers caught the
  // gap between the comment and the code. You can ack the problem you have seen; you cannot blind
  // yourself to a new one.
  const signature = failing
    .map((t) => `${t.task}:${t.model ?? ""}:${(t.lastError ?? "").trim()}`)
    .sort()
    .join("|");
  const storageKey = `generation-alert-dismissed:${href.split("#")[0]}`;
  const [state, setState] = useState<{ hydrated: boolean; dismissed: boolean }>({
    hydrated: false,
    dismissed: false,
  });
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(storageKey) === signature;
    } catch {
      /* localStorage unavailable (private mode) → treat as not dismissed, still show the alert */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration read of a client-only store
    setState({ hydrated: true, dismissed });
  }, [storageKey, signature]);

  // `state` is the worst across tasks, so `degraded` implies a non-empty `failing` — but both are
  // checked because the banner must never render an empty accusation.
  if (health.state !== "degraded" || failing.length === 0) return null;
  if (state.hydrated && state.dismissed) return null;

  return (
    <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">
            {failing.length === 1
              ? `${labelOf(failing[0].task)} ${isPlural(failing[0].task) ? "are" : "is"} not being generated`
              : `${failing.length} features are not being generated`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1 pl-4">
            {failing.map((t) => (
              <li key={t.task} className="list-disc text-xs">
                <span className="font-medium">{labelOf(t.task)}</span>
                {t.model ? <span className="text-red-600/80 dark:text-red-300/80"> · {t.model}</span> : null}
                {/* LLMCREDIT-4: THE DIAGNOSIS LEADS HERE TOO. LLMCREDIT-3 gave the summary paragraph
                    below its plain-English reading but left THIS bullet rendering the provider's raw
                    JSON — and the bullet is the most prominent red text on the page, so the operator
                    still met four hundred characters of `{"error":{"message":…` first. `diagnosis` is
                    computed SERVER-side (see LlmTaskHealth) because this is a client component and
                    the classifier reaches a `server-only` module. Null when unrecognised, and then
                    this is exactly the old rendering. */}
                {t.diagnosis ? (
                  <>
                    <span className="text-red-700 dark:text-red-200">
                      {" "}
                      — {t.diagnosis.headline} {t.diagnosis.action}
                    </span>
                    {t.lastError ? (
                      <span className="mt-0.5 block text-[11px] text-red-600/60 dark:text-red-300/60">
                        {t.lastError.length > 160 ? `${t.lastError.slice(0, 160)}…` : t.lastError}
                      </span>
                    ) : null}
                  </>
                ) : t.lastError ? (
                  <span className="text-red-600/80 dark:text-red-300/80"> — {t.lastError}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {health.note ? <p className="mt-2 text-xs">{health.note}</p> : null}
          <Link href={href} className="mt-2 inline-block text-xs font-medium underline">
            Check the answering model →
          </Link>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 rounded px-2 text-lg leading-none text-red-700/60 hover:text-red-700 dark:text-red-300/60 dark:hover:text-red-300"
          onClick={() => {
            try {
              window.localStorage.setItem(storageKey, signature);
            } catch {
              /* ignore — dismissal is a convenience, not state we depend on */
            }
            setState({ hydrated: true, dismissed: true });
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * Operator copy for a task slug. Duplicated deliberately from `lib/query/llm-health.taskLabel`: that
 * module is `server-only`, and importing it here would drag a server module into a client component.
 * `test/generation-health-banner.test.ts` pins the two in sync so the duplication cannot drift.
 */
const LABELS = new Map<string, string>([
  ["arcs", "Learning arcs"],
  ["arc-coherence", "Learning arc coherence"],
  ["meeting-summary", "meeting summaries"],
  ["meeting-actions", "meeting action items"],
  ["meeting-merge", "meeting transcript merging"],
  ["attribution", "attribution corrections"],
  ["timeline-summary", "timeline summaries"],
  ["doc-task-infer", "task suggestions"],
]);

/**
 * A `Map`, not an object literal — static analysis flagged the object form as a generic
 * object-injection sink and it is right: `task` reaches here from `meta->>'task'`, a database column,
 * so an object lookup walks the prototype chain. `LABELS["constructor"]` would return a FUNCTION,
 * which React then tries to render as a child. Not an XSS (React escapes text), but a crash or garbage
 * on the admin's home page from a row nobody validated. A `Map` has no such chain, and the fallback
 * below is what an unknown slug is supposed to get anyway.
 */
function labelOf(task: string): string {
  return LABELS.get(task) ?? `a background task (${task})`;
}

/** Copy nicety: "meeting summaries ARE not being generated" vs "attribution IS". */
function isPlural(task: string): boolean {
  return labelOf(task).endsWith("s");
}
