import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — bypasses RLS. ONLY for the machine-auth sync path
 * (lib/ingest, /api/v1/*) and seed scripts. Never import from client code;
 * the "server-only" guard makes that a build error.
 */
export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("missing SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
