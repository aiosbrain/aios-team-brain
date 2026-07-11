/**
 * Governance validation gate (Social Brain). Before a generated draft can advance, it is checked
 * against the Brand Brain. Pure + deterministic (unit-testable); the generator wires it in and
 * persists the result on the variant.
 *
 * Policy (Chetan, 2026-07-11): BLOCK on a prohibited phrase or a confidential topic; WARN (don't
 * block) on a claim that needs verification. A blocked draft never advances to `generated`.
 */

export interface ContentFinding {
  /** 'prohibited_phrase' | 'confidential_topic' | 'unverified_claim' */
  rule: string;
  /** the brand term that matched */
  term: string;
}

export interface ValidationResult {
  /** true when there are no BLOCKING violations (warnings don't block). */
  ok: boolean;
  violations: ContentFinding[];
  warnings: ContentFinding[];
}

export interface GovernanceRules {
  prohibitedPhrases?: string[];
  confidentialTopics?: string[];
  claimsNeedingVerification?: string[];
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

/** Extract the governance rules from a brand profile record (voice/knowledge/governance blobs). */
export function governanceFromBrand(
  brand: { voice?: Record<string, unknown>; knowledge?: Record<string, unknown>; governance?: Record<string, unknown> } | null
): GovernanceRules {
  return {
    prohibitedPhrases: asStringArray(brand?.voice?.prohibitedPhrases),
    confidentialTopics: asStringArray(brand?.governance?.confidentialTopics),
    claimsNeedingVerification: asStringArray(brand?.knowledge?.claimsNeedingVerification),
  };
}

function matches(text: string, terms: string[] | undefined, rule: string): ContentFinding[] {
  const lower = text.toLowerCase();
  return (terms ?? [])
    .filter((t) => lower.includes(t.toLowerCase()))
    .map((term) => ({ rule, term }));
}

/** Check a draft against the brand governance rules. */
export function validateContent(text: string, rules: GovernanceRules): ValidationResult {
  const violations = [
    ...matches(text, rules.prohibitedPhrases, "prohibited_phrase"),
    ...matches(text, rules.confidentialTopics, "confidential_topic"),
  ];
  const warnings = matches(text, rules.claimsNeedingVerification, "unverified_claim");
  return { ok: violations.length === 0, violations, warnings };
}
