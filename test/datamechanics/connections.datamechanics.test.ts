import { describe, expect, it } from "vitest";
import {
  createConnection,
  listConnections,
  updateConnection,
  getEnabledConnectionsWithSecrets,
} from "@/lib/connections";
import { db, seedTeam } from "./helpers";

// Spec: connector secrets are stored ENCRYPTED, metadata reads never expose them, and the
// sidecar read path decrypts them. Verified to the observable outcome on real Postgres.

describe("connections store (real Postgres)", () => {
  it("encrypts the secret at rest; metadata lists hasSecret but never the value", async () => {
    const seed = await seedTeam();
    const token = "xoxb-REAL-slack-token-abc123";
    await createConnection(db(), {
      teamId: seed.teamId, source: "slack", name: "eng-slack",
      config: { channel_ids: ["C1", "C2"] }, secret: token,
    });

    // Raw row: ciphertext present and NOT the plaintext.
    const { data: raw } = await db()
      .from("connections").select("secret_ciphertext").eq("team_id", seed.teamId).maybeSingle();
    expect(raw!.secret_ciphertext).toBeTruthy();
    expect(raw!.secret_ciphertext).not.toContain(token);

    // Metadata list: hasSecret true, config preserved, no plaintext/ciphertext leaked.
    const list = await listConnections(db(), seed.teamId);
    expect(list).toHaveLength(1);
    expect(list[0].hasSecret).toBe(true);
    expect(list[0].config).toEqual({ channel_ids: ["C1", "C2"] });
    expect(JSON.stringify(list[0])).not.toContain(token);
  });

  it("the sidecar read path decrypts the secret back to plaintext", async () => {
    const seed = await seedTeam();
    const token = "xoxb-round-trip";
    await createConnection(db(), { teamId: seed.teamId, source: "slack", name: "s", secret: token });

    const enabled = await getEnabledConnectionsWithSecrets(db(), seed.teamId);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].secret).toBe(token);
  });

  it("disabled connections are excluded from the sidecar read path", async () => {
    const seed = await seedTeam();
    const { id } = await createConnection(db(), {
      teamId: seed.teamId, source: "notion", name: "n", secret: "secret_xyz",
    });
    await updateConnection(db(), { teamId: seed.teamId, id, enabled: false });
    expect(await getEnabledConnectionsWithSecrets(db(), seed.teamId)).toHaveLength(0);
  });

  it("update rotates the secret only when provided", async () => {
    const seed = await seedTeam();
    const { id } = await createConnection(db(), {
      teamId: seed.teamId, source: "slack", name: "rot", secret: "old-token",
    });
    await updateConnection(db(), { teamId: seed.teamId, id, config: { channel_ids: ["X"] } });
    expect((await getEnabledConnectionsWithSecrets(db(), seed.teamId))[0].secret).toBe("old-token");
    await updateConnection(db(), { teamId: seed.teamId, id, secret: "new-token" });
    expect((await getEnabledConnectionsWithSecrets(db(), seed.teamId))[0].secret).toBe("new-token");
  });
});
