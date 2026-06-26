import { describe, expect, it } from "vitest";
import {
  setMemberProfile,
  addTimeOff,
  removeTimeOff,
  setMemberGoal,
  removeMemberGoal,
} from "@/lib/identity/profile";
import { db, seedTeam } from "./helpers";

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

    // A delete scoped to a DIFFERENT team must not remove team A's row.
    await removeTimeOff(db(), b.teamId, id);
    const after = await db().from("member_time_off").select("id").eq("id", id);
    expect(after.data?.length).toBe(1);

    await removeTimeOff(db(), a.teamId, id);
    const gone = await db().from("member_time_off").select("id").eq("id", id);
    expect(gone.data?.length).toBe(0);
  });
});

describe("member_goals (real Postgres)", () => {
  it("imported goals are idempotent on (team, source, external_id); manual goals are not deduped", async () => {
    const seed = await seedTeam();

    // Two manual goals with empty external_id both persist (partial unique index ignores them).
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "ship v2", kind: "okr" });
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "mentor a teammate" });

    // Re-importing the SAME external goal updates in place rather than duplicating.
    const first = await setMemberGoal(db(), seed.teamId, seed.memberId, {
      title: "Reduce p95 latency",
      kind: "okr",
      source: "jira",
      externalId: "OKR-42",
      status: "on_track",
    });
    const second = await setMemberGoal(db(), seed.teamId, seed.memberId, {
      title: "Reduce p95 latency by 30%",
      kind: "okr",
      source: "jira",
      externalId: "OKR-42",
      status: "at_risk",
    });
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
      setMemberGoal(db(), seed.teamId, seed.memberId, { title: "x", status: "vibes" as never })
    ).rejects.toThrow(/status/);
    await expect(
      setMemberGoal(db(), seed.teamId, seed.memberId, { title: "" })
    ).rejects.toThrow(/title/);

    const id = await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "delete me" });
    await removeMemberGoal(db(), seed.teamId, id);
    const gone = await db().from("member_goals").select("id").eq("id", id);
    expect(gone.data?.length).toBe(0);
  });
});
