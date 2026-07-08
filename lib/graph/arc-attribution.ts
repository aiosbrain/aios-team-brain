/**
 * Layer 3 human attribution. An AI agent/tool name (e.g. "Claude Code", "AIOS Team Brain") is not a
 * traceable actor by itself — it shows up in `participants` only because the arc-synthesis LLM read
 * it out of episode prose (a Slack message, a PR body). Every ingested item is already attributed to
 * a human via `items.member_id` (excluding connector service-accounts, `members.is_connector`), so
 * this rewrites a recognized AI-agent participant to name the human actually responsible for that
 * work, instead of letting the tool stand in for one.
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
