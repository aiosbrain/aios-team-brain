export type HomeState = "admin-bootstrap" | "member-setup" | "dashboard";

/**
 * Which first-screen a team member sees. Pure so the truth table is unit-testable
 * without a DB — the page wiring (app/t/[team]/page.tsx) supplies the inputs.
 *
 * "member-setup" is deliberately independent of `itemCount`: a member invited into an
 * already-active team never had a zero-item team to trigger the old team-scoped
 * checklist, so they'd otherwise land on the generic dashboard with no nudge at all.
 */
export function pickHomeState({
  isAdmin,
  itemCount,
  hasOwnKey,
}: {
  isAdmin: boolean;
  itemCount: number;
  hasOwnKey: boolean;
}): HomeState {
  if (isAdmin && itemCount === 0) return "admin-bootstrap";
  if (!isAdmin && !hasOwnKey) return "member-setup";
  return "dashboard";
}
