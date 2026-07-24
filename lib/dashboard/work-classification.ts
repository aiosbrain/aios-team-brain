import { isSignalSource } from "@/lib/attribution/health";
import { normalizeSource } from "./timeline-group";

/**
 * WORK vs SIGNAL — the one distinction the daily rollup is built around (docs/design/rollup-work-vs-signal).
 *
 *  • WORK   — a person's real OUTPUT (code, docs, a design) — counted in their day, credited, drives order.
 *  • SIGNAL — data ABOUT work (a decision, a meeting/transcript) — shown as context, NEVER counted as work.
 *
 * Lifts `lib/attribution/health.isSignalSource` (meetings/calendar) to be `item_kind`-aware, so the rollup
 * and attribution bucket identically. Source-FIRST with an explicit Slack carve-out: Slack threads are
 * stored `kind:"transcript"` but are per-person WORK (the timeline's per-participant lane), so a bare/meeting
 * transcript is signal while a Slack thread is not. A future/unknown `item_kind` defaults to WORK.
 *
 * Used by the server builder (and unit tests); NOT by the client grouper — imports server-only `health`.
 */
export type WorkClass = "work" | "signal";

export function classifyWork(kind: string | null | undefined, source: string | null | undefined): WorkClass {
  const k = (kind ?? "").trim().toLowerCase();
  if (k === "decision") return "signal";
  if (isSignalSource(source ?? "")) return "signal"; // granola / calendar / zoom / …
  if (k === "transcript" && normalizeSource(source) !== "slack") return "signal"; // a meeting transcript, NOT a Slack thread
  return "work"; // deliverable / artifact / skill / blueprint + code/doc sources + Slack threads
}
