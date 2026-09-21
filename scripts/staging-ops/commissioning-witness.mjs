/**
 * AIO-1124 F1 — the local policy witness protocol and its fixed Actions transport.
 *
 * ── THE PROBLEM THIS EXISTS TO SOLVE ────────────────────────────────────────────────────────────
 *
 * A protected actor job needs to know that the reviewed disposable policy is ACTUALLY in force on
 * its ref at the moment it mutates it — including the bypass matrix, which is the entire mechanism
 * the emergency App's acceptance depends on. But GitHub documents that `GET /repos/{repo}/rulesets/
 * {id}` returns `bypass_actors` only to a caller with WRITE access to the ruleset, and the actor jobs
 * hold `metadata: read` plus a read-only `GITHUB_TOKEN` by design. A 200 with a redacted body is
 * therefore not an incomplete read that might succeed next time; it is the documented response, and
 * feeding it to the production verifier produces a verdict about a policy nobody measured.
 *
 * The rejected alternatives, so nobody re-proposes one: granting the release Apps repository
 * Administration would give a release identity the power to rewrite the policy it is being tested
 * against; granting them `actions: write` to self-dispatch would let the subject trigger its own
 * examination; and a third attestor App is a new credential the spec forbids.
 *
 * ── WHAT THIS DOES INSTEAD, AND EXACTLY WHAT IT PROVES ──────────────────────────────────────────
 *
 * The existing LOCAL John identity already holds admin, so it is the only complete-policy measurement
 * authority in the system. It measures the full governed policy locally, and hands the measurement to
 * the protected job through a transport GitHub itself authenticates:
 *
 *   1. the actor job creates a fresh private 256-bit nonce and publishes a CHALLENGE artifact;
 *   2. the local witness reads it, measures the complete policy under admin, and dispatches this same
 *      reviewed workflow in `policy-witness` mode with a bounded RESPONSE envelope;
 *   3. one fixed non-protected publisher job — the only job that may run in that mode — republishes
 *      the response bytes as a single-entry artifact;
 *   4. the actor downloads it, binds it to its own nonce, and only then runs the verifier and mutates.
 *
 * GitHub authenticates the publisher's ACTOR, the immutable source it ran, and the artifact bytes. It
 * does NOT attest that John's report is true. What the protected case verifies is the complete
 * governed representation and its source/nonce/temporal binding.
 *
 * ⚠️ **This is a bounded contemporaneous pre/post measurement under administrative quiescence, NOT an
 * atomic policy-at-mutation proof.** An undetected transient policy change followed by restoration is
 * outside the guarantee, and no code here may be read as closing that gap. Root establishes a quiet
 * commissioning window; a known concurrent policy writer interrupts the run.
 *
 * Nothing here is a secret channel. The nonce is a ONE-USE CORRELATION VALUE whose artifact is
 * readable by anyone with Actions artifact access; the load-bearing facts are the authenticated
 * publisher identity, the immutable reviewed wiring and the exclusive publisher job. Publication is
 * an explicit narrow disclosure of the commissioning policies' nonsecret governed fields — see
 * {@link projectGovernedRuleset}, which refuses rather than redacts anything outside that closed set.
 *
 * node built-ins only, and no import from the runner: the dependency runs one way (runner → witness)
 * so each is testable without the other.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const WITNESS_SCHEMA_VERSION = 1;

export const CHALLENGE_KIND = "commissioning-witness-challenge";
export const RESPONSE_KIND = "commissioning-witness-response";

/** The workflow's CLOSED mode input. An unknown or empty mode is admitted by no job at all. */
export const WITNESS_MODES = Object.freeze(["commission", "policy-witness", "transport-rehearsal"]);

/**
 * The one authorized local administrative identity (PC-02/F6), by NUMERIC ID as well as login.
 *
 * A login is renameable and a login check alone accepted any admin; the numeric ID is the identity
 * GitHub will not reissue. Both are required, and so is `type: "User"` — an organization or App
 * identity answering `/user` is not the human this harness names.
 */
export const OWNER_LOGIN = "johnellison";
export const OWNER_USER_ID = 5806135;
export const OWNER_USER_TYPE = "User";

// ── Bounds. Every one of these fails CLOSED, and none of them is a promise about hosted capacity. ──

/** The whole serialized dispatch envelope, measured AFTER JSON serialization (crosscheck note). */
export const MAX_DISPATCH_ENVELOPE_BYTES = 60_000;
/** GitHub's documented `workflow_dispatch` input ceiling, for the record the bound sits under. */
export const PROVIDER_DISPATCH_INPUT_CEILING = 65_535;
export const MAX_ARCHIVE_BYTES = 128 * 1024;
export const MAX_ENTRY_BYTES = 60_000;
export const WITNESS_ENTRY_NAME = "witness.json";
/** 180s inclusive of Actions queue AND upload latency. Not extendable; not restampable. */
export const CHALLENGE_TTL_MS = 180_000;
/** The complete local policy read must span at most this, or the snapshot is not contemporaneous. */
export const MAX_POLICY_READ_SPAN_MS = 15_000;
/** Pre-snapshot completion → mutation start, and actor readback → post-snapshot start. */
export const MAX_OBSERVATION_TO_MUTATION_MS = 90_000;
export const POLL_INTERVAL_MS = 5_000;
export const MAX_WITNESS_PROCESS_MS = 30 * 60_000;
/** A bounded DISCOVERY ceiling — never permission to publish this many, nor to relax the exact count. */
export const PUBLISHER_DISCOVERY_CEILING = 64;
export const WITNESS_MAX_PAGES = 10;
export const WITNESS_PAGE_SIZE = 100;

export class WitnessRefusal extends Error {
  constructor(message, detail = null) { super(message); this.name = "WitnessRefusal"; this.exitCode = 1; this.detail = detail; }
}
export class WitnessIncomplete extends Error {
  constructor(message, detail = null) { super(message); this.name = "WitnessIncomplete"; this.exitCode = 3; this.detail = detail; }
}
export class WitnessUsageError extends Error {
  constructor(message) { super(message); this.name = "WitnessUsageError"; this.exitCode = 2; }
}

const NONCE = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const DECIMAL = /^[1-9][0-9]{0,17}$/;

/** Stable, key-sorted JSON. Every digest in the harness goes through this, so an ordering
 *  difference is never mistaken for a content one. Defined HERE and re-exported by the runner so
 *  there is exactly one implementation on both sides of the transport. */
export function canonicalJson(value) {
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, walk(input[key])]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export const canonicalHash = (value) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
export const bytesSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ──────────────────────────────────────────────────────────────────────────────
// 1. Artifact names. Derived on BOTH sides from values neither side supplies freely.
// ──────────────────────────────────────────────────────────────────────────────

const nameField = (value, label) => {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/.test(text)) throw new WitnessUsageError(`${label} is not a plain derived artifact name component`);
  return text;
};

/**
 * The CHALLENGE artifact's name. Deliberately carries NO nonce digest: the local witness has to be
 * able to derive the name it is waiting for before the nonce inside it exists. Uniqueness comes from
 * run/attempt/role/ordinal/direction, each of which is published exactly once per attempt.
 */
export function challengeArtifactName({ runId, attempt, role, ordinal, direction }) {
  if (!DECIMAL.test(String(runId)) || !DECIMAL.test(String(attempt))) throw new WitnessUsageError("a challenge artifact name needs the run ID and attempt");
  if (!["pre", "post"].includes(String(direction))) throw new WitnessUsageError("a challenge direction is pre or post");
  if (!Number.isInteger(Number(ordinal)) || Number(ordinal) < 0 || Number(ordinal) > 99) throw new WitnessUsageError("a challenge ordinal is a small non-negative integer");
  return formatChallengeArtifactName({ runId, attempt, role, ordinal, direction });
}

/**
 * The same NAME SHAPE, without the validation — the deliberately non-validating twin of
 * {@link challengeArtifactName}, in the pattern `evidenceFileName` already established.
 *
 * The workflow guard calls this with GitHub's expression strings (`${{ github.run_id }}`) so it can
 * compare the YAML's artifact names and paths against the one function that derives them. Every code
 * path that actually PUBLISHES or LOOKS UP a challenge goes through the validating name above.
 */
export function formatChallengeArtifactName({ runId, attempt, role, ordinal, direction }) {
  return `commissioning-challenge-${runId}-${attempt}-${nameField(role, "role")}-${String(Number(ordinal)).padStart(2, "0")}-${direction}`;
}

