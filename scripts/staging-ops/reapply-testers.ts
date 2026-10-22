import "server-only";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough } from "@/lib/auth/password";
import { resolveViewerPosture } from "@/lib/access/posture";

export type TesterCredential = { email: string; password: string; teamId: string; memberId: string; role: string; posture: "team" | "external" };

export async function reapplyTesterCredentials(db: DbClient, testers: TesterCredential[], setPassword = adminSetPassword): Promise<number> {
  if (!Array.isArray(testers) || testers.length < 1) throw new Error("at least one staging-only tester credential is required");
  for (const tester of testers) {
    if (!tester.email || !tester.memberId || !tester.teamId || !isPasswordStrongEnough(tester.password)) throw new Error("tester credential configuration is incomplete or weak");
    const { data, error } = await db.from("members").select("id, team_id, email, role, status").eq("id", tester.memberId).eq("team_id", tester.teamId).maybeSingle();
    if (error) throw new Error(`tester identity verification failed: ${error.message}`);
    const row = data as { id: string; team_id: string; email: string; role: string; status: string } | null;
    const posture = row ? await resolveViewerPosture(db, tester.teamId, tester.memberId) : null;
    if (!row || row.email.toLowerCase() !== tester.email.toLowerCase() || row.role !== tester.role || posture !== tester.posture || row.status !== "active") {
      throw new Error(`tester ${tester.memberId} identity/posture mismatch; refusing to grant or widen access`);
    }
    await setPassword(tester.email, tester.password);
  }
  return testers.length;
}

async function main() {
  // The SAME pure validator the importer's action preflight runs before anything drains, so this
  // process cannot be the first place a malformed configuration is discovered. It is a shape check
  // only: the authoritative membership/role/posture verification above still gates every write.
  const { parseTesterCredentials } = await import("./action-preflight.mjs");
  const testers = parseTesterCredentials(process.env.STAGING_TESTER_CREDENTIALS_JSON) as TesterCredential[];
  const count = await reapplyTesterCredentials(adminClient(), testers);
  console.log(`reapplied ${count} allowlisted staging tester credential(s)`);
}

if (process.argv.includes("--run")) main().catch((error) => { console.error(`tester credential reapply refused: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
