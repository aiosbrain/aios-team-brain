import "server-only";
import { adminClient } from "@/lib/db/admin";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import { closeMembershipInto, ensureIncludeMembership } from "@/lib/projects/context/memberships";

/**
 * The harness fixture's CONTEXT SUBSTRATE, written through its CANONICAL OWNERS.
 *
 * Why this is a separate TypeScript process rather than SQL in the `.mjs` fixture: those two tables
 * have single-writer owners (`lib/projects/context/units.ts`, `.../memberships.ts`), enforced by a
 * build-failing guard, and every invariant they carry — the audience inherited from the item, the
 * no-widening gate, the locked revalidation protocol — lives there. Hand-rolled parameterized SQL
 * in the fixture would have seeded rows that no longer had to obey any of it, which is a strange
 * thing for a harness whose entire purpose is checking an access boundary. `reconcileItemUnit`
 * ALSO mirrors the item's hash and audience, so `mutate` needs no separate hash update.
 *
 * `reconcileItemContext` is deliberately not used: it needs system projects that this fixture does
 * not create and can return `skipped`, which would seed nothing and still look successful.
 *
 * Run under tsx with `--conditions react-server` and `DATABASE_URL` pointed at the SOURCE database,
 * the same way `reapply-testers.ts` is invoked.
 */

const TEAM = "11111111-1111-4111-8111-111111111111";
const ITEMS = {
  external: "33333333-3333-4333-8333-333333333330",
  team: "33333333-3333-4333-8333-333333333331",
  private: "33333333-3333-4333-8333-333333333332",
  deferred: "33333333-3333-4333-8333-333333333333",
} as const;
/** Each item's OWN project. Never General — that would widen the private boundary under test. */
const PROJECTS = {
  external: "22222222-2222-4222-8222-222222222220",
  team: "22222222-2222-4222-8222-222222222221",
  private: "22222222-2222-4222-8222-222222222222",
  deferred: "22222222-2222-4222-8222-222222222223",
} as const;

type Kind = keyof typeof ITEMS;
const KINDS = Object.keys(ITEMS) as Kind[];

/** One item-grain unit per item, with a current include membership into that item's project. */
async function reconcileOne(kind: Kind) {
  const db = adminClient();
  const unit = await reconcileItemUnit(db, TEAM, ITEMS[kind]);
  // A REQUIRED result, not a best effort: a silently skipped reconcile is exactly how this fixture
  // came to predict an empty page from a successful read.
  if (!unit.ok || !unit.unitId) throw new Error(`context unit for ${kind} was not reconciled: ${unit.error ?? "no unit id returned"}`);
  const membership = await ensureIncludeMembership(db, TEAM, { contextUnitId: unit.unitId, projectId: PROJECTS[kind] });
  if (!membership.ok) throw new Error(`include membership for ${kind} was refused: ${JSON.stringify(membership)}`);
  return { kind, unitId: unit.unitId, audience: unit.audience ?? null };
}

async function unitIdFor(kind: Kind): Promise<string> {
  const unit = await reconcileItemUnit(adminClient(), TEAM, ITEMS[kind]);
  if (!unit.ok || !unit.unitId) throw new Error(`could not resolve the context unit for ${kind}: ${unit.error ?? "no unit id"}`);
  return unit.unitId;
}

export async function seedContext() {
  const units = [];
  for (const kind of KINDS) units.push(await reconcileOne(kind));
  return { status: "context-seeded", units: units.length, memberships: units.length, detail: units };
}

/** `reconcileItemUnit` mirrors the item's hash and audience, so a mutated item needs only this. */
export async function mirrorContext(kind: Kind = "team") {
  const unit = await reconcileItemUnit(adminClient(), TEAM, ITEMS[kind]);
  if (!unit.ok || !unit.unitId) throw new Error(`context unit for ${kind} was not mirrored: ${unit.error ?? "no unit id"}`);
  return { status: "context-mirrored", kind, unitId: unit.unitId };
}

/**
 * The source oracle's negative control: close one include membership so the visible set narrows,
 * and reopen it afterwards. Both go through the owner module: closing retains the historical row,
 * and reopening creates a new current membership linked to the same context unit.
 */
export async function closeMembership(kind: Kind) {
  const result = await closeMembershipInto(adminClient(), TEAM, await unitIdFor(kind), PROJECTS[kind]);
  if (!result.ok) throw new Error(`membership for ${kind} was not closed: ${JSON.stringify(result)}`);
  return { status: "membership-closed", kind };
}

export async function openMembership(kind: Kind) {
  const db = adminClient();
  const result = await ensureIncludeMembership(db, TEAM, { contextUnitId: await unitIdFor(kind), projectId: PROJECTS[kind] });
  if (!result.ok) throw new Error(`membership for ${kind} was not reopened: ${JSON.stringify(result)}`);
  return { status: "membership-opened", kind };
}

if (process.argv.includes("--run")) {
  const action = process.argv[process.argv.indexOf("--run") + 1] ?? "seed";
  const kind = (process.argv[process.argv.indexOf("--run") + 2] ?? "team") as Kind;
  const dispatch = action === "seed" ? seedContext()
    : action === "mirror" ? mirrorContext(kind)
      : action === "close" ? closeMembership(kind)
        : action === "open" ? openMembership(kind)
          : Promise.reject(new Error("context action must be seed, mirror, close or open"));
  dispatch
    .then((out) => { console.log(JSON.stringify(out)); })
    .catch((error: unknown) => {
      console.error(`staging pair context refused: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