/**
 * The RESPONSE artifact's name, which DOES carry the nonce digest: the actor knows its own nonce, and
 * binding the name to it is what stops "select the latest artifact by name" from being possible at
 * all. `no overwrite` follows, because a second publication would need the same nonce.
 */
export function responseArtifactName({ runId, attempt, role, ordinal, direction, nonce }) {
  if (!NONCE.test(String(nonce ?? ""))) throw new WitnessUsageError("a response artifact name needs the challenge nonce");
  const digest = createHash("sha256").update(String(nonce), "utf8").digest("hex").slice(0, 16);
  return `commissioning-witness-${runId}-${attempt}-${nameField(role, "role")}-${String(Number(ordinal)).padStart(2, "0")}-${direction}-${digest}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. The narrow disclosure. A projection that REFUSES, never one that redacts.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Top-level ruleset fields that are provider TRANSPORT bookkeeping, excluded by an EXPLICIT list
 * rather than by "anything we do not recognise". Canonical: benign extra transport-only fields may be
 * excluded only through a list tested against provider fixtures; unknown fields default to refusal.
 */
export const EXCLUDED_RULESET_FIELDS = Object.freeze([
  "id", "node_id", "created_at", "updated_at", "_links", "links", "current_user_can_bypass",
  "source_type", "source", "bypass_response",
]);

/** The governed set — the five fields that carry policy MEANING, plus the name that identifies it. */
export const GOVERNED_FIELDS = Object.freeze(["name", "target", "enforcement", "conditions", "bypass_actors", "rules"]);

export const ENFORCEMENT_VALUES = Object.freeze(["active", "evaluate", "disabled"]);
export const RULESET_TARGETS = Object.freeze(["branch", "tag", "push", "repository"]);
export const RULESET_SOURCE_TYPES = Object.freeze(["Repository", "Organization"]);
export const BYPASS_ACTOR_TYPES = Object.freeze(["Integration", "OrganizationAdmin", "RepositoryRole", "Team", "DeployKey"]);
export const BYPASS_MODES = Object.freeze(["always", "pull_request"]);
export const MERGE_METHODS = Object.freeze(["merge", "squash", "rebase"]);

/**
 * The CLOSED typed parameter schema per governed rule type.
 *
 * These are GitHub's documented parameters, not the subset `buildMainRulesets` happens to send. The
 * difference matters and is deliberate: the provider EXPANDS defaults, so a faithful readback of our
 * `update` rule comes back carrying `update_allows_fetch_and_merge`. Allowing it here is what lets the
 * measurement be published at all; it does NOT make it equal to the desired policy — the production
 * verifier still reports that concrete difference as a `provider-normalization` gap, which is the
 * outcome the canonical revision asks for rather than a loosened verifier.
 */
export const GOVERNED_RULE_PARAMETERS = Object.freeze({
  non_fast_forward: Object.freeze({}),
  deletion: Object.freeze({}),
  creation: Object.freeze({}),
  required_linear_history: Object.freeze({}),
  required_signatures: Object.freeze({}),
  update: Object.freeze({ update_allows_fetch_and_merge: "boolean" }),
  pull_request: Object.freeze({
    required_approving_review_count: "integer",
    dismiss_stale_reviews_on_push: "boolean",
    require_code_owner_review: "boolean",
    require_last_push_approval: "boolean",
    required_review_thread_resolution: "boolean",
    automatic_copilot_code_review_enabled: "boolean",
    allowed_merge_methods: "merge-methods",
  }),
  required_status_checks: Object.freeze({
    strict_required_status_checks_policy: "boolean",
    do_not_enforce_on_create: "boolean",
    required_status_checks: "status-checks",
  }),
});

const isInteger = (value) => Number.isInteger(value);

/**
 * Project ONE provider ruleset into the publishable governed representation, or refuse.
 *
 * `allowed` is the closed vocabulary this projection may contain, all of it derived by the caller and
 * already disclosed in the credential-free intent: the exact generated ruleset names, the one derived
 * ref, the generated TEST-ONLY contexts, the real producer IDs, the planned bypass App IDs and the
 * fixed repository/organization source names.
 *
 * REFUSAL IS THE POINT. An unexpected bypass identity, an arbitrary team name, a condition we do not
 * govern or a rule parameter outside the closed schema stops the run BEFORE any witness dispatch. The
 * initial bounded commissioning may therefore refuse an additional inherited policy that might have
 * been compatible — it must not claim a compatibility it cannot safely publish.
 */
export function projectGovernedRuleset(ruleset, allowed) {
  const refuse = (why) => { throw new WitnessRefusal(`the measured policy cannot be published as a bounded governed projection: ${why}`); };
  if (!ruleset || typeof ruleset !== "object" || Array.isArray(ruleset)) refuse("a ruleset was not an object");

  const unknown = Object.keys(ruleset).filter((key) => !GOVERNED_FIELDS.includes(key) && !EXCLUDED_RULESET_FIELDS.includes(key));
  if (unknown.length) refuse(`ruleset carries the unrecognised field(s) ${unknown.sort().join(", ")}`);

  const name = String(ruleset.name ?? "");
  if (!allowed.rulesetNames.has(name)) refuse(`ruleset ${JSON.stringify(name)} is not one of the names this run generated`);
  if (!RULESET_TARGETS.includes(String(ruleset.target ?? ""))) refuse(`ruleset ${name} declares the unknown target ${JSON.stringify(String(ruleset.target ?? ""))}`);
  if (!ENFORCEMENT_VALUES.includes(String(ruleset.enforcement ?? ""))) refuse(`ruleset ${name} declares the unknown enforcement ${JSON.stringify(String(ruleset.enforcement ?? ""))}`);

  const conditions = ruleset.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) refuse(`ruleset ${name} carries no measurable conditions`);
  const conditionKeys = Object.keys(conditions);
  if (canonicalJson(conditionKeys.slice().sort()) !== canonicalJson(["ref_name"])) {
    refuse(`ruleset ${name} carries the ungoverned condition key(s) ${conditionKeys.filter((key) => key !== "ref_name").sort().join(", ") || "none"}`);
  }
  const refName = conditions.ref_name;
  if (!refName || typeof refName !== "object" || Array.isArray(refName)) refuse(`ruleset ${name} carries no ref_name condition`);
  const refKeys = Object.keys(refName).sort();
  if (refKeys.some((key) => !["include", "exclude"].includes(key))) refuse(`ruleset ${name}'s ref_name carries an ungoverned key`);
  const refList = (list, label) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) refuse(`ruleset ${name}'s ${label} is not a list`);
    for (const entry of list) {
      if (!allowed.refPatterns.has(String(entry))) refuse(`ruleset ${name} ${label}s the ref pattern ${JSON.stringify(String(entry))}, which this run did not derive`);
    }
    return list.map((entry) => String(entry));
  };

  const bypass = ruleset.bypass_actors === undefined || ruleset.bypass_actors === null ? [] : ruleset.bypass_actors;
  if (!Array.isArray(bypass)) refuse(`ruleset ${name} carries a bypass matrix that is not a list`);
  const bypassActors = bypass.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse(`ruleset ${name} carries a bypass actor that is not an object`);
    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.some((key) => !["actor_type", "actor_id", "bypass_mode"].includes(key))) {
      refuse(`ruleset ${name} carries a bypass actor with the ungoverned field(s) ${entryKeys.filter((k) => !["actor_type", "actor_id", "bypass_mode"].includes(k)).join(", ")}`);
    }
    const actorType = String(entry.actor_type ?? "");
    if (!BYPASS_ACTOR_TYPES.includes(actorType)) refuse(`ruleset ${name} carries the unknown bypass actor type ${JSON.stringify(actorType)}`);
    if (!BYPASS_MODES.includes(String(entry.bypass_mode ?? ""))) refuse(`ruleset ${name} carries the unknown bypass mode ${JSON.stringify(String(entry.bypass_mode ?? ""))}`);
    // The identity restriction the canonical revision states outright: only the exact planned App IDs
    // already disclosed in intent may be published. A team name or an admin-role bypass is not
    // publishable and is not silently dropped — it stops the run.
    if (actorType !== "Integration") refuse(`ruleset ${name} grants a ${actorType} bypass, which is outside the publishable identity set`);
    if (!isInteger(entry.actor_id) || !allowed.bypassAppIds.has(Number(entry.actor_id))) {
      refuse(`ruleset ${name} grants a bypass to App ${JSON.stringify(entry.actor_id ?? null)}, which is not one of the planned release identities`);
    }
    return { actor_type: actorType, actor_id: Number(entry.actor_id), bypass_mode: String(entry.bypass_mode) };
  });

  const rules = ruleset.rules === undefined || ruleset.rules === null ? [] : ruleset.rules;
  if (!Array.isArray(rules)) refuse(`ruleset ${name} carries a rule list that is not a list`);
  const projectedRules = rules.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) refuse(`ruleset ${name} carries a rule that is not an object`);
    const type = String(rule.type ?? "");
    const schema = GOVERNED_RULE_PARAMETERS[type];
    if (!schema) refuse(`ruleset ${name} carries the ungoverned rule type ${JSON.stringify(type)}`);
    const ruleKeys = Object.keys(rule).sort();
    if (ruleKeys.some((key) => !["type", "parameters"].includes(key))) refuse(`ruleset ${name}'s ${type} rule carries an ungoverned field`);
    if (rule.parameters === undefined || rule.parameters === null) return { type };
    const parameters = rule.parameters;
    if (typeof parameters !== "object" || Array.isArray(parameters)) refuse(`ruleset ${name}'s ${type} rule carries non-object parameters`);
    const projected = {};
    for (const [key, value] of Object.entries(parameters)) {
      const kind = schema[key];
      if (!kind) refuse(`ruleset ${name}'s ${type} rule carries the ungoverned parameter ${JSON.stringify(key)}`);
      if (kind === "boolean") {
        if (typeof value !== "boolean") refuse(`ruleset ${name}'s ${type}.${key} is not a boolean`);
        projected[key] = value;
      } else if (kind === "integer") {
        if (!isInteger(value)) refuse(`ruleset ${name}'s ${type}.${key} is not an integer`);
        projected[key] = value;
      } else if (kind === "merge-methods") {
        if (!Array.isArray(value) || value.some((method) => !MERGE_METHODS.includes(String(method)))) {
          refuse(`ruleset ${name}'s ${type}.${key} names a merge method outside the documented enum`);
        }
        projected[key] = value.map((method) => String(method));
      } else if (kind === "status-checks") {
        if (!Array.isArray(value)) refuse(`ruleset ${name}'s ${type}.${key} is not a list`);
        projected[key] = value.map((check) => {
          if (!check || typeof check !== "object" || Array.isArray(check)) refuse(`ruleset ${name} carries a required check that is not an object`);
          const checkKeys = Object.keys(check).sort();
          if (checkKeys.some((key2) => !["context", "integration_id"].includes(key2))) {
            refuse(`ruleset ${name} carries a required check with the ungoverned field(s) ${checkKeys.filter((k) => !["context", "integration_id"].includes(k)).join(", ")}`);
          }
          const context = String(check.context ?? "");
          if (!allowed.contexts.has(context)) refuse(`ruleset ${name} requires the context ${JSON.stringify(context)}, which this run did not generate`);
          if (!isInteger(check.integration_id) || !allowed.producerIds.has(Number(check.integration_id))) {
            refuse(`ruleset ${name} requires a check from producer ${JSON.stringify(check.integration_id ?? null)}, which is not a measured producer identity`);
          }
          return { context, integration_id: Number(check.integration_id) };
        });
      } else {
        refuse(`ruleset ${name}'s ${type}.${key} has no closed parameter kind`);
      }
    }
    return { type, parameters: projected };
  });

  const sourceType = String(ruleset.source_type ?? "");
  if (sourceType && !RULESET_SOURCE_TYPES.includes(sourceType)) refuse(`ruleset ${name} declares the unsupported source type ${JSON.stringify(sourceType)}`);
  const source = String(ruleset.source ?? "");
  if (source && !allowed.sources.has(source)) refuse(`ruleset ${name} names the source ${JSON.stringify(source)}, which is not one this run approved in intent`);

  return {
    id: isInteger(ruleset.id) ? Number(ruleset.id) : null,
    source_type: sourceType || null,
    source: source || null,
    governed: {
      name,
      target: String(ruleset.target),
      enforcement: String(ruleset.enforcement),
      conditions: { ref_name: { include: refList(refName.include, "include"), exclude: refList(refName.exclude, "exclude") } },
      bypass_actors: bypassActors,
      rules: projectedRules,
    },
  };
}

