/**
 * Database/auth backend selection — the single source of truth for whether the
 * Team Brain runs on Supabase (managed Postgres + Auth + RLS) or on a plain
 * Postgres database (self-hosted; access control + auth enforced in app code).
 *
 * Set by the deployer via `DB_BACKEND` (server) and mirrored to the browser via
 * `NEXT_PUBLIC_DB_BACKEND` so client components can branch (e.g. the login form).
 * Defaults to "supabase" so existing deployments are unaffected.
 *
 * This module is import-safe from both server and client code — it only reads
 * env vars and contains no secrets or Node-only APIs.
 */

export type DbBackend = "supabase" | "postgres";

function normalize(value: string | undefined): DbBackend {
  const v = (value ?? "").trim().toLowerCase();
  return v === "postgres" || v === "pg" ? "postgres" : "supabase";
}

/** Server-side backend selection. Reads DB_BACKEND, falls back to the public var. */
export function dbBackend(): DbBackend {
  return normalize(process.env.DB_BACKEND ?? process.env.NEXT_PUBLIC_DB_BACKEND);
}

/** Browser-safe backend selection (only NEXT_PUBLIC_* is available client-side). */
export function publicDbBackend(): DbBackend {
  return normalize(process.env.NEXT_PUBLIC_DB_BACKEND);
}

export function isPostgresBackend(): boolean {
  return dbBackend() === "postgres";
}

export function isSupabaseBackend(): boolean {
  return dbBackend() === "supabase";
}
