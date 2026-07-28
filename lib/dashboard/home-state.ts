export type HomeState = "admin-bootstrap" | "member-setup" | "dashboard";

/**
 * Which first-screen a team member sees. Pure so the truth table is unit-testable
 * without a DB — the page wiring (app/t/[team]/page.tsx) supplies the inputs.
 *
 * "member-setup" is deliberately independent of `itemCount`: any member without an
 * active key that has successfully authenticated still needs setup, even if they have
 * generated a key or joined an already-active team.
 */
export function pickHomeState({
  isAdmin,
  itemCount,
  hasConnectedKey,
}: {
  isAdmin: boolean;
  itemCount: number;
  hasConnectedKey: boolean;
}): HomeState {
  if (isAdmin && itemCount === 0) return "admin-bootstrap";
  if (!hasConnectedKey) return "member-setup";
  return "dashboard";
}
