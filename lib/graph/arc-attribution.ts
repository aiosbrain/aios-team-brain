/**
 * Human attribution for Layer 2 (events) and Layer 3 (narrative arcs). An AI agent/tool name (e.g.
 * "Claude Code", "AIOS Team Brain") is not a traceable actor by itself — it shows up in
 * `participants` only because Graphiti's entity extractor (Layer 2) or the arc-synthesis LLM (Layer
 * 3) read it out of episode prose (a Slack message, a PR body). Every ingested item is already
 * attributed to a human via `items.member_id` (excluding connector service-accounts,
 * `members.is_connector`), so this rewrites a recognized AI-agent name to name the human actually
 * responsible for that work, instead of letting the tool stand in for one.
 */

/**
 * Product/tool names that turn up in Slack/PR text but are never themselves a traceable human.
 * Exact match (trimmed, case-insensitive) — deliberately a fixed list rather than a substring/regex
 * match, so a person actually named e.g. "Claude" or "Cursor" is never misattributed.
 */
const KNOWN_AI_AGENT_NAMES = new Set([
  "claude",
  "claude code",
  "claude agent sdk",
  "claude sdk",
  "aios team brain",
  "team brain",
  "chatgpt",
  "gpt-4",
  "gpt-4o",
  "gpt-5",
  "openai",
  "anthropic",
  "github copilot",
  "copilot",
  "codex",
  "cursor",
  "the ai",
  "ai agent",
  "ai assistant",
  "the assistant",
  "the bot",
]);

export function isAiAgentName(name: string): boolean {
  return KNOWN_AI_AGENT_NAMES.has(name.trim().toLowerCase());
}

/** Cap how many humans get named in one attribution tag — readability, not a data limit. */
const MAX_ATTRIBUTED_HUMANS = 2;

/** Format the "(human, via agent)" / "(unattributed AI agent: agent)" tag shared by fact- and
 *  participant-level attribution. `humanNames` should already exclude connector service-accounts. */
function attributionTag(agentName: string, humanNames: string[]): string {
  const humans = [...new Set(humanNames.filter(Boolean))].slice(0, MAX_ATTRIBUTED_HUMANS);
  return humans.length ? `(${humans.join(", ")}, via ${agentName})` : `(unattributed AI agent: ${agentName})`;
}

/**
 * Rewrite an arc's `participants` so any recognized AI-agent name is tagged with the human(s)
 * responsible for the underlying work. Non-agent names pass through unchanged. `humanNames` should
 * already exclude connector service-accounts — pass [] when none resolve, which tags the agent as
 * unattributed rather than silently dropping or guessing at a human.
 */
export function attributeParticipants(participants: string[], humanNames: string[]): string[] {
  const humans = [...new Set(humanNames.filter(Boolean))].slice(0, MAX_ATTRIBUTED_HUMANS);
  return participants.map((p) => {
    if (!isAiAgentName(p)) return p;
    return humans.length ? `${p} (${humans.join(", ")})` : `${p} (unattributed AI agent)`;
  });
}

/** The minimal shape of a graph fact `attributeFactText`/`attributedFactTexts` need — structurally
 *  compatible with `AtomicFact` (lib/graph/learning.ts) without importing it, so this module stays a
 *  plain, dependency-free pure module. */
export interface FactRef {
  fact: string;
  subject: string;
  episodeUuids: string[];
}

/**
 * True when `subject` already refers to one of the resolved humans — so we don't double-attribute
 * a fact like "Chetan shipped X" (subject "Chetan", human "Chetan Nandakumar") into the ugly
 * "(Chetan Nandakumar) Chetan shipped X". Case-insensitive: exact match, or the full human name
 * contains the (usually shorter) subject (first-name → full-name). Conservative — only suppresses
 * the prefix, so a miss just leaves a mild redundancy rather than dropping attribution.
 */
function subjectNamesAHuman(subject: string, humanNames: string[]): boolean {
  const s = subject.trim().toLowerCase();
  if (!s) return false;
  return humanNames.some((h) => {
    const hl = h.trim().toLowerCase();
    return hl === s || hl.includes(s);
  });
}