/**
 * The complete governed snapshot, plus the ONE classic-protection representation that may be published.
 *
 * A NON-EMPTY classic protection is not projectable: the canonical revision allows only "a measured
 * no-classic-protection 404 representation", so a present classic policy is recorded locally as a
 * mismatch or measurement-incomplete and stops before witness dispatch. That is a deliberate
 * narrowing of what the harness can measure, not a compatibility waiver.
 */
export function buildGovernedSnapshot({ rulesets, classicStatus, classicBody, allowed, startedAt, completedAt, pages, sourceIdentities }) {
  if (Number(classicStatus) !== 404) {
    throw new WitnessRefusal(
      `the tested branch reports classic protection (HTTP ${Number(classicStatus)}); only a measured no-classic-protection 404 representation is publishable, so this run stops before witness dispatch`,
      { classic_status: Number(classicStatus), classic_present: classicBody !== null && classicBody !== undefined },
    );
  }
  const span = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(span) || span < 0) throw new WitnessRefusal("the local policy observation has no measurable span");
  if (span > MAX_POLICY_READ_SPAN_MS) {
    throw new WitnessIncomplete(`the complete local policy read spanned ${span}ms, beyond the ${MAX_POLICY_READ_SPAN_MS}ms contemporaneity bound`);
  }
  const projected = rulesets.map((ruleset) => projectGovernedRuleset(ruleset, allowed));
  // Losslessness, proved rather than asserted: the raw digest travels with the projection, so a
  // reviewer can re-measure and a consumer can see that the governed set was not thinned to fit.
  const rawGoverned = rulesets.map((ruleset) => Object.fromEntries(GOVERNED_FIELDS.map((field) => [field, ruleset?.[field] ?? null])));
  const lossless = projected.map((entry) => entry.governed);
  return {
    started_at: startedAt,
    completed_at: completedAt,
    span_ms: span,
    applicability_pages: Number(pages) || 0,
    source_identities: [...new Set((sourceIdentities ?? []).map((entry) => String(entry)))].sort(),
    classic_protection: { present: false, status: 404 },
    governed_rulesets: projected,
    raw_governed_digest: canonicalHash(rawGoverned),
    projected_governed_digest: canonicalHash(lossless),
  };
}

/**
 * The consumer's half: re-validate a received snapshot against the same closed vocabulary.
 *
 * The actor cannot re-measure the policy — that is the whole reason the witness exists — but it CAN
 * refuse a projection that is not well-formed against a vocabulary it derives for itself, and it can
 * check the projection's own losslessness digest. What it must never do is accept a verdict or a bare
 * hash in place of the complete governed set; so a snapshot missing `governed_rulesets` is a refusal.
 */
export function validateGovernedSnapshot(snapshot, allowed) {
  const refuse = (why) => { throw new WitnessRefusal(`the witness snapshot is not usable policy evidence: ${why}`); };
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) refuse("it is not an object");
  if (snapshot.inert === true) refuse("it is an inert rehearsal observation and carries no policy measurement");
  const list = snapshot.governed_rulesets;
  if (!Array.isArray(list) || !list.length) refuse("it carries no complete governed ruleset set");
  const classic = snapshot.classic_protection;
  if (!classic || typeof classic !== "object" || classic.present !== false || Number(classic.status) !== 404) {
    refuse("it does not carry the measured no-classic-protection representation");
  }
  /**
   * The classic representation is CLOSED, and the source list is VOCABULARY-BOUND.
   *
   * Both were unchecked. `projectGovernedRuleset` closes a ruleset's own `source`, but nothing
   * looked at the snapshot-level `source_identities` list or at any key of `classic_protection`
   * beyond the two it reads — so an envelope could carry `classic_protection.arbitrary` and a
   * `source_identities` entry this run never approved, and both travelled into the published
   * artifact intact. That is the publication boundary the independent driver walked through.
   */
  assertClosedKeys(classic, ["present", "status"], "the witness snapshot's classic protection", refuse);
  const sources = snapshot.source_identities;
  if (!Array.isArray(sources)) refuse("it carries no measured source-identity list");
  for (const entry of sources) {
    if (!allowed.sources.has(String(entry))) {
      refuse(`it names the source ${JSON.stringify(String(entry))}, which is not one this run approved in intent`);
    }
  }
  const span = Number(snapshot.span_ms);
  if (!Number.isFinite(span) || span < 0 || span > MAX_POLICY_READ_SPAN_MS) refuse(`its observation span (${snapshot.span_ms}) is outside the contemporaneity bound`);
  const governed = list.map((entry) => {
    if (!entry || typeof entry !== "object") refuse("a projected ruleset is not an object");
    // Re-project the governed body through the same closed schema. A snapshot that would not survive
    // the projection is not a snapshot this consumer may reason about.
    return projectGovernedRuleset({ ...entry.governed, id: entry.id ?? undefined, source_type: entry.source_type ?? undefined, source: entry.source ?? undefined }, allowed).governed;
  });
  if (canonicalHash(governed) !== String(snapshot.projected_governed_digest)) {
    refuse("its projected governed digest does not match the governed set it carries");
  }
  if (!SHA256.test(String(snapshot.raw_governed_digest ?? ""))) refuse("it carries no digest of the raw measurement it was projected from");
  return { governed, classicProtection: null, classicMeasured: { present: false, status: 404 } };
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. The challenge and its response. Every binding is a field, and every field is checked.
// ──────────────────────────────────────────────────────────────────────────────

