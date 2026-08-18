import { NextRequest, after } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey, authenticateAgentToken, isAgentBearer } from "@/lib/api/auth";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { rateLimit } from "@/lib/api/rate-limit";
import {
  normalizeTier,
  errorResponse,
  IngestValidationError,
  TierViolationError,
} from "@/lib/api/schemas";
import { MAX_PAYLOAD_ROWS, wireItemPayloadSchema } from "@/lib/api/item-payload-schema";
import { ingestItem } from "@/lib/ingest";
import { attributeIncomingItem } from "@/lib/attribution/resolve-authors";
import { projectChangedTasksAfterWrite } from "@/lib/pm-sync";
import {
  meetingBackfillScheduler,
  shouldScheduleMeetingBackfill,
} from "@/lib/meetings/schedule-backfill";

export const runtime = "nodejs";

/** The per-item `body` cap. Also enforced by `commonItemFields.body` in the payload schema. */
const MAX_PAYLOAD = 1_000_000; // 1 MB per contract

/**
 * The whole-REQUEST transport ceiling (brain-api 1.20, AIO-923) — deliberately NOT `MAX_PAYLOAD`.
 *
 * A `task`/`decision` payload is `body` PLUS up to `MAX_PAYLOAD_ROWS` rows, and this gate used to be
 * `MAX_PAYLOAD * 1.2` = 1.2 MB — so it fired at roughly 1,100 rows, long before any row bound, with a
 * bare `413 payload_too_large / "max 1 MB"` that named no field. Since chunking client-side is not
 * available for `task` (the sweep in `lib/ingest/tasks.ts` is PROJECT-wide, so chunk 2 deletes chunk
 * 1 — the other row kinds sweep per-item and could be split), a whole workspace has to fit in ONE
 * request or fail with a reason. 1 MB body + 5,000 rows × ~700 B, +20% JSON framing slack =
 * **5,400,000 B (5.4 MB)**, a 4.5× raise.
 *
 * NOT a guarantee that 5,000 rows always fit: 700 B is the measured ClickUp average, and 5,000 rows
 * of schema-legal maximums (2,000-char titles, 50 × 80-char labels) exceed this and still 413. That
 * failure is now at least diagnosable — the message names both bounds — but the two limits are
 * independent, and neither implies the other.
 *
 * DoS surface: worst case per key is 120 × 5.4 MB ≈ **648 MB/min**, up from 120 × 1.2 MB ≈ 144 MB/min.
 * The mitigation is the rate limit below plus authentication: this is a ceiling on an ALREADY-
 * AUTHENTICATED principal in a self-hosted, single-org deployment, so the population that can reach
 * it is the team's own issued keys, and the pre-existing 144 MB/min was already well past what a
 * malicious key needs to hurt. A 4.5× raise on an authenticated, rate-limited path is a real but
 * small increase in blast radius, taken deliberately so that legitimate imports stop failing.
 */
