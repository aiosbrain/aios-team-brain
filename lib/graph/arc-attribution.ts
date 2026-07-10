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
 * Prefix a single fact's text with its human attribution, but ONLY when the fact's `subject` is a
 * recognized AI-agent name — an ordinary human subject needs no prefix, the fact text already names
 * them. This grounds the arc-synthesis LLM's INPUT in a real human (so a summary like "Claude Code is
 * refactoring auth" becomes "Chetan Nandakumar (via Claude Code) is refactoring auth"), rather than
 * only patching the arc's output `participants` after the fact (`attributeParticipants`, above).
 */
export function attributeFactText(fact: string, subject: string, humanNames: string[]): string {
  if (!isAiAgentName(subject)) return fact;
  return `${attributionTag(subject, humanNames)} ${fact}`;
}

/**
 * Batch version of `attributeFactText` for the numbered facts fed to the synthesis prompt. For each
 * fact, resolves its source item(s) via `episodeUuids` → `epToItem`, looks up each item's human via
 * `humanByItem`, and attributes the fact text if its subject is a recognized AI agent. Pure — the two
 * maps are pre-resolved by the caller (arcs.ts, which owns the DB/Neo4j round trips).
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