/**
 * Prefix a single fact's text with the human(s) responsible for it, so the arc-synthesis LLM's INPUT
 * is grounded in a real person from the start (not patched onto the arc's output `participants`
 * after the fact). Three cases:
 *   - subject is a recognized AI agent → `(Name, via Agent) fact` (or `(unattributed AI agent: Agent)`),
 *   - subject is an ordinary name with a resolvable human → `(Name) fact` — UNLESS the subject already
 *     names that human (`subjectNamesAHuman`), in which case the fact already attributes itself,
 *   - no resolvable human and not an agent → unchanged.
 * This is the fix for arcs whose facts have technical/component subjects (e.g. "the checklist
 * evaluator"): the human is still known via `items.member_id`, so surface it rather than letting the
 * arc render with no person's name.
 */
export function attributeFactText(fact: string, subject: string, humanNames: string[]): string {
  const humans = [...new Set(humanNames.filter(Boolean))].slice(0, MAX_ATTRIBUTED_HUMANS);
  if (isAiAgentName(subject)) return `${attributionTag(subject, humans)} ${fact}`;
  if (humans.length === 0 || subjectNamesAHuman(subject, humans)) return fact;
  return `(${humans.join(", ")}) ${fact}`;
}

/**
 * Batch version of `attributeFactText` for the numbered facts fed to the synthesis prompt. For each
 * fact, resolves its source item(s) via `episodeUuids` → `epToItem`, looks up each item's human via
 * `humanByItem`, and attributes the fact text with that human (or `via`-tags a recognized AI agent).
 * Pure — the two maps are pre-resolved by the caller (arcs.ts, which owns the DB/Neo4j round trips).
 */
export function attributedFactTexts(
  facts: FactRef[],
  epToItem: Map<string, { itemId?: string }>,
  humanByItem: Map<string, string>
): string[] {
  return facts.map((f) => {
    const humans = [
      ...new Set(
        f.episodeUuids
          .map((u) => epToItem.get(u)?.itemId)
          .filter((id): id is string => !!id)
          .map((id) => humanByItem.get(id))
          .filter((h): h is string => !!h)
      ),
    ];
    return attributeFactText(f.fact, f.subject, humans);
  });
}

/**
 * Union an arc's LLM-written `participants` with the humans resolved from the arc's OWN cited
 * evidence (via `items.member_id`) — so being named on an arc is STRUCTURAL, not LLM luck. Without
 * this, a participant chip appears only when the model happens to echo a name out of the fact text:
 * fine for people whose docs literally say "John is coordinating…", invisible for people whose work
 * is commit-shaped (fact subjects are features/repos; the human exists only in the `(Name)`
 * attribution prefix). It also puts names on arcs the model returned with `participants: []`.
 *
 * A human is skipped when their name already appears (case-insensitive) INSIDE any existing
 * participant string — covering the exact name and the rewritten agent tag "Claude Code (Name)"
 * from `attributeParticipants` — so no duplicate chips. LLM participants keep their order; evidence
 * humans append after. Pure; evidence humans come from the roster (`members.display_name`,
 * connectors already excluded), so nothing here can invent a person.
 */
export function withEvidenceParticipants(participants: string[], evidenceHumans: string[]): string[] {
  const out = [...participants];
  for (const human of [...new Set(evidenceHumans.map((h) => (h ?? "").trim()).filter(Boolean))]) {
    const needle = human.toLowerCase();
    if (!out.some((p) => p.toLowerCase().includes(needle))) out.push(human);
  }
  return out;
}

/** The minimal shape of a Layer-2 event `attributeEventParticipants` needs — structurally compatible
 *  with `GraphEvent` (lib/graph/learning.ts) without importing it. */
export interface EventParticipantsRef {
  itemId: string | null;
  participants: string[];
}

/**
 * Rewrite each event's `participants` (Layer 2) to tag a recognized AI-agent name with the human
 * behind that event's single source item. Mirrors `attributeParticipants` for arcs — but an event
 * maps to exactly ONE item (`itemId`), not a set of evidence items, so there's no per-event merge
 * across items. Pure over an already-resolved `humanByItem` map — no DB access here.
 */
export function attributeEventParticipants<T extends EventParticipantsRef>(
  events: T[],
  humanByItem: Map<string, string>
): T[] {
  return events.map((e) => {
    const human = e.itemId ? humanByItem.get(e.itemId) : undefined;
    return { ...e, participants: attributeParticipants(e.participants, human ? [human] : []) };
  });
}