/** The identity fields a challenge and its response must agree about, exactly. */
export const BINDING_FIELDS = Object.freeze([
  "domain", "repository", "repository_id", "source_mode", "original_run_id", "original_attempt",
  "workflow_path", "source_sha", "role", "job_id", "case_id", "case_ordinal", "direction",
  "target_ref", "intended_app_id", "intended_installation_id", "manifest_sha256", "graph_sha256",
]);

/**
 * ── THE CLOSED PUBLICATION VOCABULARY (F11) ─────────────────────────────────────────────────────
 *
 * Every field a challenge or a response may carry, and nothing else. `assertResponseShape` accepted
 * ARBITRARY top-level properties and an arbitrary observation object, and `publishWitnessResponse`
 * then wrote the whole envelope verbatim — so a response carrying `unknown_top_level` and an
 * arbitrary provider property survived both validation and dispatch serialization and was published
 * as an artifact. That is a missing publication BOUNDARY, not a claim that the normal measured
 * projection leaks a real secret: the projection already refuses unknown governed fields, and this
 * closes the envelope around it so nothing can travel BESIDE the projection either.
 *
 * The rule the canonical states, and the one this encodes: never strip an unknown field to
 * manufacture compatibility. An unknown key REFUSES, before publication.
 */
const CHALLENGE_BASE_FIELDS = Object.freeze([
  "schema_version", "kind", ...BINDING_FIELDS, "nonce", "created_at", "expires_at",
]);
/** Both directions carry the ref state the case is about. */
const CHALLENGE_PRE_FIELDS = Object.freeze([...CHALLENGE_BASE_FIELDS, "before_sha", "requested_sha"]);
/** A post challenge additionally binds the request it followed and the pre-response it answers. */
const CHALLENGE_POST_FIELDS = Object.freeze([
  ...CHALLENGE_PRE_FIELDS,
  "request_class", "request_status", "readback_sha", "readback_at", "pre_artifact_id", "pre_artifact_digest",
]);
export const RESPONSE_FIELDS = Object.freeze([
  "schema_version", "kind", ...BINDING_FIELDS,
  "challenge_nonce", "challenge_digest", "challenge_expires_at", "observation", "witness_identity", "created_at",
]);
/** The measured governed observation. Exactly what {@link buildGovernedSnapshot} produces. */
export const OBSERVATION_FIELDS = Object.freeze([
  "started_at", "completed_at", "span_ms", "applicability_pages", "source_identities",
  "classic_protection", "governed_rulesets", "raw_governed_digest", "projected_governed_digest",
]);
/** The inert rehearsal observation. It carries NO policy measurement, and may not acquire one. */
export const INERT_OBSERVATION_FIELDS = Object.freeze(["started_at", "completed_at", "span_ms", "inert"]);
export const REQUEST_CLASSES = Object.freeze(["accepted", "refused", "ambiguous"]);

/** Refuse any key outside the closed set. The unknown key is NAMED, so the refusal is actionable. */
function assertClosedKeys(value, allowed, label, refuse) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) refuse(`${label} carries the field(s) ${unknown.sort().join(", ")}, which are outside its closed schema`);
}

const requireString = (value, label, pattern = null) => {
  const text = String(value ?? "");
  if (!text) throw new WitnessRefusal(`a commissioning challenge needs ${label}`);
  if (pattern && !pattern.test(text)) throw new WitnessRefusal(`${label} is not the expected shape`);
  return text;
};

/**
 * Build a challenge. `binding` is supplied entirely by the caller's own derivation — there is no
 * field here a remote party can set, and the nonce is freshly random per challenge.
 */
export function buildChallenge({ binding, nonce, createdAt, extra = {} }) {
  if (!NONCE.test(String(nonce ?? ""))) throw new WitnessUsageError("a challenge needs a fresh 256-bit hex nonce");
  const created = Date.parse(String(createdAt));
  if (!Number.isFinite(created)) throw new WitnessUsageError("a challenge needs a parseable creation timestamp");
  const challenge = {
    schema_version: WITNESS_SCHEMA_VERSION,
    kind: CHALLENGE_KIND,
    ...Object.fromEntries(BINDING_FIELDS.map((field) => [field, binding[field] ?? null])),
    ...extra,
    nonce: String(nonce),
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + CHALLENGE_TTL_MS).toISOString(),
  };
  assertChallengeShape(challenge);
  return challenge;
}

/** The shape rules both the witness and the publisher apply, independently, to the same bytes. */
export function assertChallengeShape(challenge) {
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) throw new WitnessRefusal("a challenge must be a JSON object");
  if (challenge.schema_version !== WITNESS_SCHEMA_VERSION) throw new WitnessRefusal("the challenge declares an unsupported schema version");
  if (challenge.kind !== CHALLENGE_KIND) throw new WitnessRefusal("the challenge does not declare itself a commissioning witness challenge");
  requireString(challenge.repository, "the challenge repository");
  if (!DECIMAL.test(String(challenge.repository_id ?? ""))) throw new WitnessRefusal("the challenge carries no numeric repository ID");
  if (!WITNESS_MODES.includes(String(challenge.source_mode))) throw new WitnessRefusal("the challenge declares an unknown source mode");
  if (!DECIMAL.test(String(challenge.original_run_id ?? "")) || !DECIMAL.test(String(challenge.original_attempt ?? ""))) {
    throw new WitnessRefusal("the challenge carries no original run identity");
  }
  requireString(challenge.workflow_path, "the challenge workflow path");
  requireString(challenge.source_sha, "the challenge immutable source SHA", FULL_SHA);
  requireString(challenge.role, "the challenge role");
  requireString(challenge.job_id, "the challenge job ID");
  requireString(challenge.case_id, "the challenge case ID");
  if (!Number.isInteger(challenge.case_ordinal) || challenge.case_ordinal < 0) throw new WitnessRefusal("the challenge carries no case ordinal");
  if (!["pre", "post"].includes(String(challenge.direction))) throw new WitnessRefusal("the challenge direction is pre or post");
  requireString(challenge.target_ref, "the challenge target");
  if (!NONCE.test(String(challenge.nonce ?? ""))) throw new WitnessRefusal("the challenge carries no 256-bit nonce");
  const created = Date.parse(String(challenge.created_at));
  const expires = Date.parse(String(challenge.expires_at));
  if (!Number.isFinite(created) || !Number.isFinite(expires)) throw new WitnessRefusal("the challenge carries no parseable lifetime");
  // Exactly the fixed TTL. A longer one is an extension, and extensions are how queue latency gets
  // concealed rather than reported.
  if (expires - created !== CHALLENGE_TTL_MS) throw new WitnessRefusal(`the challenge lifetime is not the fixed ${CHALLENGE_TTL_MS}ms`);
  const refuse = (why) => { throw new WitnessRefusal(why); };
  // CLOSED, per direction. An extra top-level field on a challenge is refused here, before the
  // local witness ever measures anything on its behalf.
  assertClosedKeys(challenge, challenge.direction === "post" ? CHALLENGE_POST_FIELDS : CHALLENGE_PRE_FIELDS, "the challenge", refuse);
  if (challenge.domain === "commission") {
    requireString(challenge.manifest_sha256, "the challenge manifest digest", SHA256);
    requireString(challenge.graph_sha256, "the challenge graph digest", SHA256);
    requireString(challenge.target_ref, "the challenge derived ref", /^refs\/heads\/aios-policy-commissioning\//);
    if (challenge.direction === "post") {
      if (!Number.isInteger(challenge.request_status)) throw new WitnessRefusal("a post challenge must carry the measured request status");
      if (!REQUEST_CLASSES.includes(String(challenge.request_class))) {
        throw new WitnessRefusal(`a post challenge's request class is one of ${REQUEST_CLASSES.join("/")}, not ${JSON.stringify(String(challenge.request_class ?? ""))}`);
      }
      requireString(challenge.pre_artifact_digest, "the post challenge pre-response digest", SHA256);
      // The pre-response artifact's own POSITIVE identity, so the post challenge names the exact
      // publication it followed rather than merely a digest that could belong to anything.
      if (!Number.isInteger(challenge.pre_artifact_id) || challenge.pre_artifact_id <= 0) {
        throw new WitnessRefusal("a post challenge must name the positive provider ID of the pre-response artifact it followed");
      }
      const readbackAt = Date.parse(String(challenge.readback_at ?? ""));
      if (!Number.isFinite(readbackAt)) throw new WitnessRefusal("a post challenge must carry a parseable readback timestamp");
      // Temporal ordering, complete: the readback happened before this challenge was created.
      if (readbackAt > Date.parse(String(challenge.created_at))) {
        throw new WitnessRefusal("a post challenge claims a readback that happened after the challenge was created; the ordering is impossible");
      }
    }
  } else if (challenge.domain === "rehearsal") {
    // The inert variant. It deliberately has NO synthetic graph, ref or resource journal to bind —
    // requiring one is what would have made the rehearsal impossible before the resources exist.
    if (challenge.target_ref !== "rehearsal") throw new WitnessRefusal("a rehearsal challenge's target is the literal inert `rehearsal`");
    if (challenge.manifest_sha256 !== null || challenge.graph_sha256 !== null) {
      throw new WitnessRefusal("a rehearsal challenge must not claim a synthetic manifest or graph");
    }
    if (challenge.source_mode !== "transport-rehearsal") throw new WitnessRefusal("a rehearsal challenge must come from a transport-rehearsal source run");
  } else {
    throw new WitnessRefusal(`the challenge declares the unknown domain ${JSON.stringify(String(challenge.domain ?? ""))}`);
  }
  return challenge;
}

