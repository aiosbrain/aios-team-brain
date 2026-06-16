import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isPostgresBackend } from "@/lib/db/backend";
import { pgClient } from "@/lib/db/pg/client";

/**
 * Service-role data client — in supabase mode it bypasses RLS; in postgres mode
 * there is no RLS, so it's the same pg adapter as serverClient (access control
 * lives in app code). ONLY for the machine-auth sync path (lib/ingest,
 * /api/v1/*) and seed scripts. Never import from client code; the "server-only"
 * guard makes that a build error.
 */
export function adminClient(): SupabaseClient {
  if (isPostgresBackend()) {
    return pgClient() as unknown as SupabaseClient;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
