/**
 * AUDITFIX-19 — the ONE parser for an agent-token mint's scope choice. PURE: no I/O, no framework,
 * no `server-only`, so the request policy (shared with the client form), the public admin action and
 * the guarded writer `lib/access/agent-tokens.ts` all consume the same rule.
 *
 * WHY A REQUIRED, DISCRIMINATED CHOICE: an omitted scope used to become `project_scope = NULL` — a
 * token inheriting the launcher's entire live visibility — with nobody having chosen it. Every new
 * mint must now say which of two things it means:
 *
 *   { kind: "all-reachable" }                  → stored NULL: no attenuation beyond the live legs
 *   { kind: "projects", projectIds: [P, …] }   → stored canonical lowercase copy of the list
 *
 * Saying nothing is a refusal. This changes ISSUANCE only: the stored read semantics (NULL = no
 * attenuation, `[]` = sees nothing, populated = intersection) are untouched, and an already stored
 * `[]` is still a valid credential that reads nothing — it simply cannot be newly requested.
 *
 * WHY IT SNAPSHOTS: the action awaits visibility reads between validating and minting, and an
 * in-process caller can hand both boundaries a live object. So the discriminant and list are read
 * ONCE, the list's length is read once and must be a genuine array length (a non-negative safe
 * integer — a proxy answering `"0"` or `NaN` is refused, never coerced), every index must be an OWN
 * element (a hole is refused — `.some`/`.every` would skip it, and a plain read would fall through to
 * the prototype), and the list is copied index-by-index into a new dense array. Only that validated,
 * canonicalized copy is returned. Callers must consume the returned value, never the raw input.
 *
 * WHY IT CATCHES: any read of an untrusted in-process object can throw — a getter, a proxy trap, a
 * revoked proxy inside `Array.isArray`. Such a request is refused with the fixed invalid-request text;
 * the thrown value is never inspected or echoed, because it can carry arbitrary (even secret) content.
 */

/** Upper bound on a single token's scope list — a sanity cap, not a security control. */
export const MAX_PROJECT_SCOPE = 200;

export type TokenMintScope = { kind: "all-reachable" } | { kind: "projects"; projectIds: string[] };

export type ScopeParseResult = { ok: true; scope: TokenMintScope } | { ok: false; error: string };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The existing whole-request refusal, shared so both boundaries return the same words. */
export const INVALID_REQUEST = "invalid request";

export const SCOPE_ERRORS = {
  legacyKey:
    'projectScope is no longer accepted — send scope: { kind: "all-reachable" } or { kind: "projects", projectIds: [...] }',
  required: "scope is required — choose all-reachable or name the projects this token may read",
  notObject: 'scope must be an object: { kind: "all-reachable" } or { kind: "projects", projectIds: [...] }',
  badKind: 'scope.kind must be "all-reachable" or "projects"',
  allReachableExtra: 'scope { kind: "all-reachable" } takes no other fields',
  projectsExtra: 'scope { kind: "projects" } takes only projectIds',
  projectIdsRequired: 'scope.projectIds is required for kind "projects"',
  projectIdsNotArray: "scope.projectIds must be an array of project uuids",
  projectIdsEmpty: "scope.projectIds must name at least one project — or choose all-reachable",
  projectIdsTooMany: `scope.projectIds may name at most ${MAX_PROJECT_SCOPE} projects`,
  projectIdsNotUuids: "scope.projectIds must contain only project uuids",
  projectIdsDuplicate: "scope.projectIds must not repeat a project",
} as const;

/**
 * A request must be a plain non-null, non-array object before ANY field of it is read. `Array.isArray`
 * throws on a revoked proxy, so callers run this inside their capture stage's catch.
 */
export function isRequestObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(error: string): ScopeParseResult {
  return { ok: false, error };
}