/** Build the response the local witness dispatches. Its observation timestamps are the measurer's. */
export function buildResponse({ challenge, challengeDigest, observation, witnessIdentity, createdAt }) {
  assertChallengeShape(challenge);
  if (!SHA256.test(String(challengeDigest ?? ""))) throw new WitnessUsageError("a response must bind the exact challenge bytes it answers");
  const created = Date.parse(String(createdAt));
  if (!Number.isFinite(created)) throw new WitnessUsageError("a response needs a parseable creation timestamp");
  const response = {
    schema_version: WITNESS_SCHEMA_VERSION,
    kind: RESPONSE_KIND,
    ...Object.fromEntries(BINDING_FIELDS.map((field) => [field, challenge[field] ?? null])),
    challenge_nonce: String(challenge.nonce),
    challenge_digest: String(challengeDigest),
    challenge_expires_at: String(challenge.expires_at),
    observation,
    witness_identity: {
      login: String(witnessIdentity?.login ?? ""),
      user_id: Number(witnessIdentity?.user_id ?? 0),
      type: String(witnessIdentity?.type ?? ""),
    },
    created_at: new Date(created).toISOString(),
  };
  assertResponseShape(response);
  return response;
}

/**
 * THE CLOSED RESPONSE SCHEMA (F11). One validator, applied by the publisher BEFORE publication, by
 * every consumer, and by the final assessor on the retained bytes.
 *
 * `domain` is optional and, when supplied, pins which observation variant is acceptable — the
 * rehearsal's inert one or the commissioning measurement. A caller that does not know the domain
 * still gets the closed key set, the derived identifiers and the temporal ordering.
 */
export function assertResponseShape(response, { domain = null } = {}) {
  const refuse = (why) => { throw new WitnessRefusal(why); };
  if (!response || typeof response !== "object" || Array.isArray(response)) refuse("a witness response must be a JSON object");
  if (response.schema_version !== WITNESS_SCHEMA_VERSION) refuse("the witness response declares an unsupported schema version");
  if (response.kind !== RESPONSE_KIND) refuse("the payload does not declare itself a commissioning witness response");
  // CLOSED. Nothing may travel beside the governed projection.
  assertClosedKeys(response, RESPONSE_FIELDS, "the witness response", refuse);
  if (!NONCE.test(String(response.challenge_nonce ?? ""))) refuse("the witness response binds no challenge nonce");
  if (!SHA256.test(String(response.challenge_digest ?? ""))) refuse("the witness response binds no exact challenge bytes");
  const createdAt = Date.parse(String(response.created_at));
  const expiresAt = Date.parse(String(response.challenge_expires_at));
  if (!Number.isFinite(createdAt)) refuse("the witness response carries no parseable creation time");
  if (!Number.isFinite(expiresAt)) refuse("the witness response carries no challenge expiry");

  // THE BINDING FIELDS, with EXACT derived shapes rather than mere presence. A response whose role
  // or ordinal is a string where the consumer derives a number binds nothing on that field.
  if (!DECIMAL.test(String(response.repository_id ?? ""))) refuse("the witness response carries no numeric repository ID");
  if (!DECIMAL.test(String(response.original_run_id ?? "")) || !DECIMAL.test(String(response.original_attempt ?? ""))) {
    refuse("the witness response carries no original run identity");
  }
  if (!WITNESS_MODES.includes(String(response.source_mode))) refuse("the witness response declares an unknown source mode");
  if (!FULL_SHA.test(String(response.source_sha ?? ""))) refuse("the witness response carries no immutable source SHA");
  if (!["pre", "post"].includes(String(response.direction))) refuse("the witness response's direction is pre or post");
  if (!Number.isInteger(response.case_ordinal) || response.case_ordinal < 0) refuse("the witness response carries no case ordinal");
  for (const field of ["repository", "workflow_path", "role", "job_id", "case_id", "target_ref", "domain"]) {
    if (typeof response[field] !== "string" || !response[field]) refuse(`the witness response carries no ${field}`);
  }

  const identity = response.witness_identity;
  // The measuring authority is named, by numeric ID: the whole trust story is "authenticated local
  // John measured this", so a response that does not say which identity measured it is unusable.
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) refuse("the witness response carries no measuring identity");
  assertClosedKeys(identity, ["login", "user_id", "type"], "the witness response's identity", refuse);
  if (Number(identity.user_id) !== OWNER_USER_ID || String(identity.login) !== OWNER_LOGIN || String(identity.type) !== OWNER_USER_TYPE) {
    refuse("the witness response does not name the one authorized local measuring identity");
  }

  const observation = response.observation;
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) refuse("the witness response carries no observation");
  const inert = observation.inert === true;
  if (domain === "rehearsal" && !inert) refuse("a rehearsal response must carry the inert observation variant; a rehearsal produces no policy measurement");
  if (domain === "commission" && inert) refuse("a commissioning response must carry a measured governed observation, not the inert rehearsal variant");
  assertClosedKeys(observation, inert ? INERT_OBSERVATION_FIELDS : OBSERVATION_FIELDS, "the witness observation", refuse);
  // ACTUAL FINITE TIMESTAMPS, not values that coerce. `Number(null)` is 0 and `Date.parse` of a
  // missing field is NaN; both have to be refusals here rather than measurements downstream.
  const startedAt = Date.parse(String(observation.started_at));
  const completedAt = Date.parse(String(observation.completed_at));
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) refuse("the witness observation carries no parseable measurement window");
  if (completedAt < startedAt) refuse("the witness observation completed before it started; the ordering is impossible");
  if (typeof observation.span_ms !== "number" || !Number.isFinite(observation.span_ms) || observation.span_ms < 0) {
    refuse("the witness observation carries no finite measured span");
  }
  if (completedAt - startedAt !== observation.span_ms) refuse("the witness observation's span does not describe its own measurement window");
  // The observation was made before the response that reports it, and inside the challenge's life.
  if (startedAt > createdAt) refuse("the witness observation claims to have started after the response reporting it was created");
  if (!inert) {
    if (!Array.isArray(observation.governed_rulesets) || !observation.governed_rulesets.length) {
      refuse("the witness observation carries no complete governed ruleset set");
    }
    if (!SHA256.test(String(observation.raw_governed_digest ?? "")) || !SHA256.test(String(observation.projected_governed_digest ?? ""))) {
      refuse("the witness observation carries no digests of the measurement it was projected from");
    }
  }
  return response;
}

