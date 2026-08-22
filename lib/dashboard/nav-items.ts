import type { NavEntry, NavLeaf } from "@/components/team-nav";

/**
 * The team dashboard's left-nav contents — a PURE function of the team slug and the viewer's role.
 *
 * WHY THIS IS EXTRACTED (SKILLNAV-1). The nav used to be built inline in the layout's server
 * component, which made it unreachable to tests: a guard could only grep the source. Grep cannot
 * tell a rendered entry from one inside a block comment, and cannot see that an entry moved behind
 * `if (role === "admin")` — so a guard built on it stays green while the nav is broken for real
 * users. That is not hypothetical: it is how the Skills entry disappeared unnoticed once already.
 * A pure builder lets the guard CALL the thing and assert on what it actually returns, per role.
 *
 * Keep this free of I/O and React so it stays trivially callable from the unit tier.
 */
export function buildNavItems({ base, role }: { base: string; role: string }): NavEntry[] {
  // Settings groups the low-frequency config surfaces; Admin is appended only for admins.
  // "Team tools" (/team-tools) removed from the nav (2026-07-13, product call) — route still resolves.
  const settingsChildren: NavLeaf[] = [
    { icon: "account", label: "Account", href: `${base}/account` },
  ];
  if (role === "admin") {
    settingsChildren.push({ icon: "admin", label: "Admin", href: `${base}/admin` });
  }

  // Lean primary IA (2026-07-10, product call). Removed from the left nav — routes still resolve by
  // direct URL, only the nav entry was cut: "Tasks" (/tasks), "Maturity" (/maturity), "Decisions"
  // (/decisions, empty + unused). "Data" moved under Admin → Data (verification/debug view, now
  // admin-gated). The "Work" group is dropped (nothing left in it; Projects stays commented out).
  // "Meetings" stays a top-level entry — a new, actively-used surface, not part of the trim.
  // "Pulse" (home) is now the flagship narrative surface: it absorbed the old "Learning" tab (arcs +
  // timeline + facts/events), so that entry was removed and `/learning` redirects here. The Brain icon
  // fronts Pulse to signal it's the synthesized-understanding surface, not a generic dashboard home.
  const items: NavEntry[] = [
    { icon: "learning", label: "Pulse", href: base, exact: true },
    { icon: "codebases", label: "Codebases", href: `${base}/codebases` },
    { icon: "meetings", label: "Meetings", href: `${base}/meetings` },
    { icon: "query", label: "Query", href: `${base}/query` },
    // SKILLNAV-1: "Skills" is back as a top-level entry. The catalog at /library/skills has been
    // built, authenticated and serving real data throughout — 22 published skills in prod. It lost
    // its way in over two commits, neither of which meant to remove it:
    //   3feb311  ships the page WITH a top-level nav entry;
    //   5138047  removes that entry, because the Library PAGE gained a kind-chip linking to it
    //            ("Skills folds into Library … not a top-level peer") — reachable, but only via
    //            one link on one page;
    //   5509ca9  (#213) turns library/page.tsx into a redirect to /admin/data, destroying that
    //            chip — and with it the last path in. Its comment still asserts skills are "linked
    //            from arc evidence, query citations, etc."; grep finds no such link anywhere.
    // So the lesson is not "don't trim the nav" — it is that reachability delegated to ONE link on
    // ANOTHER page dies silently when that page changes. Hence: top-level, and guarded by
    // test/guards/nav-reachability.test.ts. Do not re-trim without checking the catalog is empty.
    { icon: "skills", label: "Skills", href: `${base}/library/skills` },
  ];
  // "Social" removed from the left nav (product call) — the /social route still resolves by direct URL.
  items.push({ label: "Settings", children: settingsChildren });
  // FROZEN (Fable review, round 3): the guard asserts what this function RETURNS and that the layout
  // renders it, but neither sees an in-place edit between the two — `const items` blocks reassignment,
  // not `items.splice(...)`. Freezing turns that silent drop into a runtime throw. Shallow is enough:
  // the failure mode is removing an entry, not mutating one's fields.
  return Object.freeze(items) as NavEntry[];
}
