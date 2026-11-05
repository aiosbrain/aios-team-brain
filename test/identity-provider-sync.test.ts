import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Provider identity auto-linking reads the COMPLETE identity snapshot, strictly, inside the identity
 * mutation boundary — or it links nothing.
 *
 * Spec. `syncProviderIdentities` (lib/identity/provider-sync) runs its whole batch inside
 * `withIdentityMutationBoundary(teamId, …)`: one strict `buildIdentityMap` read of the four identity
 * tables, then one `setMemberIdentity` per user whose address is an exact roster/alias match.
 *   1. If ANY of the four reads fails, the sync fails with that read's own error and writes nothing.
 *   2. With all four healthy it links exactly the confirmed addresses, through the system actor.
 *   3. Nothing — no read, no write — happens outside the boundary.
 *
 * THE HARNESS IS PART OF WHAT IS TESTED. The boundary is mocked as a passthrough (its locking is the
 * real-PostgreSQL tier's subject), and the mock must define the export production actually imports.
 * It once did not: vitest then threw `No "withIdentityMutationBoundary" export is defined on the
 * mock` before a single table was read, and because that message contains the word "identity" a
 * loose `/identity|…/` assertion matched it for every table — four green cases that never reached
 * the reads they were named for. So each failure case here pins the exact error of ITS table and the
 * exact reads that preceded it, and the controls below prove the fixture reaches the reads at all,
 * that strictness is what turns a failed read into a failed sync, and that a healthy sync writes.
 */

const h = vi.hoisted(() => ({
  setIdentity: vi.fn(),
  boundary: vi.fn(),
  /** True only while the mocked boundary is running the body it was handed. */
  inside: false,
}));

vi.mock("@/lib/identity/member-identities", () => ({ setMemberIdentity: h.setIdentity }));
vi.mock("@/lib/identity/authority", () => ({ withIdentityMutationBoundary: h.boundary }));

import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import { buildIdentityMap } from "@/lib/identity/resolve";
import type { DbClient } from "@/lib/db/types";

/** The four identity tables, in the order the strict snapshot reads them. */
const TABLES = ["members", "member_emails", "member_identities", "member_identity_mapping_state"] as const;
type Table = (typeof TABLES)[number];

/** The error each table's strict read raises — its own, not a neighbour's and not the harness's. */
const READ_ERROR: Record<Table, string> = {
  members: "identity members read failed: members temporarily unavailable",
  member_emails: "identity aliases read failed: member_emails temporarily unavailable",
  member_identities: "provider identities read failed: member_identities temporarily unavailable",
  member_identity_mapping_state: "provider identity authority read failed: member_identity_mapping_state temporarily unavailable",
};

type Row = Record<string, unknown>;

/** A recording stand-in for the four reads: which table, for which team, and whether the read was
 * issued inside the boundary. */
class IdentityReadDb {
  readonly reads: { table: string; teamId: unknown; inside: boolean }[] = [];
  private table = "";

  constructor(
    private readonly failedTable: Table | null = null,
    private readonly rows: Partial<Record<Table, Row[]>> = {},
  ) {}

  from(table: string) { this.table = table; return this; }
  select() { return this; }
  async eq(_column: string, teamId: unknown) {
    const table = this.table;
    this.reads.push({ table, teamId, inside: h.inside });
    if (table === this.failedTable) {
      return { data: null, error: { message: `${table} temporarily unavailable` } };
    }
    if (table === "members") {
      return {
        data: this.rows.members ?? [{ id: "member-a", email: "a@example.com", actor_handle: "a", status: "active" }],
        error: null,
      };
    }
    return { data: this.rows[table as Table] ?? [], error: null };
  }

  get tablesRead(): string[] { return this.reads.map((read) => read.table); }
  asClient(): DbClient { return this as unknown as DbClient; }
}

const USER = { id: "subject:account-a", email: "a@example.com" };
const sync = (db: IdentityReadDb, users = [USER]) => syncProviderIdentities(db.asClient(), "team-a", "gdrive", users);

beforeEach(() => {
  h.inside = false;
  h.setIdentity.mockReset();
  h.setIdentity.mockImplementation(async () => {
    // A write issued outside the boundary is the defect the boundary exists to prevent.
    if (!h.inside) throw new Error("setMemberIdentity was called outside the identity mutation boundary");
    return { conflict: false };
  });
  h.boundary.mockReset();
  // PASSTHROUGH: run the body, exactly once, and say when it is running.
  h.boundary.mockImplementation(async (_teamIds: unknown, body: () => Promise<unknown>) => {
    h.inside = true;
    try {
      return await body();
    } finally {
      h.inside = false;
    }
  });
});

describe("provider identity sync: the harness reaches the code it names", () => {
  it("the boundary mock defines the export production imports, and is a passthrough that runs the body once", async () => {
    const authority = await import("@/lib/identity/authority");
    // Reading a missing export of a mocked module throws; this is the read that used to.
    expect(typeof authority.withIdentityMutationBoundary).toBe("function");
    const body = vi.fn(async () => "ran");
    await expect(authority.withIdentityMutationBoundary("team-a", body)).resolves.toBe("ran");
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("a sync enters the boundary for its own team, once, and every read and write happens inside it", async () => {
    const db = new IdentityReadDb();
    await sync(db);
    expect(h.boundary).toHaveBeenCalledTimes(1);
    expect(h.boundary.mock.calls[0][0]).toBe("team-a");
    // All four tables were read — the fixture is past the boundary and inside buildIdentityMap.
    expect(db.tablesRead).toEqual([...TABLES]);
    expect(db.reads.every((read) => read.inside && read.teamId === "team-a")).toBe(true);
    expect(h.setIdentity).toHaveBeenCalledTimes(1);
  });

  it("NEGATIVE CONTROL: when the boundary refuses, nothing is read and nothing is written", async () => {
    h.boundary.mockImplementationOnce(async () => {
      throw new Error("identity mutation boundary unavailable");
    });
    const db = new IdentityReadDb();
    await expect(sync(db)).rejects.toThrow("identity mutation boundary unavailable");
    expect(db.reads).toEqual([]);
    expect(h.setIdentity).not.toHaveBeenCalled();
  });

  it("users without an address need no snapshot: no boundary, no read, no write", async () => {
    const db = new IdentityReadDb();
    await expect(sync(db, [{ id: "subject:no-email" } as typeof USER])).resolves.toEqual({ scanned: 0, mapped: 0, skipped: 0 });
    expect(h.boundary).not.toHaveBeenCalled();
    expect(db.reads).toEqual([]);
    expect(h.setIdentity).not.toHaveBeenCalled();
  });
});

describe("provider identity sync completeness", () => {
  it.each(TABLES)(
    "fails with the %s read's OWN error, having read exactly up to it, and performs no mutation",
    async (table) => {
      const db = new IdentityReadDb(table);
      const failure = await sync(db).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      // The exact error of this table's strict read — not a pattern another failure could satisfy.
      expect((failure as Error).message).toBe(READ_ERROR[table]);
      expect((failure as Error).message).not.toMatch(/export is defined|vitest/i);
      // It got as far as this table, in order, inside the boundary — and no further.
      expect(db.tablesRead).toEqual(TABLES.slice(0, TABLES.indexOf(table) + 1));
      expect(db.reads.every((read) => read.inside)).toBe(true);
      expect(h.boundary).toHaveBeenCalledTimes(1);
      expect(h.setIdentity).not.toHaveBeenCalled();
    },
  );

  it.each(TABLES)(
    "NEGATIVE CONTROL: the same failed %s read is NOT an error for a non-strict snapshot — strictness is what fails the sync",
    async (table) => {
      // Were `syncProviderIdentities` to drop `{ strict: true }`, this is the snapshot it would act
      // on: built without complaint from a failed read. The cases above would then go red — the
      // sync would resolve, and for three of the four tables it would write.
      const db = new IdentityReadDb(table);
      const lenient = await buildIdentityMap(db.asClient(), "team-a");
      expect(db.tablesRead).toEqual([...TABLES]);
      expect(lenient.byEmail.get("a@example.com")).toBe(table === "members" ? undefined : "member-a");
      // …and the strict one refuses the very same reads.
      await expect(buildIdentityMap(new IdentityReadDb(table).asClient(), "team-a", { strict: true }))
        .rejects.toThrow(READ_ERROR[table]);
    },
  );
});

describe("provider identity sync: a complete snapshot links exactly the confirmed addresses", () => {
  it("SUCCESS CONTROL: all four reads healthy — the roster address is linked through the system actor", async () => {
    const db = new IdentityReadDb();
    await expect(sync(db)).resolves.toEqual({ scanned: 1, mapped: 1, skipped: 0 });
    expect(h.setIdentity).toHaveBeenCalledTimes(1);
    expect(h.setIdentity).toHaveBeenCalledWith(
      db,
      "team-a",
      "member-a",
      { provider: "gdrive", externalId: "subject:account-a", handle: "", email: "a@example.com" },
      { actor: { kind: "system" } },
    );
  });

  it("an alias address read from member_emails is linked to its member; an unknown address is skipped without a write", async () => {
    const db = new IdentityReadDb(null, {
      member_emails: [{ email: "Alias@Example.com", member_id: "member-a" }],
    });
    const result = await sync(db, [
      { id: "subject:alias", email: "alias@example.com" },
      { id: "subject:stranger", email: "stranger@example.com" },
    ]);
    expect(result).toEqual({ scanned: 2, mapped: 1, skipped: 1 });
    expect(h.setIdentity.mock.calls.map((call) => [call[2], call[3].externalId])).toEqual([["member-a", "subject:alias"]]);
  });

  it("an address two members share is ambiguous and links nobody; a writer conflict counts as skipped", async () => {
    const shared = new IdentityReadDb(null, {
      members: [
        { id: "member-a", email: "a@example.com", actor_handle: "a", status: "active" },
        { id: "member-b", email: "b@example.com", actor_handle: "b", status: "active" },
      ],
      member_emails: [
        { email: "shared@example.com", member_id: "member-a" },
        { email: "shared@example.com", member_id: "member-b" },
      ],
    });
    await expect(sync(shared, [{ id: "subject:shared", email: "shared@example.com" }]))
      .resolves.toEqual({ scanned: 1, mapped: 0, skipped: 1 });
    expect(h.setIdentity).not.toHaveBeenCalled();

    h.setIdentity.mockImplementationOnce(async () => ({ conflict: true }));
    await expect(sync(new IdentityReadDb())).resolves.toEqual({ scanned: 1, mapped: 0, skipped: 1 });
    expect(h.setIdentity).toHaveBeenCalledTimes(1);
  });
});