/**
 * Bind a received response to the challenge THIS process created, and to nothing else.
 *
 * `expectedBinding` is the consumer's own derivation. Every binding field must agree, the nonce must
 * be the consumer's private one, and the digest must be of the consumer's exact challenge bytes — so
 * a response answering some other case, direction, role or attempt cannot be consumed here even if it
 * is a perfectly valid response to that other challenge.
 */
export function assertResponseBinding(response, { challenge, challengeDigest, expectedBinding, receivedAt }) {
  assertResponseShape(response);
  if (String(response.challenge_nonce) !== String(challenge.nonce)) throw new WitnessRefusal("the witness response answers a nonce this job did not create");
  if (String(response.challenge_digest) !== String(challengeDigest)) throw new WitnessRefusal("the witness response answers challenge bytes this job did not publish");
  for (const field of BINDING_FIELDS) {
    const wanted = expectedBinding[field] ?? null;
    const actual = response[field] ?? null;
    if (canonicalJson(wanted) !== canonicalJson(actual)) {
      throw new WitnessRefusal(`the witness response's ${field} is not the value this job derived for it`);
    }
  }
  const received = Date.parse(String(receivedAt));
  const created = Date.parse(String(response.created_at));
  const expires = Date.parse(String(challenge.expires_at));
  if (!Number.isFinite(received)) throw new WitnessUsageError("a response receipt needs a parseable timestamp");
  // NO positive clock-skew allowance. A response created before its challenge is an impossible
  // ordering, and "impossible" is a refusal rather than a tolerance to widen.
  if (created + 1 < Date.parse(String(challenge.created_at))) throw new WitnessRefusal("the witness response predates the challenge it answers; the ordering is impossible");
  if (received > expires) {
    throw new WitnessIncomplete(
      `the witness response arrived after its ${CHALLENGE_TTL_MS}ms challenge expiry; the measurement is incomplete and the expiry is never extended`,
    );
  }
  return true;
}