const MAX_REQUEST_BYTES = Math.ceil((MAX_PAYLOAD + MAX_PAYLOAD_ROWS * 700) * 1.2);
const PAGE_SIZE = 200;

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:items:post`, 120))) {
    return errorResponse("rate_limited", "120 pushes/min per key", 429);
  }

  const len = parseInt(req.headers.get("content-length") || "0", 10);
  if (len > MAX_REQUEST_BYTES) {
    return errorResponse(
      "payload_too_large",
      `request exceeds ${MAX_REQUEST_BYTES} bytes (body max 1 MB, rows max ${MAX_PAYLOAD_ROWS})`,
      413
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = wireItemPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }
  // UNREACHABLE, and kept deliberately. `commonItemFields.body` is `z.string().max(1_000_000)`, so an
  // over-cap body already 422'd at the parse above — a body overflow is `invalid_payload`, NOT this
  // 413, which is why the brain-api 1.20 envelope says 413 means the TRANSPORT ceiling. Left as a
  // belt-and-braces backstop in case the schema's own cap is ever relaxed or decoupled from
  // `MAX_PAYLOAD`; if it fires, the two have drifted.
  if (parsed.data.body.length > MAX_PAYLOAD) {
    return errorResponse("payload_too_large", "body exceeds 1 MB", 413);
  }

  // Only a lead/admin may publish the team blueprint (which tools the team uses).
  if (parsed.data.kind === "blueprint" && auth.memberRole !== "admin" && auth.memberRole !== "lead") {
    return errorResponse("forbidden", "only a team lead or admin can publish the team blueprint", 403);
  }

  const tier = normalizeTier(parsed.data.access);
  if (parsed.data.access === "admin" || parsed.data.access === "private") {
    return errorResponse(
      "forbidden_tier",
      "private/admin-tier content must never leave the workspace",
      422
    );
  }
  if (!tier) {
    return errorResponse("invalid_payload", `unknown access tier '${parsed.data.access}'`, 422);
  }

  try {
    // Resolve the item's author from its frontmatter at INGEST → attribute to the real human, never
    // silently to the ingesting connector. ONLY for trusted team-tier keys: an external (client) key
    // must not be able to attribute content to a team member (spoofing) — it keeps actor attribution.
    const { opts } = isRestrictedTier(auth.memberTier)
      ? {}
      : await attributeIncomingItem(db, auth.teamId, parsed.data, auth.memberId);
    // Pass the key's tier: ingestItem resolves the item's tier from it on BOTH write paths, so an
    // external key can neither reclassify an existing item nor declare `team` on a new one.
    const pusherTier = isRestrictedTier(auth.memberTier) ? "external" : "team";
    const result = await ingestItem(db, auth, parsed.data, tier, opts, pusherTier);

    // Reactive auto-projection (brain-api v1.2 Phase 2): on a task push that actually changed
    // projected fields, schedule a bounded projection of ONLY the changed rows into the team's
    // primary PM tool — after the response, never failing/blocking the push. Fire-and-forget; the
    // helper swallows all errors. work-events keeps its own inline projection (unchanged).
    if (
      parsed.data.kind === "task" &&
      result.status !== "unchanged" &&
      result.projectId &&
      (result.changedTaskRowKeys?.length ?? 0) > 0
    ) {
      const teamId = auth.teamId;
      const projectId = result.projectId;
      const rowKeys = result.changedTaskRowKeys!;
      after(async () => {
        await projectChangedTasksAfterWrite(adminClient(), teamId, projectId, rowKeys);
      });
    }

    // A pushed MEETING becomes visible on the Meetings page within seconds instead of waiting for the
    // 30-minute scheduler tick. The Meetings page reads `meeting_notes`, which only the backfill writes,
    // so until now `aios push` returned success while the UI showed nothing. Same shape as the task
    // projection above: after the response, coalesced per team, errors swallowed — the scheduler tick
    // stays the backstop, so a failure here only costs latency, never the note.
    if (
      shouldScheduleMeetingBackfill({
        kind: parsed.data.kind,
        source: parsed.data.frontmatter?.source,
        status: result.status,
      })
    ) {
      const teamId = auth.teamId;
      // Awaited so the platform keeps the process alive for this post-response work — self-host targets
      // that freeze after the response would otherwise kill a detached run mid-extraction.
      after(() => meetingBackfillScheduler.schedule(teamId));
    }

    // §11 context: partition the just-ingested item into its unit + system-project membership
    // immediately (spec §11.2), so new content is access-partitioned on push, not only when the
    // scheduler backfill next sweeps. After the response, best-effort — a failure only costs
    // latency (the scheduler leg is the backstop), never the push. Skips silently if the team's
    // system projects don't exist yet (bootstrap covers it). Inert in Phase A (no read enforces
    // memberships yet) but keeps the substrate current from day one of Phase B.
    // Fire on a real ingest OR a tier reclassification that arrived as `unchanged` (the
    // heal-access path) — the latter is the security-relevant MOVE (slice-5 Fable HIGH).
    if (result.status !== "unchanged" || result.accessChanged) {
      const teamId = auth.teamId;
      const itemId = result.id;
      // Scheduling the post-response work must never fail the push — not the work (best-effort
      // inside), and not the `after()` registration itself (it throws when called outside a
      // request scope, e.g. the in-process handler tests). Either way the scheduler leg is the
      // backstop, so a miss here costs latency, never the push.
      try {
        after(async () => {
          const { reconcileItemContext } = await import("@/lib/projects/context/reconcile-item");
          const r = await reconcileItemContext(adminClient(), teamId, itemId).catch((e) => ({
            ok: false,
            error: e instanceof Error ? e.message : "threw",
          }));
          if (!r.ok) console.warn(`[access] context reconcile for item ${itemId} failed: ${(r as { error?: string }).error}`);
        });
      } catch {
        // no request scope (tests) or after() unavailable — the scheduler backstop covers it
      }
    }

    // Strip the internal scheduling hints — the HTTP wire format stays { status, id }.
    return Response.json(
      { status: result.status, id: result.id },
      { status: result.status === "created" ? 201 : 200 }
    );
  } catch (e) {
    // Client validation failures (e.g. a bad task row or a parent-integrity violation) are 422,
    // not 500 — the CLI needs a structured signal to fix the markdown and retry.
    if (e instanceof IngestValidationError) {
      return errorResponse("invalid_payload", e.message, 422);
    }
    // The payload is fine; the PRINCIPAL isn't allowed to write this item's tier — 403, not 422, so a
    // client key gets an unambiguous "not yours" instead of hunting for a markdown problem.
    if (e instanceof TierViolationError) {
      return errorResponse("forbidden_tier", e.message, 403);
    }
    return errorResponse("internal", e instanceof Error ? e.message : "ingest failed", 500);
  }
}

export async function GET(req: NextRequest) {
  // Phase A (spec §10/§17-A): this is the ONE route that honors delegated agent tokens.
  // An agent principal gets the oracle filter below; member keys behave exactly as before.
  let agentProjects: ReadonlySet<string> | null = null;
  let auth: { teamId: string; memberId: string; memberTier: "team" | "external"; apiKeyId: string };
  if (isAgentBearer(req)) {
    const agent = await authenticateAgentToken(req);
    if (!agent) return errorResponse("unauthorized", "invalid agent token or team", 401);
    const { effectiveVisibleProjects } = await import("@/lib/access/oracle");
    agentProjects = await effectiveVisibleProjects(adminClient(), agent);
    auth = { teamId: agent.teamId, memberId: agent.memberId, memberTier: agent.memberTier, apiKeyId: `agent:${agent.agentTokenId}` };
  } else {
    const memberAuth = await authenticateApiKey(req);
    if (!memberAuth) return errorResponse("unauthorized", "invalid API key or team", 401);
    auth = memberAuth;
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:items:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00Z";
  const cursor = url.searchParams.get("cursor");
  const project = url.searchParams.get("project");
  const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
  const pathPrefix = url.searchParams.get("path_prefix");

  // Tier filtering re-applied server-side: external-tier keys see only external.
  let q = db
    .from("items")
    .select("id, path, kind, access, frontmatter, body, content_sha256, actor, updated_at, projects(slug)")
    .eq("team_id", auth.teamId)
    .gt("updated_at", cursor || since)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);
  // Enforced read (Phase B slice 1, spec §5/§11; wall re-ruled by PRET-4 §1b): visibility is
  // MODE-keyed — enforcing → the ORACLE alone (the legacy posture conjunct is gone: an external
  // member granted a project must see its access='team' rows, ruling 2, and the conjunct was
  // the only thing blocking that); permissive → the posture wall alone (applied below, after
  // the mode is known). When the team is 'enforcing', BOTH member and agent reads intersect
  // with the membership-visible item set (an agent must never exceed its launcher — slice-B1
  // Fable HIGH; the agent's Phase-A project_id proxy is used ONLY under permissive).
  // A flag-read error throws → 500 (fail closed, never a wrong mode).
  // PRET-6: enforcing is the only behavior — the oracle decides, unconditionally (the mode
  // branch, the permissive posture wall, and the agent Phase-A project_id proxy all retired).
  {
    const { visibleItemIdsForProjects } = await import("@/lib/access/enforce");
    let projectSet: ReadonlySet<string>;
    if (agentProjects !== null) {
      projectSet = agentProjects; // the agent's effective set (already oracle-attenuated)
    } else {
      const { visibleProjects } = await import("@/lib/access/oracle");
      projectSet = (await visibleProjects(db, { teamId: auth.teamId, memberId: auth.memberId })).projectIds;
    }
    const { ids, empty } = await visibleItemIdsForProjects(db, auth.teamId, projectSet);
    if (empty) return Response.json({ items: [], next_cursor: null });
    q = q.in("id", [...ids]);
  }
  if (kinds?.length) q = q.in("kind", kinds);
  // On-demand fetch of one skill/deliverable folder: match path by prefix.
  if (pathPrefix) q = q.like("path", `${pathPrefix.replace(/[%_\\]/g, "\\$&")}%`);

  const { data, error } = await q;
  if (error) return errorResponse("internal", error.message, 500);

  let items = (data ?? []).map((i) => ({
    id: i.id,
    project: (i.projects as unknown as { slug: string })?.slug,
    path: i.path,
    kind: i.kind,
    access: i.access,
    frontmatter: i.frontmatter,
    body: i.body,
    content_sha256: i.content_sha256,
    actor: i.actor,
    updated_at: i.updated_at,
  }));
  if (project) items = items.filter((i) => i.project === project);

  const next_cursor =
    (data?.length ?? 0) === PAGE_SIZE ? data![data!.length - 1].updated_at : null;
  return Response.json({ items, next_cursor });
}
