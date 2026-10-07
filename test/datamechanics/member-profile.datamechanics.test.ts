import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  setMemberProfile,
  setMemberAvatar,
  addTimeOff,
  removeTimeOff,
  setMemberGoal,
  removeMemberGoal,
  ProfileScopeRefusal,
  type GoalWriteScope,
} from "@/lib/identity/profile";
import { db, externalMember, seedTeam } from "./helpers";

// Every goal write names its scope. A manual goal authored for the seeded member is the browser
// arm; an importer converging on (team, source, external_id) is the trusted system arm.
const BROWSER_MEMBER: GoalWriteScope = { mode: "browser_member" };
const SYSTEM_IMPORT: GoalWriteScope = { mode: "system_import" };

/**
 * Spec for the identity-context single writer on REAL Postgres (the only tier with the
 * constraints/partial-index that make these claims observable). Assertions are derived from
 * what the product should do — 1:1 profile upsert, partial-field preservation, validated
 * inputs, team-scoped mutation, and import-idempotent goals — NOT from reading the impl.
 */

describe("member_profiles upsert (real Postgres)", () => {
  it("is 1:1 and preserves fields not included in a later partial update", async () => {
    const seed = await seedTeam();

    await setMemberProfile(db(), seed.teamId, seed.memberId, {
      timezone: "America/Los_Angeles",
      workingHours: { mon: ["09:00", "17:00"], fri: ["09:00", "12:00"] },
      preferredChannels: ["Slack", "email", "slack"], // mixed case + dup → normalized, deduped
      location: "SF",
      bio: "builds things",
    });

    // A second write touching only timezone must NOT wipe bio/location/channels (partial upsert).
    await setMemberProfile(db(), seed.teamId, seed.memberId, { timezone: "America/New_York" });

    const { data } = await db()
      .from("member_profiles")
      .select("member_id, timezone, working_hours, preferred_channels, location, bio")
      .eq("member_id", seed.memberId);
    expect(data?.length).toBe(1); // exactly one row — 1:1
    const row = data![0] as {
      timezone: string;
      working_hours: Record<string, [string, string]>;
      preferred_channels: string[];
      location: string;
      bio: string;
    };
    expect(row.timezone).toBe("America/New_York");
    expect(row.preferred_channels).toEqual(["slack", "email"]);
    expect(row.working_hours).toEqual({ mon: ["09:00", "17:00"], fri: ["09:00", "12:00"] });
    expect(row.location).toBe("SF");
    expect(row.bio).toBe("builds things");
  });

  it("rejects an invalid timezone, malformed working hours, and an unknown channel", async () => {
    const seed = await seedTeam();
    await expect(
      setMemberProfile(db(), seed.teamId, seed.memberId, { timezone: "Mars/Olympus" })
    ).rejects.toThrow(/timezone/i);
    await expect(
      setMemberProfile(db(), seed.teamId, seed.memberId, { workingHours: { mon: ["9am", "5pm"] } })
    ).rejects.toThrow(/working_hours/);
    await expect(
      setMemberProfile(db(), seed.teamId, seed.memberId, { workingHours: { mon: ["17:00", "09:00"] } })
    ).rejects.toThrow(/before end/);
    await expect(
      setMemberProfile(db(), seed.teamId, seed.memberId, { preferredChannels: ["carrier-pigeon"] })
    ).rejects.toThrow(/channel/i);
  });
});