/** The two 90-second sequencing bounds, applied by whichever side owns both timestamps. */
export function assertObservationProximity({ observedAt, actedAt, label }) {
  const observed = Date.parse(String(observedAt));
  const acted = Date.parse(String(actedAt));
  if (!Number.isFinite(observed) || !Number.isFinite(acted)) throw new WitnessIncomplete(`${label} cannot be ordered against its observation`);
  if (acted < observed) throw new WitnessRefusal(`${label} is recorded before the observation it depends on; the ordering is impossible`);
  if (acted - observed > MAX_OBSERVATION_TO_MUTATION_MS) {
    throw new WitnessIncomplete(`${label} happened ${acted - observed}ms after its observation, beyond the ${MAX_OBSERVATION_TO_MUTATION_MS}ms bound`);
  }
  return acted - observed;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. The dispatch envelope, bounded after serialization.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a response into the exact dispatch input string and prove it fits.
 *
 * The bound is measured on the WHOLE serialized envelope including JSON overhead — the crosscheck's
 * explicit note — because bounding only the inner witness string is how a payload that fits in the
 * check fails at the provider.
 */
export function serializeDispatchEnvelope({ response, mode = "policy-witness" }) {
  if (mode !== "policy-witness") throw new WitnessUsageError("a witness dispatch runs only in policy-witness mode");
  assertResponseShape(response);
  const witness = JSON.stringify(response);
  const inputs = { mode, witness_envelope: witness };
  const serialized = JSON.stringify({ ref: "staging", inputs });
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_DISPATCH_ENVELOPE_BYTES) {
    throw new WitnessIncomplete(
      `the serialized witness dispatch envelope is ${bytes} bytes, beyond this harness's ${MAX_DISPATCH_ENVELOPE_BYTES}-byte bound (provider ceiling ${PROVIDER_DISPATCH_INPUT_CEILING})`,
      { bytes },
    );
  }
  return { witness, inputs, serialized, bytes, digest: bytesSha256(Buffer.from(witness, "utf8")) };
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. A bounded, single-entry ZIP reader. Written here because an artifact download is an ARCHIVE,
//    and "trust the archive" is the one thing a transport must never do.
// ──────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Read EXACTLY ONE expected entry out of an artifact archive, or refuse.
 *
 * Every refusal below is an archive attack this transport would otherwise carry into a protected job:
 * a second entry (which one did the publisher mean?), a nested archive, a traversal or absolute path,
 * a symlink entry, a zip64 size marker, an encrypted entry, a declared size beyond the bound, and a
 * CRC that does not match the bytes. `inflateRawSync` is node's own; there is no new dependency.
 */
export function readSingleEntryZip(buffer, { entryName = WITNESS_ENTRY_NAME, maxArchiveBytes = MAX_ARCHIVE_BYTES, maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  const refuse = (why) => { throw new WitnessRefusal(`the witness artifact archive is not acceptable: ${why}`); };
  if (!Buffer.isBuffer(buffer)) throw new WitnessUsageError("an archive read needs the downloaded bytes");
  if (buffer.length === 0) refuse("it is empty");
  if (buffer.length > maxArchiveBytes) refuse(`it is ${buffer.length} bytes, beyond the ${maxArchiveBytes}-byte bound`);

  // The End Of Central Directory record, found from the end. A comment is refused outright, so the
  // scan is a fixed 22-byte read rather than a search over attacker-chosen bytes.
  const eocd = buffer.length - 22;
  if (eocd < 0 || buffer.readUInt32LE(eocd) !== 0x06054b50) refuse("it has no end-of-central-directory record at the fixed offset (a comment or trailing bytes are refused)");
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) refuse("it spans multiple disks");
  const entriesHere = buffer.readUInt16LE(eocd + 8);
  const entriesTotal = buffer.readUInt16LE(eocd + 10);
  if (entriesHere !== 1 || entriesTotal !== 1) refuse(`it declares ${entriesTotal} entries; exactly one is expected`);
  if (buffer.readUInt16LE(eocd + 20) !== 0) refuse("it carries an archive comment");
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) refuse("its central directory is outside the archive");

  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) refuse("its central directory entry has no signature");
  const flags = buffer.readUInt16LE(centralOffset + 8);
  if (flags & 0x1) refuse("its entry is encrypted");
  const method = buffer.readUInt16LE(centralOffset + 10);
  if (method !== 0 && method !== 8) refuse(`its entry uses compression method ${method}; only store and deflate are accepted`);
  const declaredCrc = buffer.readUInt32LE(centralOffset + 16);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) refuse("its entry declares zip64 sizes");
  if (uncompressedSize > maxEntryBytes) refuse(`its entry declares ${uncompressedSize} uncompressed bytes, beyond the ${maxEntryBytes}-byte bound`);
  const nameLength = buffer.readUInt16LE(centralOffset + 28);
  const extraLength = buffer.readUInt16LE(centralOffset + 30);
  const commentLength = buffer.readUInt16LE(centralOffset + 32);
  if (commentLength !== 0) refuse("its entry carries a comment");
  const externalAttributes = buffer.readUInt32LE(centralOffset + 38);
  // The unix mode lives in the high 16 bits. `0xA000` is S_IFLNK: an artifact entry that is a symlink
  // would be a pointer at the runner's filesystem rather than a document.
  if (((externalAttributes >>> 16) & 0xf000) === 0xa000) refuse("its entry is a symbolic link");
  const name = buffer.slice(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
  if (name !== entryName) refuse(`its single entry is ${JSON.stringify(name)}, not ${JSON.stringify(entryName)}`);
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.startsWith("/")) refuse("its entry name is a path rather than a plain file name");
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (localOffset + 30 > buffer.length) refuse("its local header is outside the archive");
  if (centralOffset + 46 + nameLength + extraLength + commentLength > buffer.length) refuse("its central directory entry overruns the archive");

  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) refuse("its local file header has no signature");
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const localName = buffer.slice(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
  if (localName !== entryName) refuse("its local header names a different entry from its central directory");
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  if (dataStart + compressedSize > buffer.length) refuse("its entry data is outside the archive");
  const raw = buffer.slice(dataStart, dataStart + compressedSize);

  let content;
  if (method === 0) content = Buffer.from(raw);
  else {
    try { content = inflateRawSync(raw, { maxOutputLength: maxEntryBytes }); }
    catch { refuse("its entry could not be inflated within the entry bound"); }
  }
  if (content.length !== uncompressedSize) refuse("its inflated entry is not the size the archive declares");
  if (crc32(content) !== declaredCrc) refuse("its entry's CRC does not match the bytes it carries");
  return { name, bytes: content, digest: bytesSha256(content) };
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. The publisher. The ONLY job that may run in `policy-witness` mode.
// ──────────────────────────────────────────────────────────────────────────────

export const WITNESS_JOB_ID = "policy-witness";
export const REHEARSAL_JOB_ID = "transport-rehearsal";
/** The rehearsal's response DOMAIN, named here so the publisher can pin the observation variant. */
const REHEARSAL_RESPONSE_DOMAIN = "rehearsal";

/**
 * Every provider fact the publisher must hold before it republishes a single byte.
 *
 * `actor` AND `triggering_actor` both, because they differ: a re-run keeps the original actor while
 * the triggering actor becomes whoever re-ran it, and the whole authority of this transport is that
 * the run was created by the authenticated local John. `run_attempt` must be 1 for the same reason —
 * a re-run of a publisher is a second publication of a nonce that was consumed once.
 */
export function assertPublisherContext({ env, run, expected }) {
  const refuse = (why) => { throw new WitnessRefusal(`the witness publisher refuses to publish: ${why}`); };
  const need = (name) => {
    const value = String(env?.[name] ?? "").trim();
    if (!value) throw new WitnessUsageError(`${name} is required in the witness publisher job`);
    return value;
  };
  if (need("GITHUB_REPOSITORY") !== expected.repository) refuse("it is not running in the fixed commissioning repository");
  if (need("GITHUB_EVENT_NAME") !== "workflow_dispatch") refuse("it was not dispatched manually");
  if (need("GITHUB_REF") !== expected.dispatchRef) refuse("it was not dispatched from the fixed staging branch");
  if (need("GITHUB_JOB") !== WITNESS_JOB_ID) refuse(`it is running as job ${JSON.stringify(String(env?.GITHUB_JOB ?? ""))}, not the fixed ${WITNESS_JOB_ID} job`);
  if (need("GITHUB_WORKFLOW_REF") !== `${expected.repository}/${expected.workflowPath}@${expected.dispatchRef}`) {
    refuse("it is not the reviewed commissioning workflow at the fixed dispatch ref");
  }
  if (need("GITHUB_RUN_ATTEMPT") !== "1") refuse("it is a re-run; a publisher re-run would republish a nonce that was consumed once");
  const sourceSha = need("GITHUB_SHA");
  if (!FULL_SHA.test(sourceSha)) refuse("its immutable source SHA is not a full commit SHA");

  // The API-measured identities, from the run this job belongs to. `GITHUB_ACTOR` alone is an
  // environment variable; these are the provider's own record.
  if (!run || typeof run !== "object") throw new WitnessIncomplete("the witness publisher could not measure its own run");
  for (const field of ["actor", "triggering_actor"]) {
    const identity = run[field];
    if (!identity || Number(identity.id) !== OWNER_USER_ID || String(identity.login) !== OWNER_LOGIN || String(identity.type) !== OWNER_USER_TYPE) {
      refuse(`its measured ${field} is not the one authorized local identity`);
    }
  }
  if (String(run.event) !== "workflow_dispatch") refuse("its measured event is not workflow_dispatch");
  if (String(run.path) !== expected.workflowPath) refuse("its measured workflow path is not the reviewed commissioning workflow");
  if (String(run.head_sha) !== sourceSha) refuse("its measured head SHA is not the immutable source it checked out");
  if (Number(run.run_attempt) !== 1) refuse("its measured run attempt is not 1");
  return { sourceSha, publisherRunId: String(env.GITHUB_RUN_ID ?? "") };
}

/**
 * Read the witness envelope as DATA from the event payload.
 *
 * Never interpolated into a shell command, a script or a logged environment block: the workflow hands
 * this job a path, and the job reads and parses the file with fixed checked-out code. That is the
 * difference between an input and an instruction.
 */
export function readWitnessEnvelopeFromEvent(eventJson) {
  let event;
  try { event = JSON.parse(String(eventJson)); }
  catch { throw new WitnessRefusal("the dispatch event payload is not valid JSON"); }
  const inputs = event?.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new WitnessRefusal("the dispatch event carries no inputs object");
  if (String(inputs.mode) !== "policy-witness") throw new WitnessRefusal("the publisher was reached by a dispatch whose mode is not policy-witness");
  const envelope = inputs.witness_envelope;
  if (typeof envelope !== "string" || !envelope.trim()) throw new WitnessRefusal("the dispatch carries no witness envelope string");
  if (Buffer.byteLength(envelope, "utf8") > MAX_DISPATCH_ENVELOPE_BYTES) throw new WitnessRefusal("the witness envelope exceeds the bounded dispatch size");
  let response;
  try { response = JSON.parse(envelope); }
  catch { throw new WitnessRefusal("the witness envelope is not valid JSON"); }
  assertResponseShape(response);
  return { response, envelope };
}

/**
 * The publisher's whole job: validate, then write the EXACT received bytes as `witness.json` and
 * report the derived artifact name for the fixed upload step.
 *
 * It re-serializes nothing. The digest the actor and the local witness cross-check is the digest of
 * these bytes, so a publisher that pretty-printed or re-ordered the payload would break the binding
 * it exists to carry — and it holds no App secret, no protected environment and no write scope with
 * which it could do anything else.
 */
/**
 * Everything the publisher must know about the ORIGINAL run before it republishes a byte (F11).
 *
 * The publisher read only its OWN run. The spec requires it to validate the original commissioning
 * run/attempt/source and the closed challenge subject from provider metadata — which is a
 * different question: "was I dispatched correctly" says nothing about whether the subject inside
 * the envelope is a run that exists, ran the reviewed workflow at this same immutable source, and
 * was created by the authorized identity. `originalRun` is the provider's record of the run named
 * INSIDE the envelope, fetched by the caller through the guarded transport.
 */
export function assertOriginalSubject({ response, originalRun, expected }) {
  const refuse = (why) => { throw new WitnessRefusal(`the witness publisher refuses to publish: ${why}`); };
  if (!originalRun || typeof originalRun !== "object") {
    throw new WitnessIncomplete("the witness publisher could not measure the original run its envelope names");
  }
  if (String(originalRun.path) !== expected.workflowPath) refuse("the envelope's original run is not the reviewed commissioning workflow");
  if (String(originalRun.event) !== "workflow_dispatch") refuse("the envelope's original run was not dispatched manually");
  if (String(originalRun.head_sha) !== String(expected.sourceSha)) {
    refuse("the envelope's original run did not run the immutable source this publisher ran");
  }
  if (String(originalRun.head_branch ?? "") !== expected.dispatchBranch) refuse("the envelope's original run was not dispatched from the fixed staging branch");
  if (Number(originalRun.run_attempt) !== Number(response.original_attempt)) {
    refuse("the envelope's original attempt is not the attempt the provider records for that run");
  }
  /**
   * ⚠️ THE ORIGINAL RUN'S ACTOR IS DELIBERATELY *NOT* REQUIRED TO BE JOHN.
   *
   * The PUBLISHER's own run must be John's — the local witness dispatches it with John's `gh`
   * credential, and that is what the transport's authority rests on. The ORIGINAL commissioning
   * run is a different thing: PC-02 has the optional dispatcher App trigger it precisely SO THAT
   * John can approve the protected environments without self-reviewing, and PC-06 then requires
   * the reviewer to be an identity distinct from the measured dispatcher. Requiring John here
   * would make the reviewed no-self-review design impossible to satisfy.
   *
   * So the identity is MEASURED AND RECORDED rather than constrained, and the checks above bind
   * what the canonical actually asks the publisher to validate: the original run's workflow,
   * event, immutable source, dispatch branch and attempt.
   */
  const identity = (value) => (value && typeof value === "object"
    ? { login: String(value.login ?? "unknown"), id: Number.isInteger(Number(value.id)) ? Number(value.id) : null, type: String(value.type ?? "unknown") }
    : null);
  return {
    original_run_id: String(response.original_run_id),
    original_attempt: String(response.original_attempt),
    original_head_sha: String(originalRun.head_sha),
    // Recorded for the approval evidence's self-review comparison, never used as an admission here.
    original_dispatcher: identity(originalRun.actor),
    original_triggering_actor: identity(originalRun.triggering_actor),
    original_subject_measured: true,
  };
}

export function publishWitnessResponse({ response, envelope, expected, publisherRunId, originalRun = null, writeEntry, allowed = null }) {
  const original = { runId: String(response.original_run_id), attempt: String(response.original_attempt) };
  // THE CLOSED SCHEMA, before anything is written. The bytes are published verbatim, so this is the
  // one place a field outside the closed vocabulary can be stopped from reaching an artifact.
  const rehearsal = String(response.domain ?? "") === REHEARSAL_RESPONSE_DOMAIN;
  assertResponseShape(response, { domain: rehearsal ? "rehearsal" : "commission" });
  if (String(response.repository) !== expected.repository) throw new WitnessRefusal("the witness envelope names another repository");
  if (String(response.workflow_path) !== expected.workflowPath) throw new WitnessRefusal("the witness envelope names another workflow");
  if (!expected.sourceSha || String(response.source_sha) !== String(expected.sourceSha)) {
    throw new WitnessRefusal("the witness envelope's immutable source is not the source this publisher ran");
  }
  // THE ORIGINAL SUBJECT, from provider metadata rather than from the envelope's own claims.
  const subject = assertOriginalSubject({ response, originalRun, expected });
  /**
   * ── THE NESTED GOVERNED CONTRACT, ALSO BEFORE THE BYTES (F11, corrected) ────────────────────────
   *
   * `assertResponseShape` closes the response's TOP-LEVEL keys and the observation's OWN keys. It
   * does not descend into `governed_rulesets[].governed`, and it never looked at
   * `source_identities` or at the key set of `classic_protection`. So the publisher — the one hop
   * that turns a private measurement into an artifact anyone with Actions access can read — wrote
   * an envelope carrying an arbitrary nested field verbatim. The independent driver published a
   * sentinel through exactly this path.
   *
   * `allowed` is the closed vocabulary the CALLER derived from the AUTHENTICATED intent artifact of
   * the original run. It is required for a commissioning publication and must not be inferred from
   * the envelope: the planned App identities are the whole point, and an envelope cannot be its own
   * authority for which Apps may appear in it.
   *
   * The inert rehearsal carries no policy measurement and has no commissioning intent by design, so
   * it is excluded here — and a MISSING intent in the commissioning domain is a refusal, never a
   * fall-back to rehearsal semantics.
   */
  if (!rehearsal) {
    if (!allowed) {
      throw new WitnessIncomplete(
        "the witness publisher has no authenticated intent vocabulary to validate this commissioning observation against; it refuses rather than publishing an unvalidated governed projection",
      );
    }
    validateGovernedSnapshot(response.observation, allowed);
  }
  const bytes = Buffer.from(envelope, "utf8");
  const name = responseArtifactName({
    runId: original.runId, attempt: original.attempt, role: String(response.role),
    ordinal: Number(response.case_ordinal), direction: String(response.direction), nonce: String(response.challenge_nonce),
  });
  const written = writeEntry(WITNESS_ENTRY_NAME, bytes);
  return {
    schema_version: WITNESS_SCHEMA_VERSION,
    phase: "policy-witness",
    status: "published",
    artifact_name: name,
    entry: WITNESS_ENTRY_NAME,
    entry_path: written,
    entry_bytes: bytes.length,
    entry_digest: bytesSha256(bytes),
    publisher_run_id: publisherRunId,
    original_run_id: original.runId,
    original_attempt: original.attempt,
    role: String(response.role),
    case_id: String(response.case_id),
    case_ordinal: Number(response.case_ordinal),
    direction: String(response.direction),
    domain: String(response.domain),
    original_subject: subject,
    note: "The provider authenticates this publisher's actor, immutable source and artifact bytes. It does not attest that the measurement inside is true.",
  };
}

/**
 * Pin a candidate response artifact to its OWNING RUN, and refuse anything ambiguous.
 *
 * Artifact metadata does not attest a producing job ID or attempt, and this function does not pretend
 * otherwise: the trust is the reviewed immutable workflow's exclusive upload wiring, the API's run and
 * job state, and the actor's private nonce. Numeric job IDs are reported for CORRELATION, never as
 * cryptographic provenance.
 */
export function assertPublisherArtifactProvenance({ artifact, run, jobs, expected }) {
  const refuse = (why) => { throw new WitnessRefusal(`the witness artifact's provenance is not acceptable: ${why}`); };
  if (!artifact || typeof artifact !== "object") throw new WitnessIncomplete("the witness artifact could not be measured");
  if (artifact.expired === true) throw new WitnessIncomplete("the witness artifact has expired");
  if (!Number.isInteger(Number(artifact.id))) refuse("it has no numeric provider ID");
  const owningRun = Number(artifact.workflow_run?.id);
  if (!Number.isInteger(owningRun)) refuse("it names no owning run");
  if (!run || Number(run.id) !== owningRun) throw new WitnessIncomplete("the witness artifact's owning run could not be measured");

  // ── THE BINDING CHECKS COME FIRST, and every one of them is TERMINAL ────────────────────────────
  //
  // Ordering matters here (F10). A wrong-source, wrong-actor, re-run or wrong-workflow publisher is
  // refused OUTRIGHT whatever state it is in — waiting for a run that will never be acceptable is
  // just a slower refusal, and re-reading it would be waiting for somebody to publish a better one.
  if (Number(run.run_attempt) !== 1) refuse("its publisher run is a re-run");
  if (String(run.event) !== "workflow_dispatch") refuse("its publisher run was not dispatched manually");
  if (String(run.path) !== expected.workflowPath) refuse("its publisher run is not the reviewed commissioning workflow");
  if (String(run.head_sha) !== String(expected.sourceSha)) refuse("its publisher run did not run the immutable source this attempt is bound to");
  for (const field of ["actor", "triggering_actor"]) {
    const identity = run[field];
    if (!identity || Number(identity.id) !== OWNER_USER_ID || String(identity.login) !== OWNER_LOGIN || String(identity.type) !== OWNER_USER_TYPE) {
      refuse(`its publisher run's ${field} is not the one authorized local identity`);
    }
  }

  /**
   * ── ONLY NOW THE LIFECYCLE, AND A CORRECTLY BOUND NONTERMINAL PUBLISHER IS *PENDING* ───────────
   *
   * An upload necessarily happens BEFORE the job and the run that produced it can finish, so the
   * artifact being visible while its own valid publisher is still `in_progress` is the ordinary
   * case, not an anomaly. This threw `WitnessIncomplete` WITHOUT the retryable marker, so the
   * bounded waiter aborted immediately instead of waiting for the publisher's terminal result —
   * with zero sleeps, on a run that was about to succeed.
   *
   * So a run that has passed every binding check above and has simply not finished yet is RETRYABLE
   * (the waiter polls it within the original challenge expiry, which is never extended). A run that
   * reached a terminal state other than success is a refusal, immediately: there is nothing to wait
   * for and a failed publisher is not a publication.
   */
  const status = String(run.status ?? "");
  const conclusion = run.conclusion === null || run.conclusion === undefined ? null : String(run.conclusion);
  if (status !== "completed") {
    throw new WitnessIncomplete(
      `the witness artifact's publisher run is ${status || "unreported"}; it is correctly bound but has not finished, so this publication is PENDING within the original challenge expiry`,
      { retryable: true, publisher_run_id: owningRun, publisher_run_status: status },
    );
  }
  if (conclusion !== "success") {
    refuse(`its publisher run completed as ${JSON.stringify(conclusion ?? "none")}; a publication is pinned to a SUCCESSFUL publisher run`);
  }
  // EXCLUSIVITY: one publisher-capable job ran, and every other job in that run was skipped. This is
  // the reviewed wiring being checked against the provider's own job state rather than assumed.
  const rows = Array.isArray(jobs) ? jobs : null;
  if (!rows) throw new WitnessIncomplete("the publisher run's jobs could not be measured");
  const executed = rows.filter((job) => String(job?.conclusion ?? "") !== "skipped");
  if (executed.length !== 1) refuse(`its publisher run executed ${executed.length} jobs; exactly one publisher job may run in witness mode`);
  if (String(executed[0]?.conclusion ?? "") !== "success") refuse("its publisher job did not succeed");
  return {
    artifact_id: Number(artifact.id),
    artifact_name: String(artifact.name ?? ""),
    publisher_run_id: owningRun,
    // Correlation only. Stated as such in the evidence so nobody reads it as provenance.
    publisher_job_ids: rows.map((job) => Number(job?.id)).filter(Number.isInteger),
    provenance_basis: "reviewed-immutable-workflow-exclusive-upload-wiring + api-run-and-job-state + actor-private-nonce",
  };
}
