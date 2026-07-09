import "server-only";
import type { DbClient } from "@/lib/db/types";
import { sendOpsAlert, mailerConfigured } from "@/lib/auth/mailer";

/**
 * Email admins when the dense (semantic) retrieval leg TRANSITIONS to/from degraded — Phase 1b of the
 * retrieval-observability plan. Debounced by design: it only fires on the edge (last dense run's
 * outcome flipped), so a sustained embeddings outage sends ONE alert, not one per scheduler tick.
 *
 * Dense indexing is instance-wide (a shared embeddings provider), so the alert goes to every active
 * admin. Best-effort throughout — a mail failure must never affect the ingest tick.
 */

/** Was the most recent recorded dense run a failure? (false when there are none.) */
export async function lastDenseRunFailed(db: DbClient): Promise<boolean> {
  const { data } = await db
    .from("ingest_runs")
    .select("ok")
    .eq("source", "dense")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return !!data && (data as { ok: boolean }).ok === false;
}

async function activeAdminEmails(db: DbClient): Promise<string[]> {
  const { data } = await db
    .from("members")
    .select("email")
    .eq("role", "admin")
    .eq("status", "active");
  const emails = (data ?? [])
    .map((m) => (m as { email: string | null }).email)
    .filter((e): e is string => !!e && e.includes("@"));
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

/**
 * Notify admins that semantic search just broke. `priorFailed` is the leg's state BEFORE this tick,
 * captured by the caller so we can detect the edge. No-op unless this is a fresh transition into
 * failure and a mail provider is configured.
 */
export async function alertDenseDegraded(
  db: DbClient,
  priorFailed: boolean,
  detail: { failed: number; scanned: number; errorSample?: string }
): Promise<void> {
  if (priorFailed || !mailerConfigured()) return; // debounce: only on the ok→degraded edge
  try {
    const admins = await activeAdminEmails(db);
    if (admins.length === 0) return;
    const where = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, "")} → Admin → Integrations` : "Admin → Integrations";
    const text =
      `Semantic (vector) search has stopped working: ${detail.failed} of ${detail.scanned} items failed to embed ` +
      `this cycle.\n\nLikely cause: the embeddings provider is down or out of quota (check billing/keys). ` +
      `Keyword search is unaffected, so the brain still answers — but paraphrased questions and large-corpus ` +
      `recall are weaker until this recovers.\n\n` +
      (detail.errorSample ? `Provider error: ${detail.errorSample}\n\n` : "") +
      `See the Retrieval health card at ${where}. You'll get one more email when it recovers.`;
    for (const to of admins) await sendOpsAlert(to, "⚠️ AIOS Team Brain — semantic search degraded", text);
  } catch {
    // best-effort — a mail failure must not affect the ingest tick
  }
}

/** Notify admins that semantic search recovered — the symmetric edge (degraded→ok). */
export async function alertDenseRecovered(db: DbClient, priorFailed: boolean, indexed: number): Promise<void> {
  if (!priorFailed || !mailerConfigured()) return; // only on the degraded→ok edge
  try {
    const admins = await activeAdminEmails(db);
    if (admins.length === 0) return;
    const text = `Semantic (vector) search is working again — the embeddings backlog is indexing (${indexed} items this cycle). No action needed.`;
    for (const to of admins) await sendOpsAlert(to, "✅ AIOS Team Brain — semantic search recovered", text);
  } catch {
    // best-effort
  }
}