describe("member_time_off (real Postgres)", () => {
  it("persists a range and refuses an inverted one; delete is team-scoped", async () => {
    const a = await seedTeam();
    const b = await seedTeam();

    const id = await addTimeOff(db(), a.teamId, a.memberId, {
      startsOn: "2026-07-01",
      endsOn: "2026-07-05",
      kind: "pto",
      note: "beach",
    });
    await expect(
      addTimeOff(db(), a.teamId, a.memberId, { startsOn: "2026-07-10", endsOn: "2026-07-01" })
    ).rejects.toThrow(/on\/after/);

    // A delete scoped to a DIFFERENT team must not remove team A's row — and must say so: it is
    // an explicit scope refusal (not a silent no-op), with the row intact and no removal audited.
    await expect(removeTimeOff(db(), b.teamId, a.memberId, id)).rejects.toBeInstanceOf(ProfileScopeRefusal);
    await expect(removeTimeOff(db(), b.teamId, b.memberId, id)).rejects.toBeInstanceOf(ProfileScopeRefusal);
    const after = await db().from("member_time_off").select("id").eq("id", id);
    expect(after.data?.length).toBe(1);
    const refusedAudit = await db().from("audit_log").select("id").eq("action", "timeoff.remove").eq("target_id", id);
    expect(refusedAudit.data).toEqual([]);

    await removeTimeOff(db(), a.teamId, a.memberId, id);
    const gone = await db().from("member_time_off").select("id").eq("id", id);
    expect(gone.data?.length).toBe(0);
    const removedAudit = await db().from("audit_log").select("id").eq("action", "timeoff.remove").eq("target_id", id);
    expect(removedAudit.data?.length).toBe(1);
  });
});

describe("member_goals (real Postgres)", () => {
  it("imported goals are idempotent on (team, source, external_id); manual goals are not deduped", async () => {
    const seed = await seedTeam();

    // Two manual goals with empty external_id both persist (partial unique index ignores them).
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "ship v2", kind: "okr" }, BROWSER_MEMBER);
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "mentor a teammate" }, BROWSER_MEMBER);

    // Re-importing the SAME external goal updates in place rather than duplicating. An importer
    // is the trusted non-browser caller, so it says so explicitly.
    const first = await setMemberGoal(
      db(),
      seed.teamId,
      seed.memberId,
      { title: "Reduce p95 latency", kind: "okr", source: "jira", externalId: "OKR-42", status: "on_track" },
      SYSTEM_IMPORT
    );
    const second = await setMemberGoal(
      db(),
      seed.teamId,
      seed.memberId,
      { title: "Reduce p95 latency by 30%", kind: "okr", source: "jira", externalId: "OKR-42", status: "at_risk" },
      SYSTEM_IMPORT
    );
    expect(second).toBe(first); // same row id — idempotent upsert

    const { data } = await db()
      .from("member_goals")
      .select("id, title, status, source, external_id")
      .eq("member_id", seed.memberId);
    expect(data?.length).toBe(3); // 2 manual + 1 imported (not 4)
    const imported = (data as { external_id: string; title: string; status: string }[]).find(
      (g) => g.external_id === "OKR-42"
    );
    expect(imported?.title).toBe("Reduce p95 latency by 30%");
    expect(imported?.status).toBe("at_risk");
  });

  it("validates status/kind and is deletable team-scoped", async () => {
    const seed = await seedTeam();
    await expect(
      setMemberGoal(db(), seed.teamId, seed.memberId, { title: "x", status: "vibes" as never }, BROWSER_MEMBER)
    ).rejects.toThrow(/status/);
    await expect(
      setMemberGoal(db(), seed.teamId, seed.memberId, { title: "" }, BROWSER_MEMBER)
    ).rejects.toThrow(/title/);

    const id = await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "delete me" }, BROWSER_MEMBER);
    await removeMemberGoal(db(), seed.teamId, seed.memberId, id);
    const gone = await db().from("member_goals").select("id").eq("id", id);
    expect(gone.data?.length).toBe(0);
  });
});

/**
 * AIO-1217 (AC-09/AC-10) at the OWNER: the single writer binds every existing row it touches to
 * the (team, member) scope its caller is bound to. Derived from the accepted contract — a row
 * outside that scope is refused with the typed ProfileScopeRefusal, leaves the row and the audit
 * ledger untouched, and is never repaired, re-homed or reassigned. The action-level proof (real
 * gate + session) lives in server-action-target-binding.datamechanics.test.ts.
 */
