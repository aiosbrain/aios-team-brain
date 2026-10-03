import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeCacheBustingSearchParam } from "next/dist/shared/lib/router/utils/cache-busting-search-param";
import { setCacheBustingSearchParam } from "next/dist/client/components/router-reducer/set-cache-busting-search-param";
import {
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_RSC_UNION_QUERY,
  RSC_CONTENT_TYPE_HEADER,
  RSC_HEADER,
} from "next/dist/client/components/app-router-headers";
import { getCacheControlHeader } from "next/dist/server/lib/cache-control";
import { ensureAccessBootstrap, GENERAL_SLUG } from "@/lib/access/bootstrap";
import { createGroup } from "@/lib/access/groups";
import { resolveViewerPosture } from "@/lib/access/posture";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { FAILURES_TO_CONFIRM } from "@/lib/ingest/failure-streak";
import { RAW_ERROR_CLIP } from "@/lib/ingest/leg-detail";
import { recordIngestRun } from "@/lib/ingest/runs";
import { ingest, placeMemberByTier } from "../datamechanics/helpers";
import { BASE_URL, convergeTeam, db, seedTeam, type Seed } from "./http-helpers";

/**
 * AUDITFIX-25 (AIO-1062) — accepted spec v3.2, AC09: the PRODUCTION-WIRE half of the disclosure gates.
 *
 * AUDITFIX-25 puts a team's structured bootstrap findings into its `access_bootstrap` ledger rows, and
 * two server pages read those rows with `adminClient()`: Admin → Integrations (the runs panel + the
 * health banner) and Pulse (the health banner, a CLIENT component — its full `health` prop is
 * serialized whatever the 160-character visual clip shows). The `/admin` layout's "Admins only" card is
 * not a boundary for either: the installed Next 16.3 authentication guide ("Layouts and auth checks")
 * says a layout that hides or swaps its children "does not stop them from running or from appearing in
 * the RSC Payload", and a client navigation asks for the page segment WITHOUT the layout at all.
 *
 * So every case here is asked three ways, against `next start` on the real test Postgres:
 *
 *   html          the document (markup + its inlined flight payload, reassembled before searching)
 *   rsc-full      `rsc: 1` and no router state — the installed CDN guide: "when omitted on non-prefetch
 *                 RSC requests, the server returns a full payload instead of a targeted segment update"
 *   rsc-targeted  `rsc: 1` + `next-router-state-tree` naming THIS route with the `refetch` marker on the
 *                 segment below the layouts — what the installed client's dynamic request tree sends
 *                 (`ppr-navigations`: "set on the top-most segment that requires new data") and what
 *                 `walkTreeWithFlightRouterState` starts rendering from, skipping the matched layouts
 *
 * `_rsc` comes from the installed helpers, not a remembered hash: the client setter
 * (`setCacheBustingSearchParam`) writes it and the shared `computeCacheBustingSearchParam` — the same
 * function `base-server` validates with — must agree. A targeted response is only COUNTED as targeted
 * when the layout's own rendered output is absent from it and present in the full payload; a 307, an
 * HTML document, or a tree mismatch that silently fell back to a full render proves nothing and fails.
 *
 * The ledger rows are SEEDED through the real single writer in the typed version-1 shape the spec
 * pins. No producer is run here and none is claimed — producer → JSONB → reader → panel round-trips
 * belong to the real-Postgres tier. Every marker is synthetic.
 *
 * Unchanged base (283e68bc), expected: the positive controls and the anonymous case hold; the
 * evidence-disclosure case and every Integrations denial are RED (the page reads and renders the
 * ledger for any signed-in caller), and on Pulse only the external-posture admin is RED (`isAdmin` is
 * role-only). The other Pulse denials already hold and are regression pins, not new evidence.
 */

const TIMEOUT = 120_000;

type PageKey = "integrations" | "pulse";
type Profile = "html" | "rsc-full" | "rsc-targeted";
type PersonaKey = "admin" | "member" | "extadmin" | "disabled" | "foreign";

const PAGES: readonly PageKey[] = ["integrations", "pulse"];
const PROFILES: readonly Profile[] = ["html", "rsc-full", "rsc-targeted"];

const PAGE_PATH: Record<PageKey, (slug: string) => string> = {
  integrations: (slug) => `/t/${slug}/admin/integrations`,
  pulse: (slug) => `/t/${slug}`,
};

