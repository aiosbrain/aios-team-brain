#!/usr/bin/env node
/**
 * AC-03: the EXECUTABLE effective-main-policy verifier.
 *
 * `verifyEffectiveMainPolicy` is a pure evaluator, and until now its only callers were tests — so
 * the acceptance criterion "an effective-policy verifier exists" was satisfied by a function nobody
 * could run against GitHub. This is the acquisition half: it reads the policy actually in force on
 * `main` and hands it to that evaluator.
 *
 *   node scripts/staging-ops/verify-main-policy.mjs
 *
 * Required environment:
 *   GITHUB_REPOSITORY              owner/repo
 *   GITHUB_POLICY_READ_TOKEN       a READ-ONLY token; needs repository administration:read, and
 *                                  organization administration:read if any inherited org ruleset
 *                                  applies to main (see the refusal below if it does not have it)
 *   MAIN_POLICY_NORMAL_APP_ID      measured numeric App IDs and producer integration IDs — the same
 *   MAIN_POLICY_EMERGENCY_APP_ID   expectations the desired contract is built from
 *   MAIN_POLICY_PRODUCER_IDS       JSON object: { "<check context>": <integration id>, … }
 *
 * Exit 0 only when the measured effective policy equals the desired contract. NONZERO for a
 * mismatch AND for an incomplete measurement — those are reported distinctly, because "the policy
 * is wrong" and "I could not see all of the policy" send an operator to different places, and only
 * the first is a statement about the policy at all.
 *
 * ⚠️ THREE THINGS IT DELIBERATELY DOES NOT DO.
 *  1. **No writes.** Every request is a GET; `assertReadOnly` refuses anything else before it
 *     reaches the network. This verifier reports; it does not repair.
 *  2. **No applicability inference.** It asks `/rules/branches/main` — the endpoint that answers
 *     which rules ACTUALLY apply to that branch — instead of filtering rulesets by whether their
 *     ref pattern happens to spell `refs/heads/main`. Inherited organization rulesets, wildcard
 *     targets and `~DEFAULT_BRANCH` all apply to main and are all invisible to that spelling, so
 *     inferring applicability would silently drop active restrictions from the evaluation and call
 *     the remainder a clean policy.
 *  3. **No treating an extra restriction as harmless.** An additional applicable ruleset is
 *     evaluated, not ignored: it may conflict with the intended App bypass matrix, and a bypass on
 *     one ruleset does not cancel restrictions imposed by the three desired ones.
 */

import { isDirectEntry as directEntry } from "./direct-entry.mjs";
import { verifyEffectiveMainPolicy } from "./main-policy.mjs";

const API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** GETs only. A verifier that can mutate is a policy-administration tool that has not admitted it. */
function assertReadOnly(method) {
  if (String(method ?? "GET").toUpperCase() !== "GET") throw new Error("main policy verification refused a non-GET request");
}

/** Distinguishes "this is not configured" from "I could not look", which must never be conflated. */
class IncompleteMeasurement extends Error {
  constructor(message) { super(message); this.name = "IncompleteMeasurement"; }
}