describe("AIO-1217 People owner scope (real Postgres)", () => {
  const goalsOf = async (teamId: string) =>
    (await db().from("member_goals").select("*").eq("team_id", teamId).order("id")).data;
  const auditOf = async (teamId: string) =>
    (await db().from("audit_log").select("action, target_id").eq("team_id", teamId).order("id")).data;

  it("People owner mode · setMemberGoal with an omitted or unknown scope mode throws and changes no row", async () => {
    const seed = await seedTeam();
    const id = await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "keep me" }, BROWSER_MEMBER);
    const before = { goals: await goalsOf(seed.teamId), audit: await auditOf(seed.teamId) };

    // `{ actor }` is the pre-AIO-1217 fifth argument: an un-migrated caller must not pick a mode.
    const omitted = [undefined, null, {}, { actor: { kind: "member", memberId: seed.memberId } }, { mode: "trusted" }];
    for (const scope of omitted) {
      await expect(
        setMemberGoal(db(), seed.teamId, seed.memberId, { id, title: "overwritten" }, scope as never)
      ).rejects.toThrow(/goal write scope is required/);
      await expect(
        setMemberGoal(db(), seed.teamId, seed.memberId, { title: "inserted" }, scope as never)
      ).rejects.toThrow(/goal write scope is required/);
    }

    expect({ goals: await goalsOf(seed.teamId), audit: await auditOf(seed.teamId) }).toEqual(before);
  });

  it("People owner mode · browser_member never alters, reassigns or removes a peer's goal or time-off by explicit id or imported dedup key", async () => {
    const seed = await seedTeam();
    const peer = await externalMember(seed); // any second same-team member; posture is irrelevant to the writer
    const peerManual = await setMemberGoal(db(), seed.teamId, peer, { title: "peer manual" }, BROWSER_MEMBER);
    await setMemberGoal(
      db(),
      seed.teamId,
      peer,
      { title: "peer imported", source: "jira", externalId: "OKR-7" },
      BROWSER_MEMBER
    );
    const peerTimeOff = await addTimeOff(db(), seed.teamId, peer, { startsOn: "2026-09-01", endsOn: "2026-09-02" });
    const own = await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "own manual" }, BROWSER_MEMBER);
    const before = {
      goals: await goalsOf(seed.teamId),
      timeOff: (await db().from("member_time_off").select("*").eq("team_id", seed.teamId)).data,
      audit: await auditOf(seed.teamId),
    };
    const self = [db(), seed.teamId, seed.memberId] as const;

    const untyped = (fn: unknown) => fn as (...args: unknown[]) => Promise<unknown>;

    // Thunks, run one at a time: each refusal is observed before the next attempt starts.
    const refused: Array<() => Promise<unknown>> = [
      () => setMemberGoal(...self, { id: peerManual, title: "taken" }, BROWSER_MEMBER),
      () => setMemberGoal(...self, { title: "taken", source: "jira", externalId: "OKR-7" }, BROWSER_MEMBER),
      // GoalInput is browser-supplied: a `mode` smuggled into it selects nothing.
      () => setMemberGoal(...self, { id: peerManual, title: "taken", mode: "system_import" } as never, BROWSER_MEMBER),
      // An explicit update of an OWN goal onto the peer's team-wide import key is a collision.
      () => setMemberGoal(...self, { id: own, title: "own manual", source: "jira", externalId: "OKR-7" }, BROWSER_MEMBER),
      () => setMemberGoal(...self, { id: randomUUID(), title: "absent" }, BROWSER_MEMBER),
      () => removeMemberGoal(...self, peerManual),
      () => removeMemberGoal(...self, randomUUID()),
      () => removeTimeOff(...self, peerTimeOff),
      () => removeTimeOff(...self, randomUUID()),
      // The pre-AIO-1217 (team, id) call shape supplies no target member.
      () => untyped(removeMemberGoal)(db(), seed.teamId, peerManual),
      () => untyped(removeTimeOff)(db(), seed.teamId, peerTimeOff),
    ];
    for (const attempt of refused) await expect(attempt()).rejects.toBeInstanceOf(ProfileScopeRefusal);

    expect({
      goals: await goalsOf(seed.teamId),
      timeOff: (await db().from("member_time_off").select("*").eq("team_id", seed.teamId)).data,
      audit: await auditOf(seed.teamId),
    }).toEqual(before);
  });

  it("People owner mode · system_import keeps team-wide convergence: an explicit id and a dedup match move to the supplied member; a foreign-team or absent id is refused", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const peer = await externalMember(seed);
    const manual = await setMemberGoal(db(), seed.teamId, peer, { title: "peer manual" }, BROWSER_MEMBER);
    const imported = await setMemberGoal(
      db(),
      seed.teamId,
      peer,
      { title: "peer imported", source: "jira", externalId: "OKR-9" },
      SYSTEM_IMPORT
    );

    const moved = await setMemberGoal(db(), seed.teamId, seed.memberId, { id: manual, title: "moved" }, SYSTEM_IMPORT);
    const converged = await setMemberGoal(
      db(),
      seed.teamId,
      seed.memberId,
      { title: "converged", source: "jira", externalId: "OKR-9" },
      SYSTEM_IMPORT
    );
    expect({ moved, converged }).toEqual({ moved: manual, converged: imported });
    const settled = await goalsOf(seed.teamId);
    expect((settled as { id: string; member_id: string; title: string }[]).map((g) => [g.id, g.member_id, g.title]).sort()).toEqual(
      [
        [manual, seed.memberId, "moved"],
        [imported, seed.memberId, "converged"],
      ].sort()
    );

    // The trusted arm is still team-bound: it cannot fabricate success for a row it did not match.
    await expect(
      setMemberGoal(db(), other.teamId, other.memberId, { id: manual, title: "foreign" }, SYSTEM_IMPORT)
    ).rejects.toBeInstanceOf(ProfileScopeRefusal);
    await expect(
      setMemberGoal(db(), seed.teamId, seed.memberId, { id: randomUUID(), title: "absent" }, SYSTEM_IMPORT)
    ).rejects.toBeInstanceOf(ProfileScopeRefusal);
    expect(await goalsOf(seed.teamId)).toEqual(settled);
    expect(await goalsOf(other.teamId)).toEqual([]);
  });

  it("People owner scope · profile and avatar writes refuse a row held under a different team — no re-home, no repair, no audit", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await setMemberProfile(db(), b.teamId, b.memberId, { bio: "b's own bio", location: "B City" });
    const profileOf = async () => (await db().from("member_profiles").select("*").eq("member_id", b.memberId)).data;
    const before = { profile: await profileOf(), auditA: await auditOf(a.teamId), auditB: await auditOf(b.teamId) };
    expect((before.profile as { team_id: string }[]).map((row) => row.team_id)).toEqual([b.teamId]);

    // Team A's scope names B's member: the member's only row belongs to team B.
    await expect(
      setMemberProfile(db(), a.teamId, b.memberId, { bio: "re-homed" })
    ).rejects.toBeInstanceOf(ProfileScopeRefusal);
    await expect(
      setMemberAvatar(db(), a.teamId, b.memberId, "data:image/png;base64,AA==")
    ).rejects.toBeInstanceOf(ProfileScopeRefusal);

    expect({ profile: await profileOf(), auditA: await auditOf(a.teamId), auditB: await auditOf(b.teamId) }).toEqual(before);

    // The rightful (team, member) scope still writes, and an avatar write still preserves fields.
    await setMemberAvatar(db(), b.teamId, b.memberId, "data:image/png;base64,AA==");
    expect(await profileOf()).toEqual([
      expect.objectContaining({
        team_id: b.teamId,
        bio: "b's own bio",
        location: "B City",
        avatar_data_url: "data:image/png;base64,AA==",
      }),
    ]);
  });
});