/** Text only the PAGE LEAF renders — never a layout, the head, or the router state. */
const PAGE_LEAF: Record<PageKey, string> = {
  integrations: "Recent ingestion runs",
  pulse: "What your team is working on",
};

/**
 * Who asks. Lower-case keys: they are spliced into the login email, which the login route lower-cases.
 *
 * `extadmin` stores `members.tier = 'team'` on purpose while holding only the `external` builtin: the
 * gate must read the membership-derived posture, so a gate that consulted the stored column would
 * admit this member and fail here. `disabled` is a full unrestricted admin who signs in FIRST — the
 * session cookie is self-contained, so the proxy keeps accepting it after the membership is disabled.
 * `foreign` is an unrestricted admin of the SECOND team asking for the first team's pages; a login
 * needs a membership somewhere, so this is the only authenticated nonmember there is.
 */
const PERSONAS: Record<
  PersonaKey,
  { team: "own" | "second"; role: "admin" | "member"; posture: "team" | "external"; disableAfterLogin?: true }
> = {
  admin: { team: "own", role: "admin", posture: "team" },
  member: { team: "own", role: "member", posture: "team" },
  extadmin: { team: "own", role: "admin", posture: "external" },
  disabled: { team: "own", role: "admin", posture: "team", disableAfterLogin: true },
  foreign: { team: "second", role: "admin", posture: "team" },
};

const DENIED: readonly { key: Exclude<PersonaKey, "admin">; label: string }[] = [
  { key: "member", label: "an internal non-admin member" },
  { key: "extadmin", label: "an external-posture admin" },
  { key: "disabled", label: "an admin disabled after signing in" },
  { key: "foreign", label: "a foreign-team admin (nonmember)" },
];