async function githubGet(path, { token, fetchImpl, allowNotFound = false }) {
  assertReadOnly("GET");
  const response = await fetchImpl(`${API}${path}`, {
    method: "GET", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404 && allowNotFound) return null;
  if (!response.ok) {
    // 401/403 are the authorization case and 5xx the availability case; both mean the measurement
    // is incomplete. Reporting either as "absent" would turn a permission gap into a passing check.
    throw new IncompleteMeasurement(`GET ${path} failed (${response.status}); the effective policy could not be measured`);
  }
  return await response.json();
}

/** Every page, or a refusal. A truncated list of applicable rules understates enforcement. */
async function githubGetAll(path, options) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const body = await githubGet(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`, options);
    if (!Array.isArray(body)) throw new IncompleteMeasurement(`GET ${path} did not return a list`);
    out.push(...body);
    if (body.length < PAGE_SIZE) return out;
  }
  throw new IncompleteMeasurement(`GET ${path} exceeded ${MAX_PAGES} pages; the measurement is incomplete`);
}

/**
 * The rulesets APPLICABLE to main, resolved to their full definitions.
 *
 * `/rules/branches/main` returns one entry per applicable RULE, each naming the ruleset it came
 * from; the details (enforcement, conditions, bypass actors, the full rule list) come from the
 * ruleset endpoint. Organization-sourced rulesets need org-level read: without it the fetch is a
 * 403, which is an incomplete measurement and refuses — an inherited ruleset that cannot be read is
 * exactly the case where claiming readiness would be worst.
 */
export async function readApplicableMainRulesets({ repository, token, fetchImpl = fetch }) {
  const rules = await githubGetAll(`/repos/${repository}/rules/branches/main`, { token, fetchImpl });
  const byId = new Map();
  for (const rule of rules) {
    const id = rule?.ruleset_id;
    const sourceType = String(rule?.ruleset_source_type ?? "");
    const source = String(rule?.ruleset_source ?? "");
    if (!Number.isInteger(id)) throw new IncompleteMeasurement("an applicable rule carries no ruleset identity, so its ruleset cannot be measured");
    if (byId.has(id)) continue;
    if (sourceType === "Repository") byId.set(id, `/repos/${repository}/rulesets/${id}`);
    else if (sourceType === "Organization") {
      const org = source.split("/")[0] || repository.split("/")[0];
      byId.set(id, `/orgs/${org}/rulesets/${id}`);
    } else {
      // An unsupported applicability source is not "no policy"; it is policy this build cannot read.
      throw new IncompleteMeasurement(`ruleset ${id} has unsupported source type "${sourceType || "unknown"}"; its applicability cannot be measured`);
    }
  }
  const rulesets = [];
  for (const [id, path] of byId) {
    const detail = await githubGet(path, { token, fetchImpl });
    if (!detail || typeof detail !== "object") throw new IncompleteMeasurement(`ruleset ${id} returned no definition`);
    rulesets.push(detail);
  }
  return rulesets;
}

/**
 * Classic branch protection. A 404 is the ONE case that legitimately means "explicitly absent"; the
 * caller must be able to tell it from a 403, which means the same body would have been unreadable
 * whatever it said.
 */
export async function readClassicProtection({ repository, token, fetchImpl = fetch }) {
  return await githubGet(`/repos/${repository}/branches/main/protection`, { token, fetchImpl, allowNotFound: true });
}

function expectationsFrom(env) {
  let producerIds;
  try { producerIds = JSON.parse(env.MAIN_POLICY_PRODUCER_IDS ?? "null"); }
  catch { throw new Error("MAIN_POLICY_PRODUCER_IDS must be a JSON object mapping each required check context to its producer integration ID"); }
  return {
    normalAppId: Number(env.MAIN_POLICY_NORMAL_APP_ID),
    emergencyAppId: Number(env.MAIN_POLICY_EMERGENCY_APP_ID),
    producerIds,
  };
}

export async function verifyMainPolicyFromProvider(env = process.env, { fetchImpl = fetch } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_POLICY_READ_TOKEN;
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!token) throw new Error("GITHUB_POLICY_READ_TOKEN is required (read-only; administration:read)");
  const expected = expectationsFrom(env);
  try {
    const [applicableRulesets, classicProtection] = await Promise.all([
      readApplicableMainRulesets({ repository, token, fetchImpl }),
      readClassicProtection({ repository, token, fetchImpl }),
    ]);
    const verdict = verifyEffectiveMainPolicy({
      applicableRulesets, classicProtection, expected,
      // Measured by the provider's own applicability endpoint, not inferred from a ref pattern.
      applicabilityMeasured: true,
    });
    return { ...verdict, status: verdict.ok ? "policy-matches-contract" : "policy-differs-from-contract", measured: true, rulesets: applicableRulesets.length };
  } catch (error) {
    if (error instanceof IncompleteMeasurement) {
      // NOT `ok: false` with the mismatch reasons — this says nothing about the policy itself.
      return { ok: false, status: "measurement-incomplete", measured: false, errors: [error.message] };
    }
    throw error;
  }
}

/**
 * L8: is THIS module the process entry point?
 *
 * The technique now lives in `direct-entry.mjs` because a SECOND CLI needed it and re-derived the
 * fragile version instead (`assert-bootstrap-resume-order.mjs`, M2). The reasoning is recorded
 * there; this wrapper keeps the local signature its callers and tests already use.
 *
 * Deliberately NOT the `--run` ack token that `release-candidate-guard.mjs` uses. This module is
 * imported by tests and could later be imported by another CLI; `--run` is a bare argv word, so ANY
 * entry point invoked with it would fire every imported module's CLI, and the two conventions would
 * collide silently. The documented invocation (`node scripts/staging-ops/verify-main-policy.mjs`) is
 * unchanged, and an import remains side-effect-free because a test runner's `argv[1]` is never this
 * file.
 */
export function isDirectEntry(entry = process.argv[1], moduleUrl = import.meta.url) {
  return directEntry(moduleUrl, entry);
}

if (isDirectEntry()) {
  verifyMainPolicyFromProvider()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(`main policy verification refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
