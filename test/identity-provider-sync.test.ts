import { beforeEach, describe, expect, it, vi } from "vitest";

const setIdentity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/identity/member-identities", () => ({ setMemberIdentity: setIdentity }));
vi.mock("@/lib/db/pg/pool", () => ({ withTransaction: (fn: () => unknown) => fn() }));
vi.mock("@/lib/identity/authority", () => ({ lockIdentityAuthority: vi.fn() }));

import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import type { DbClient } from "@/lib/db/types";

class IdentityReadDb {
  constructor(private readonly failedTable: string) {}
  private table = "";
  from(table: string) { this.table = table; return this; }
  select() { return this; }
  async eq() {
    if (this.table === this.failedTable) {
      return { data: null, error: { message: `${this.table} temporarily unavailable` } };
    }
    if (this.table === "members") {
      return { data: [{ id: "member-a", email: "a@example.com", actor_handle: "a", status: "active" }], error: null };
    }
    return { data: [], error: null };
  }
}

describe("provider identity sync completeness", () => {
  beforeEach(() => setIdentity.mockReset());

  it.each(["members", "member_emails", "member_identities", "member_identity_mapping_state"])(
    "fails visibly and performs no mutation when the %s identity read fails",
    async (table) => {
      await expect(syncProviderIdentities(
        new IdentityReadDb(table) as unknown as DbClient,
        "team-a",
        "gdrive",
        [{ id: "subject:account-a", email: "a@example.com" }],
      )).rejects.toThrow(/identity|aliases|provider identities/);
      expect(setIdentity).not.toHaveBeenCalled();
    },
  );
});