const BUILD_ID = (() => {
  try {
    return readFileSync(resolve(".next/BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
})();

// Spec §Scope / AC13: `vitest.http.config.ts` pins all three before `next start` inherits the
// environment, so no autonomous poller can write ledger rows over the fixtures. Asserted, never skipped.
beforeEach(() => {
  const controls = {
    INGEST_POLL_ENABLED: process.env.INGEST_POLL_ENABLED,
    GRAPH_PROJECT_ENABLED: process.env.GRAPH_PROJECT_ENABLED,
    SOCIAL_JOBS_ENABLED: process.env.SOCIAL_JOBS_ENABLED,
  };
  console.info(
    `AUDITFIX25_HTTP_RUN ${JSON.stringify({
      test: expect.getState().currentTestName,
      ...controls,
      graphitiUrlSet: Boolean(process.env.GRAPHITI_URL),
      buildId: BUILD_ID,
      baseUrl: BASE_URL,
    })}`
  );
  expect(controls, "the shared http tier's poller pins").toEqual({
    INGEST_POLL_ENABLED: "false",
    GRAPH_PROJECT_ENABLED: "false",
    SOCIAL_JOBS_ENABLED: "false",
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

interface Markers {
  /** Inside the banner's 160-character preview. */
  errorHead: string;
  /** Beyond it — reachable only through the serialized prop / the row's full error. */
  errorTail: string;
  /** The sampled group's display slug; also named by the census arm of the error. */
  groupSlug: string;
  /** The sampled group's UUID: in the evidence envelope and NOWHERE in the error text. */
  evidence: string;
}

interface TeamFixture {
  seed: Seed;
  markers: Markers;
}

interface World {
  own: TeamFixture;
  second: TeamFixture;
  cookies: Partial<Record<PersonaKey, string>>;
  /** Every scheduler-triggered ledger row this fixture wrote; nothing else may write one. */
  schedulerRowIds: string[];
}

const tokensOf = (m: Markers): string[] => [m.errorHead, m.errorTail, m.groupSlug, m.evidence];

function jsonOf<T>(value: unknown): T | null {
  if (typeof value !== "string") return (value ?? null) as T | null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * One team with `FAILURES_TO_CONFIRM` failed scheduler rows in the typed dual-failure shape: the
 * version-1 envelope plus the single compound error, both arms inside their 224-byte reservations so
 * neither is truncated. Two rows because the banner only names a CONFIRMED streak. The sample names
 * the team's REAL General system project and a REAL ordinary group, but the edge itself is NOT
 * planted: a live unsanctioned grant on General makes content placement refuse
 * (`lib/projects/context/memberships`), which would break the populated-Pulse fixture below, and
 * nothing in this tier runs the detector that would read it.
 */
async function seedFailedBootstrap(seed: Seed, tag: "a" | "b", base: number): Promise<Markers> {
  const boot = await ensureAccessBootstrap(db(), seed.teamId);
  if (!boot.ok) throw new Error(`fixture bootstrap failed: ${boot.error}`);

  const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
  const groupSlug = `af25-g${tag}-${nonce}`;
  const group = await createGroup(db(), seed.teamId, groupSlug, "AUDITFIX-25 synthetic group", seed.memberId);
  if (!group.ok || !group.groupId) throw new Error(`fixture group failed: ${group.error}`);
  const { data: general } = await db()
    .from("projects")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("slug", GENERAL_SLUG)
    .single();
  if (!general) throw new Error("fixture: the General system project is missing after bootstrap");
  const projectId = (general as { id: string }).id;

  const errorHead = `AF25-HEAD-${tag.toUpperCase()}-${nonce}`;
  const errorTail = `AF25-TAIL-${tag.toUpperCase()}-${nonce}`;
  const censusMessage = `1 unsanctioned edge(s) on system projects: ${GENERAL_SLUG}→${groupSlug}`;
  const convergenceMessage = `${errorHead} synthetic AUDITFIX-25 convergence fixture ${"padding ".repeat(16)}${errorTail}`;
  const error = `census: ${censusMessage}; convergence: ${convergenceMessage}`;
  const evidence = {
    version: 1,
    teamId: seed.teamId,
    convergence: { status: "failed", error: { message: convergenceMessage, truncated: false } },
    census: { status: "complete", total: 1, error: { message: censusMessage, truncated: false } },
    sample: [
      {
        projectId,
        groupId: group.groupId,
        projectSlug: GENERAL_SLUG,
        groupSlug,
        projectSlugTruncated: false,
        groupSlugTruncated: false,
      },
    ],
    omitted: 0,
  };

  // The fixture must BE what the cases claim about it, or a green denial means nothing.
  expect(Buffer.byteLength(censusMessage), "census arm inside its reservation").toBeLessThanOrEqual(224);
  expect(Buffer.byteLength(convergenceMessage), "convergence arm inside its reservation").toBeLessThanOrEqual(224);
  expect(Buffer.byteLength(error), "compound error budget").toBeLessThanOrEqual(480);
  expect(Buffer.byteLength(JSON.stringify({ accessBootstrapEvidence: evidence })), "namespace budget").toBeLessThanOrEqual(8192);
  expect(error.indexOf(errorHead) + errorHead.length, "head marker inside the preview").toBeLessThanOrEqual(RAW_ERROR_CLIP);
  expect(error.indexOf(errorTail), "tail marker beyond the preview").toBeGreaterThan(RAW_ERROR_CLIP);
  expect(error, "the evidence marker is not in the error text").not.toContain(group.groupId);

  for (let i = 0; i < FAILURES_TO_CONFIRM; i++) {
    const finishedAt = base - (FAILURES_TO_CONFIRM - i) * 30_000;
    await recordIngestRun(db(), {
      teamId: seed.teamId,
      source: "access_bootstrap",
      trigger: "scheduler",
      ok: false,
      created: 0,
      errors: [error],
      meta: { accessBootstrapEvidence: evidence },
      startedAt: finishedAt - 1_000,
      finishedAt,
    });
  }

  // `recordIngestRun` is best-effort and swallows its own failures — read the rows back.
  const { data, error: readErr } = await db()
    .from("ingest_runs")
    .select("id, ok, errors, meta")
    .eq("team_id", seed.teamId)
    .eq("source", "access_bootstrap");
  expect(readErr, "fixture ledger read").toBeNull();
  const rows = (data ?? []) as { ok: boolean; errors: unknown; meta: unknown }[];
  expect(rows, "fixture: a confirmed failure streak for this team").toHaveLength(FAILURES_TO_CONFIRM);
  for (const row of rows) {
    expect(row.ok).toBe(false);
    expect(jsonOf<string[]>(row.errors)).toEqual([error]);
    expect(jsonOf<Record<string, unknown>>(row.meta)).toEqual({ accessBootstrapEvidence: evidence });
  }

  return { errorHead, errorTail, groupSlug, evidence: group.groupId };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]; // aios_session=<jwt>
  if (!cookie.startsWith("aios_session=")) throw new Error("login returned no session cookie");
  return cookie;
}

async function seedPersona(world: World, key: PersonaKey): Promise<string> {
  const spec = PERSONAS[key];
  const team = spec.team === "own" ? world.own.seed : world.second.seed;
  const nonce = randomUUID().slice(0, 8);
  const email = `af25-${key}-${nonce}@test.local`;
  const password = `af25-password-${randomUUID().slice(0, 12)}`;
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: team.teamId,
      email,
      display_name: `Synthetic ${key}`,
      actor_handle: `af25-${key}-${nonce}`,
      role: spec.role,
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`persona '${key}' seed failed: ${error?.message}`);
  const memberId = (data as { id: string }).id;
  await placeMemberByTier(team.teamId, memberId, spec.posture);
  expect(await resolveViewerPosture(db(), team.teamId, memberId), `fixture: '${key}' posture`).toBe(spec.posture);
  await adminSetPassword(email, password);
  const cookie = await login(email, password);

  if (spec.disableAfterLogin) {
    const { error: offErr } = await db()
      .from("members")
      .update({ status: "disabled" })
      .eq("team_id", team.teamId)
      .eq("id", memberId);
    if (offErr) throw new Error(`persona '${key}' disable failed: ${offErr.message}`);
    const { data: after } = await db()
      .from("members")
      .select("status, auth_user_id")
      .eq("team_id", team.teamId)
      .eq("id", memberId)
      .single();
    const row = after as { status: string; auth_user_id: string | null } | null;
    expect(row?.status, "fixture: the membership is disabled").toBe("disabled");
    expect(row?.auth_user_id, "fixture: the session was linked while the membership was active").toBeTruthy();
  }
  return cookie;
}

async function buildWorld(personas: readonly PersonaKey[]): Promise<World> {
  const base = Date.now();
  const ownSeed = await seedTeam();
  const secondSeed = await seedTeam();
  const world: World = {
    own: { seed: ownSeed, markers: await seedFailedBootstrap(ownSeed, "a", base) },
    second: { seed: secondSeed, markers: await seedFailedBootstrap(secondSeed, "b", base) },
    cookies: {},
    schedulerRowIds: [],
  };

  // The fleet-liveness beat exactly as the leg writes it: NULL team, ok, aggregate counts only.
  await recordIngestRun(db(), {
    teamId: null,
    source: "access_bootstrap_all",
    trigger: "scheduler",
    ok: true,
    created: 0,
    meta: { teams: 2, failedTeams: 2, fleetOk: true },
    startedAt: base - 11_000,
    finishedAt: base - 10_000,
  });
  world.schedulerRowIds = await schedulerRowIds();
  expect(world.schedulerRowIds, "fixture: two failed rows per team plus one liveness beat").toHaveLength(
    2 * FAILURES_TO_CONFIRM + 1
  );

  // Populated, so Pulse cannot take the admin onboarding early return and skip the health read.
  const item = await ingest(ownSeed, {
    path: "af25/populated-pulse.md",
    body: "Synthetic AUDITFIX-25 populated-Pulse fixture item.",
    access: "team",
  });
  if (!item.id) throw new Error(`fixture item failed: ${item.status}`);
  await convergeTeam(ownSeed);

  for (const key of personas) world.cookies[key] = await seedPersona(world, key);
  return world;
}

async function schedulerRowIds(): Promise<string[]> {
  const { data, error } = await db().from("ingest_runs").select("id").eq("trigger", "scheduler");
  expect(error, "ledger read").toBeNull();
  return ((data ?? []) as { id: number | string }[]).map((r) => String(r.id)).sort();
}

/** No poller ticked during the case: the scheduler rows are still exactly the seeded ones. */
async function expectLedgerUntouched(world: World): Promise<void> {
  expect(await schedulerRowIds(), "no scheduler row was written over the fixtures").toEqual(world.schedulerRowIds);
}

// ── Wire ─────────────────────────────────────────────────────────────────────────────────────────

/** The installed `FlightRouterState` request shape (`server/app-render/types` schema). */
type RouterState = [
  segment: string | [name: string, cacheKey: string, type: "d", staticSiblings: null],
  parallelRoutes: Record<string, RouterState>,
  url?: null,
  marker?: "refetch",
];

/**
 * THIS route's own tree, `refetch` on the segment directly below the layout the case must skip:
 * `integrations` (below the team AND admin layouts) or Pulse's `__PAGE__` (below the team layout).
 * Dynamic segments carry the null `staticSiblings` slot the installed client sends after
 * `prepareFlightRouterStateForRequest` — the server schema rejects a three-element tuple.
 */
function targetedTree(page: PageKey, slug: string): RouterState {
  const below: RouterState =
    page === "pulse"
      ? ["__PAGE__", {}, null, "refetch"]
      : ["admin", { children: ["integrations", { children: ["__PAGE__", {}] }, null, "refetch"] }];
  return ["", { children: ["t", { children: [["team", slug, "d", null], { children: below }] }] }];
}

interface Wire {
  page: PageKey;
  persona: PersonaKey | "anonymous";
  profile: Profile;
  status: number;
  contentType: string;
  cacheControl: string;
  vary: string;
  location: string | null;
  /** True when one same-origin `_rsc` correction was followed; the 307 itself is never evidence. */
  corrected: boolean;
  rsc: string | null;
  tree: RouterState | null;
  body: string;
  /** What is searched: the body, plus — for a document — its reassembled inline flight payload. */
  text: string;
}

/**
 * The flight stream a document inlines as `self.__next_f.push([1, chunk])` (or `[3, base64]` when a
 * chunk boundary split a multi-byte character). Chunks are cut at arbitrary byte offsets, so a marker
 * can straddle two scripts — search the reassembled stream, not the raw markup.
 */
function inlineFlight(html: string): string {
  const parts: Buffer[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\((\[[13],"(?:[^"\\]|\\.)*"\])\)/g)) {
    const [kind, data] = JSON.parse(m[1]) as [1 | 3, string];
    parts.push(kind === 1 ? Buffer.from(data, "utf8") : Buffer.from(data, "base64"));
  }
  return Buffer.concat(parts).toString("utf8");
}

async function request(
  world: World,
  page: PageKey,
  profile: Profile,
  persona: PersonaKey | "anonymous"
): Promise<Wire> {
  const slug = world.own.seed.teamSlug;
  const url = new URL(PAGE_PATH[page](slug), BASE_URL);
  const flight: Record<string, string> = {};
  let tree: RouterState | null = null;
  let rsc: string | null = null;
  if (profile !== "html") {
    flight[RSC_HEADER] = "1";
    if (profile === "rsc-targeted") {
      tree = targetedTree(page, slug);
      flight[NEXT_ROUTER_STATE_TREE_HEADER] = encodeURIComponent(JSON.stringify(tree));
    }
    await setCacheBustingSearchParam(url, flight as Parameters<typeof setCacheBustingSearchParam>[1]);
    rsc = await computeCacheBustingSearchParam(undefined, undefined, flight[NEXT_ROUTER_STATE_TREE_HEADER], undefined);
    expect(url.searchParams.get(NEXT_RSC_UNION_QUERY), "client setter and shared helper agree on _rsc").toBe(rsc);
  }
  const cookie = persona === "anonymous" ? undefined : world.cookies[persona];
  if (persona !== "anonymous" && !cookie) throw new Error(`no session seeded for persona '${persona}'`);
  const init: RequestInit = { headers: cookie ? { ...flight, cookie } : flight, redirect: "manual", cache: "no-store" };

  let res = await fetch(url, init);
  let corrected = false;
  if (profile !== "html" && res.status === 307) {
    // Only a cache-busting correction is followed: same origin, same path, `_rsc` set. Once, with the
    // same cookie and flight headers. A redirect to anywhere else stays the response under test.
    const location = res.headers.get("location");
    const next = location ? new URL(location, url) : null;
    if (next && next.origin === url.origin && next.pathname === url.pathname && next.searchParams.has(NEXT_RSC_UNION_QUERY)) {
      await res.arrayBuffer();
      res = await fetch(next, init);
      corrected = true;
    }
  }

  const body = await res.text();
  const wire: Wire = {
    page,
    persona,
    profile,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    cacheControl: res.headers.get("cache-control") ?? "",
    vary: res.headers.get("vary") ?? "",
    location: res.headers.get("location"),
    corrected,
    rsc,
    tree,
    body,
    text: profile === "html" ? `${body}\n${inlineFlight(body)}` : body,
  };
  const seen = observe(world, wire);
  console.info(
    `AUDITFIX25_HTTP_WIRE ${JSON.stringify({
      test: expect.getState().currentTestName,
      page,
      persona,
      profile,
      status: wire.status,
      contentType: wire.contentType,
      cacheControl: wire.cacheControl,
      cacheControlIsInstalledDynamicGrammar: wire.cacheControl === getCacheControlHeader({ revalidate: 0, expire: undefined }),
      vary: wire.vary,
      location: wire.location,
      corrected,
      rsc,
      tree,
      bytes: body.length,
      payloadCarriesBuildId: BUILD_ID !== null && wire.text.includes(`"b":"${BUILD_ID}"`),
      seen,
    })}`
  );
  return wire;
}

/** What one response actually carries. Layout facts are RENDERED output, never a router segment name. */
function observe(world: World, w: Wire) {
  const slug = world.own.seed.teamSlug;
  const own = world.own.markers;
  const has = (needle: string) => w.text.includes(needle);
  return {
    // app/t/[team]/layout.tsx — the sidebar it renders for a member, or its no-team screen.
    teamShell: has('"data-staging-offset":true'),
    noTeam: has("No team here for you"),
    // app/t/[team]/admin/layout.tsx — the admitted shell's tab bar, or its denial card.
    adminShell: has(`"base":"/t/${slug}/admin"`),
    adminsOnly: has("Admins only"),
    pageLeaf: has(PAGE_LEAF[w.page]),
    // The banner's link: serialized exactly when a health read was made and handed to the client.
    healthHref: has(`/t/${slug}/admin/integrations#ingestion-runs`),
    livenessSource: has("access_bootstrap_all"),
    ownErrorHead: has(own.errorHead),
    ownErrorTail: has(own.errorTail),
    ownGroupSlug: has(own.groupSlug),
    ownEvidence: has(own.evidence),
    secondAny: tokensOf(world.second.markers).some(has),
  };
}

const at = (w: Wire) => `${w.page}/${w.persona}/${w.profile}`;

/** An authenticated request is answered 200 in its own protocol — never a redirect, never HTML for RSC. */
function protocolViolations(w: Wire): string[] {
  const out: string[] = [];
  if (w.status !== 200) out.push(`${at(w)}: status ${w.status}, location ${w.location ?? "none"} — expected 200`);
  if (w.profile === "html") {
    if (!w.contentType.startsWith("text/html")) out.push(`${at(w)}: content-type '${w.contentType}' — expected text/html`);
    if (inlineFlight(w.body).length === 0) out.push(`${at(w)}: the document inlines no flight payload`);
    return out;
  }
  if (!w.contentType.startsWith(RSC_CONTENT_TYPE_HEADER)) {
    out.push(`${at(w)}: content-type '${w.contentType}' — expected ${RSC_CONTENT_TYPE_HEADER}`);
  }
  if (/<!DOCTYPE html|<html[\s>]/i.test(w.body)) out.push(`${at(w)}: an HTML document answered an RSC request`);
  if (!/(?:^|\n)0:\{/.test(w.body) || !w.body.includes('"f":')) out.push(`${at(w)}: no flight root row carrying flight data`);
  if (/NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/.test(w.body)) {
    out.push(`${at(w)}: the payload carries a redirect/not-found digest`);
  }
  return out;
}

type LayoutFact = "teamShell" | "noTeam" | "adminShell" | "adminsOnly";
const LAYOUT_FACTS: readonly LayoutFact[] = ["teamShell", "noTeam", "adminShell", "adminsOnly"];

/** What the layouts above the page render for this viewer in a FULL response (document or payload). */
function fullLayout(page: PageKey, persona: PersonaKey): { present: LayoutFact[]; absent: LayoutFact[] } {
  if (persona === "disabled" || persona === "foreign") return { present: ["noTeam"], absent: ["teamShell", "adminShell"] };
  if (page === "pulse") return { present: ["teamShell"], absent: ["noTeam"] };
  return persona === "admin"
    ? { present: ["teamShell", "adminShell"], absent: ["noTeam", "adminsOnly"] }
    : { present: ["teamShell", "adminsOnly"], absent: ["noTeam", "adminShell"] };
}

/**
 * The targeted-versus-full discriminator. A full response carries the layouts' rendered output; a
 * genuinely targeted one carries NONE of it — admitted shell and denial card alike. A targeted request
 * whose tree did not match renders the full tree and fails here instead of passing as targeted.
 */
function layoutViolations(w: Wire, seen: ReturnType<typeof observe>): string[] {
  if (w.persona === "anonymous") return [];
  if (w.profile === "rsc-targeted") {
    return LAYOUT_FACTS.filter((f) => seen[f]).map((f) => `${at(w)}: layout output '${f}' in a targeted payload — not targeted`);
  }
  const want = fullLayout(w.page, w.persona);
  return [
    ...want.present.filter((f) => !seen[f]).map((f) => `${at(w)}: full response lacks layout output '${f}'`),
    ...want.absent.filter((f) => seen[f]).map((f) => `${at(w)}: full response carries layout output '${f}'`),
  ];
}

/** Marker-bearing responses are private and uncacheable (installed grammar recorded per response). */
function cacheViolations(w: Wire): string[] {
  const directives = w.cacheControl.split(",").map((d) => d.trim().toLowerCase());
  const out: string[] = [];
  for (const need of ["private", "no-store"]) {
    if (!directives.includes(need)) out.push(`${at(w)}: cache-control '${w.cacheControl}' lacks '${need}'`);
  }
  if (directives.some((d) => d === "public" || d.startsWith("s-maxage"))) {
    out.push(`${at(w)}: cache-control '${w.cacheControl}' is shared-cacheable`);
  }
  return out;
}

/**
 * The POSITIVE control: the unrestricted admin really is served the seeded error — head marker and the
 * tail marker past the preview — in this protocol, with the page leaf, the right layout facts, private
 * caching, and nothing of the second team's. Without this a marker-free denial could be a dead fixture.
 */
async function admittedViolations(world: World, page: PageKey): Promise<{ wires: Wire[]; violations: string[] }> {
  const wires: Wire[] = [];
  const violations: string[] = [];
  for (const profile of PROFILES) {
    const w = await request(world, page, profile, "admin");
    const seen = observe(world, w);
    wires.push(w);
    violations.push(...protocolViolations(w), ...layoutViolations(w, seen), ...cacheViolations(w));
    if (!seen.pageLeaf) violations.push(`${at(w)}: the page leaf did not render`);
    if (!seen.ownErrorHead) violations.push(`${at(w)}: the error head marker is not serialized`);
    if (!seen.ownErrorTail) violations.push(`${at(w)}: the error tail marker (beyond the preview) is not serialized`);
    if (seen.secondAny) violations.push(`${at(w)}: carries the SECOND team's markers`);
    if (page === "integrations" && !seen.livenessSource) violations.push(`${at(w)}: the NULL-team liveness row is not listed`);
    if (page === "pulse" && !seen.healthHref) violations.push(`${at(w)}: no pipeline-health banner props`);
    if (page === "pulse" && seen.ownEvidence) violations.push(`${at(w)}: Pulse carries the evidence envelope's UUID`);
  }
  return { wires, violations };
}

/** A denied viewer: a real 200 in each protocol, the nonsecret route/denial output, and no marker. */
async function deniedViolations(world: World, page: PageKey, persona: Exclude<PersonaKey, "admin">): Promise<string[]> {
  const violations: string[] = [];
  const hasMembership = persona === "member" || persona === "extadmin";
  for (const profile of PROFILES) {
    const w = await request(world, page, profile, persona);
    const seen = observe(world, w);
    violations.push(...protocolViolations(w), ...layoutViolations(w, seen));
    if (seen.ownErrorHead) violations.push(`${at(w)}: LEAK — error head marker`);
    if (seen.ownErrorTail) violations.push(`${at(w)}: LEAK — error tail marker`);
    if (seen.ownGroupSlug) violations.push(`${at(w)}: LEAK — sampled group slug`);
    if (seen.ownEvidence) violations.push(`${at(w)}: LEAK — evidence UUID`);
    if (seen.secondAny) violations.push(`${at(w)}: LEAK — the second team's markers`);
    if (page === "integrations") {
      // The denial leaf is `return null`: nothing the page itself renders, and no layout card of its own.
      if (seen.pageLeaf) violations.push(`${at(w)}: the page leaf rendered — the denial leaf must be null`);
    } else {
      if (seen.healthHref) violations.push(`${at(w)}: pipeline-health banner props were serialized`);
      // A member who is merely not an unrestricted admin still gets Pulse itself.
      if (hasMembership && !seen.pageLeaf) violations.push(`${at(w)}: Pulse did not render for a team member`);
      if (!hasMembership && seen.pageLeaf) violations.push(`${at(w)}: Pulse rendered for a non-member`);
    }
  }
  return violations;
}

// ── Cases ────────────────────────────────────────────────────────────────────────────────────────

describe("AUDITFIX-25 AC09 — Admin → Integrations over HTML and RSC (HTTP)", () => {
  it("positive control: an unrestricted admin is served the failed-row error markers in HTML, full RSC and targeted RSC", async () => {
    const world = await buildWorld(["admin"]);
    const { violations } = await admittedViolations(world, "integrations");
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);

  it("discloses the typed evidence marker to an unrestricted admin in HTML, full RSC and targeted RSC", async () => {
    const world = await buildWorld(["admin"]);
    const { wires, violations } = await admittedViolations(world, "integrations");
    // The sampled group's UUID lives only in `meta.accessBootstrapEvidence` — never in the error text —
    // so its presence is the disclosure itself, in every protocol the admin can be served.
    for (const w of wires) {
      if (!observe(world, w).ownEvidence) violations.push(`${at(w)}: the evidence UUID is not serialized`);
    }
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);

  it.each(DENIED)("denies $label: 200 in each protocol, a null page leaf, no marker", async ({ key }) => {
    const world = await buildWorld(["admin", key]);
    const control = (await admittedViolations(world, "integrations")).violations.map((v) => `CONTROL ${v}`);
    const violations = [...control, ...(await deniedViolations(world, "integrations", key))];
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);
});

describe("AUDITFIX-25 AC09 — Pulse pipeline health over HTML and RSC (HTTP)", () => {
  it("positive control: an unrestricted admin is served both health error markers, one beyond the 160-character preview", async () => {
    const world = await buildWorld(["admin"]);
    const { violations } = await admittedViolations(world, "pulse");
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);

  it.each(DENIED)("denies $label the health error markers in HTML, full RSC and targeted RSC", async ({ key }) => {
    const world = await buildWorld(["admin", key]);
    const control = (await admittedViolations(world, "pulse")).violations.map((v) => `CONTROL ${v}`);
    const violations = [...control, ...(await deniedViolations(world, "pulse", key))];
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);
});

describe("AUDITFIX-25 AC09 — anonymous requests (HTTP)", () => {
  it("the proxy answers every protocol of both pages with the login redirect, and nothing else", async () => {
    const world = await buildWorld([]);
    const secrets = [...tokensOf(world.own.markers), ...tokensOf(world.second.markers)];
    const violations: string[] = [];
    for (const page of PAGES) {
      const path = PAGE_PATH[page](world.own.seed.teamSlug);
      for (const profile of PROFILES) {
        const w = await request(world, page, profile, "anonymous");
        const destination = w.location ? new URL(w.location, BASE_URL) : null;
        if (w.status !== 307) violations.push(`${at(w)}: status ${w.status} — expected the proxy's 307`);
        if (w.corrected) violations.push(`${at(w)}: a cache-busting correction was served to an anonymous caller`);
        if (destination?.pathname !== "/login") violations.push(`${at(w)}: redirected to '${w.location}' — expected /login`);
        if (destination?.searchParams.get("next") !== path) violations.push(`${at(w)}: login 'next' is not ${path}`);
        if (secrets.some((s) => w.text.includes(s))) violations.push(`${at(w)}: LEAK in the redirect response`);
        if (destination) {
          // Same loopback origin the suite was allocated, whatever host the redirect names.
          const followed = await fetch(new URL(`${destination.pathname}${destination.search}`, BASE_URL), { redirect: "manual" });
          const html = await followed.text();
          if (secrets.some((s) => html.includes(s))) violations.push(`${at(w)}: LEAK on the login destination`);
        }
      }
    }
    await expectLedgerUntouched(world);
    expect(violations).toEqual([]);
  }, TIMEOUT);
});
