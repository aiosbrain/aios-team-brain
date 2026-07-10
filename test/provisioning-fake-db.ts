/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DbClient } from "@/lib/db/types";
import { encryptSecret } from "@/lib/secrets/crypto";

/**
 * A minimal fake DbClient for the provisioning adapter UNIT tests. It answers exactly the one read
 * the adapters make — `getEnabledIntegrationsWithSecrets` → `from("integrations").select().eq().eq()`
 * — from an in-memory list, encrypting each supplied secret so the real decrypt path round-trips.
 * (SECRETS_KEY must be set by the test before calling.) Not a general adapter — real persistence is
 * covered by the data-mechanics tier.
 */

export interface FakeIntegration {
  type: string;
  name?: string;
  config?: Record<string, unknown>;
  secret?: string | null;
  status?: "enabled" | "disabled";
}

export function fakeIntegrationsDb(integrations: FakeIntegration[], teamId = "team-1"): DbClient {
  const rows = integrations.map((i, idx) => ({
    id: `int-${idx}`,
    team_id: teamId,
    type: i.type,
    name: i.name ?? i.type,
    config: i.config ?? {},
    status: i.status ?? "enabled",
    secret_ciphertext: i.secret ? encryptSecret(i.secret) : null,
  }));

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      order: () => b,
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => void) => {
        const data =
          table === "integrations"
            ? rows.filter((r) => filters.every(([c, v]) => !(c in r) || (r as any)[c] === v))
            : [];
        resolve({ data, error: null, count: data.length });
      },
    };
    return b;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as DbClient;
}
