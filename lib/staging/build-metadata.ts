import "server-only";
import { timingSafeEqual } from "node:crypto";
import { migrationSetIdentity } from "@/scripts/staging-ops/build-identity.mjs";

function tokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (!presented || !expected || expected.length < 32) return false;
  const a = Buffer.from(presented); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stagingBuildMetadataResponse(request: Request, env: NodeJS.ProcessEnv = process.env): Response {
  if (!tokenMatches(request.headers.get("x-aios-build-metadata-token"), env.SOURCE_BUILD_METADATA_TOKEN)) return Response.json({ ok: false }, { status: 401 });
  const commit = env.RAILWAY_GIT_COMMIT_SHA;
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) return Response.json({ ok: false }, { status: 503 });
  return Response.json({ commit, migrationSet: migrationSetIdentity() }, { headers: { "cache-control": "no-store" } });
}
