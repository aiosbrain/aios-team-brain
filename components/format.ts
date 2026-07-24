/** Tiny date/format helpers shared by dashboard views. */

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Flatten inline markdown to plain text for compact UI (e.g. decision titles arrive from a markdown
 * decision log, so `**Pause GUI**` must render as "Pause GUI", not with literal asterisks). Handles
 * links/images → their text, inline code, bold/italic/strikethrough, and leading block markers.
 * Strip BEFORE truncating so a cut title can't leave a dangling `**`. Pure + unit-tested.
 */
export function stripMarkdown(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/`+([^`]*)`+/g, "$1") // inline code
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold (** or __)
    .replace(/\*([^*]+?)\*/g, "$1") // italic (*)
    // italic (_) ONLY at word boundaries, so mid-word underscores in identifiers (snake_case, MY_VAR)
    // aren't treated as emphasis and mangled to snakecase / MYVAR (Fable review).
    .replace(/(^|[^\w])_([^_]+?)_(?=\W|$)/g, "$1$2")
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "") // leading heading/quote/list markers
    .replace(/\s+/g, " ")
    .trim();
}
