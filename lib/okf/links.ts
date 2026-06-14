/**
 * OKF link-graph helpers. The link regex matches the contributor CLI's
 * (agentic-team-ops scripts/aios.mjs LINK_RE) so client and server agree on
 * what counts as a document link: relative markdown links to .md / .yaml files,
 * excluding anchors (#) and URLs (:).
 */
const LINK_RE = /\[(?:[^\]]*)\]\(([^)#:]+\.(?:md|yaml))\)/g;

export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function extractTitle(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Resolve a document-relative link against the source node's path, returning a
 * normalized repo-relative path (posix). Mirrors how the CLI walks the graph.
 */
export function resolveLink(fromPath: string, link: string): string {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const segments = (fromDir ? fromDir.split("/") : []).concat(link.split("/"));
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}
