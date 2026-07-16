/**
 * Backfill: re-run the upload-time extraction (summary + attendees + action items) over meeting
 * notes that ALREADY exist, so notes saved with a blank summary (the array-shaped-summary parser
 * bug) show up "as if they'd just been uploaded". Routes through the team's configured answering
 * model (incl. OpenRouter) exactly like a live upload, and uses the same single-writer writers, so
 * there is no second write path. Idempotent and safe to re-run.
 *
 * Run (all teams, full refresh):
 *   DATABASE_URL=… SECRETS_KEY=… npx tsx --conditions react-server scripts/backfill-meeting-summaries.ts
 * Options:
 *   [teamSlug]     limit to one team
 *   --only-blank   only heal notes whose summary is currently blank (skip ones already populated)
 *   --limit=N      cap notes processed per team
 */
import { adminClient } from "@/lib/db/admin";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { refreshMeetingNoteExtraction } from "@/lib/meetings/refresh";

type TeamRow = { id: string; slug: string; name: string };

async function main() {
  const argv = process.argv.slice(2);
  const onlyBlank = argv.includes("--only-blank");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  const teamSlug = argv.find((a) => !a.startsWith("--"));

  const admin = adminClient();
  const q = admin.from("teams").select("id, slug, name");
  const { data: teamData, error } = teamSlug ? await q.eq("slug", teamSlug) : await q;
  if (error) throw new Error(`load teams failed: ${error.message}`);
  const teams = (teamData ?? []) as TeamRow[];
  if (teams.length === 0) {
    console.error(teamSlug ? `no team with slug "${teamSlug}"` : "no teams found");
    process.exit(1);
  }

  console.log(
    `refreshing meeting notes for ${teams.length} team(s)` +
      `${onlyBlank ? " [only blank summaries]" : " [full refresh]"}${limit ? ` [limit ${limit}/team]` : ""}\n`
  );

  let totalSummarized = 0;
  let totalActionItems = 0;
  for (const t of teams) {
    const keys = await resolveAnsweringKeys(admin, t.id);
    const provider = keys.activeProvider ?? "auto";
    process.stdout.write(`• ${t.name} (${t.slug}) — answering=${provider} … `);
    try {
      const res = await refreshMeetingNoteExtraction(admin, t.id, { keys, onlyBlank, limit });
      totalSummarized += res.summarized;
      totalActionItems += res.actionItems;
      console.log(
        `scanned ${res.scanned}, summarized ${res.summarized}, action items ${res.actionItems}, skipped ${res.skipped}`
      );
    } catch (e) {
      console.log(`FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\n✓ done: ${totalSummarized} note(s) summarized, ${totalActionItems} action item(s) materialized`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