/** Copy, validate and canonicalize a `projects` list. `list` has been read exactly once. */
function parseProjectIds(list: unknown): ScopeParseResult {
  if (!Array.isArray(list)) return refuse(SCOPE_ERRORS.projectIdsNotArray);
  // Read ONCE and checked WITHOUT coercion before it sizes an allocation or bounds a loop: a genuine
  // array's length is always a non-negative safe integer. A proxy answering "0" would otherwise slip
  // past `=== 0` and `> 200`, drive both loops zero times and return an empty "valid" list.
  const length: unknown = list.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return refuse(SCOPE_ERRORS.projectIdsNotArray);
  }
  if (length === 0) return refuse(SCOPE_ERRORS.projectIdsEmpty);
  if (length > MAX_PROJECT_SCOPE) return refuse(SCOPE_ERRORS.projectIdsTooMany);

  // Holes are refused BEFORE the copy: an index must be an own element, not something the prototype
  // chain answers for (`hasOwn` reads no value, so each index value is still read exactly once below).
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(list, i)) return refuse(SCOPE_ERRORS.projectIdsNotUuids);
  }
  // Dense snapshot, by index.
  const snapshot: unknown[] = new Array<unknown>(length);
  for (let i = 0; i < length; i++) snapshot[i] = list[i];

  const canonical: string[] = [];
  for (let i = 0; i < length; i++) {
    const id = snapshot[i];
    if (typeof id !== "string" || !UUID_RE.test(id)) return refuse(SCOPE_ERRORS.projectIdsNotUuids);
    canonical.push(id.toLowerCase());
  }
  // Duplicates are checked on the CANONICAL spelling and refused, never silently deduplicated.
  if (new Set(canonical).size !== canonical.length) return refuse(SCOPE_ERRORS.projectIdsDuplicate);
  // A successful projects choice is never empty — the core stores this list as-is.
  if (canonical.length === 0) return refuse(SCOPE_ERRORS.projectIdsEmpty);
  return { ok: true, scope: { kind: "projects", projectIds: canonical } };
}

/**
 * Parse the scope choice of a mint request. Takes the WHOLE request because the legacy-key and
 * own-property rules are about the request itself: an own `projectScope` key is refused even when
 * its value is undefined/null and even beside a valid choice, and an inherited `scope` is not a
 * decision. Never throws on untrusted input (see WHY IT CATCHES above); returns normalized data the
 * caller must consume.
 */
export function parseTokenMintScope(request: unknown): ScopeParseResult {
  try {
    return parseScopeOf(request);
  } catch {
    return refuse(INVALID_REQUEST);
  }
}

function parseScopeOf(request: unknown): ScopeParseResult {
  if (!isRequestObject(request)) return refuse(INVALID_REQUEST);
  if (Object.hasOwn(request, "projectScope")) return refuse(SCOPE_ERRORS.legacyKey);
  if (!Object.hasOwn(request, "scope")) return refuse(SCOPE_ERRORS.required);

  const raw: unknown = request.scope;
  if (raw === undefined || raw === null) return refuse(SCOPE_ERRORS.required);
  if (!isRequestObject(raw)) return refuse(SCOPE_ERRORS.notObject);
  if (!Object.hasOwn(raw, "kind")) return refuse(SCOPE_ERRORS.badKind);

  const kind: unknown = raw.kind;
  const keys = Reflect.ownKeys(raw);
  if (kind === "all-reachable") {
    if (keys.length !== 1) return refuse(SCOPE_ERRORS.allReachableExtra);
    return { ok: true, scope: { kind: "all-reachable" } };
  }
  if (kind === "projects") {
    if (keys.some((k) => k !== "kind" && k !== "projectIds")) return refuse(SCOPE_ERRORS.projectsExtra);
    if (!Object.hasOwn(raw, "projectIds")) return refuse(SCOPE_ERRORS.projectIdsRequired);
    return parseProjectIds(raw.projectIds);
  }
  return refuse(SCOPE_ERRORS.badKind);
}

/** What `agent_tokens.project_scope` stores for a VALID choice: NULL, or the canonical copy. */
export function storedProjectScope(scope: TokenMintScope): string[] | null {
  return scope.kind === "projects" ? [...scope.projectIds] : null;
}
