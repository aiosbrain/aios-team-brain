/**
 * seed-demo.ts — load the Northwind Robotics sample + Veridian graph as a demo team.
 *
 * Runs every file through lib/ingest (the production write path) so seeding
 * doubles as an ingest regression test: 8 task rows and 20 decision rows must
 * materialize. Idempotent — sha-dedupe makes re-runs no-ops.
 *
 * Usage: npx tsx scripts/seed-demo.ts   (requires .env.local / env vars)
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ingestItem } from "../lib/ingest";
import { normalizeTier } from "../lib/api/schemas";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (try: npx dotenv -e .env.local -- …, or export them)");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const FIXTURES = path.resolve(__dirname, "..", "fixtures");
const PROJECT_SLUG = "northwind-aios";

// ── minimal frontmatter + table parsers (mirrors scripts/aios.mjs in agentic-team-ops) ──
function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  if (!content.startsWith("---")) return { fm: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: content };
  const fmText = content.slice(content.indexOf("\n") + 1, end);
  const body = content.slice(content.indexOf("\n", end + 1) + 1);
  const fm: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fm, body };
}

function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length && !cells.every((c) => /^[-: ]*$/.test(c)));
}

function parseTaskRows(body: string) {
  const rows = tableRows(body);
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.toLowerCase());
  const i = (name: string) => h.indexOf(name);
  if (i("id") < 0) return [];
  return rows.slice(1).map((c) => ({
    row_key: c[i("id")] ?? "",
    title: c[i("task")] ?? "",
    assignee: i("assignee") >= 0 ? c[i("assignee")] ?? "" : "",
    status: i("status") >= 0 ? c[i("status")] ?? "" : "",
    sprint: i("sprint") >= 0 ? c[i("sprint")] ?? "" : "",
    due: i("due") >= 0 ? c[i("due")] || null : null,
  })).filter((r) => r.row_key);
}

function parseDecisionRows(body: string) {
  const rows = tableRows(body);
  if (!rows.length) return [];
  const h = rows[0].map((x) => x.toLowerCase());
  const i = (pfx: string) => h.findIndex((x) => x.startsWith(pfx));
  if (i("decision") < 0) return [];
  return rows.slice(1).map((c) => ({
    row_key: c[i("#")] ?? c[0] ?? "",
    decided_at: i("date") >= 0 ? c[i("date")] || null : null,
    title: c[i("decision")] ?? "",
    rationale: i("rationale") >= 0 ? c[i("rationale")] ?? "" : "",
    decided_by: i("decided") >= 0 ? c[i("decided")] ?? "" : "",
    impact: i("impact") >= 0 ? c[i("impact")] ?? "" : "",
    tier: i("type") >= 0 ? parseInt(c[i("type")], 10) || null : null,
    audience: i("audience") >= 0 ? c[i("audience")] || "team" : "team",
  })).filter((r) => r.row_key);
}

function classifyKind(rel: string, fm: Record<string, string>) {
  if (rel.endsWith("decision-log.md")) return "decision" as const;
  if (rel.endsWith("tasks.md")) return "task" as const;
  if (fm.type === "transcript" || rel.includes("/transcripts/")) return "transcript" as const;
  if (rel.startsWith("02-deliverables/")) return "deliverable" as const;
  return "artifact" as const;
}

function* walk(dir: string, base: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) yield* walk(abs, base);
    else if (entry.endsWith(".md")) yield path.relative(base, abs);
  }
}

async function main() {
  // 1. demo team
  const { data: team, error: teamErr } = await supabase
    .from("teams")
    .upsert({ slug: "demo", name: "Northwind Robotics — AI Transformation" }, { onConflict: "slug" })
    .select("id")
    .single();
  if (teamErr || !team) throw new Error(`team: ${teamErr?.message}`);

  // 2. members
  const memberDefs = [
    { actor_handle: "alex", display_name: "Alex", email: "alex@demo.aios.local", role: "admin" },
    { actor_handle: "riley", display_name: "Riley", email: "riley@demo.aios.local", role: "member" },
    { actor_handle: "jordan", display_name: "Jordan", email: "jordan@demo.aios.local", role: "member" },
    { actor_handle: "sam", display_name: "Sam", email: "sam@demo.aios.local", role: "lead" },
  ];
  const members: Record<string, string> = {};
  for (const m of memberDefs) {
    const { data } = await supabase
      .from("members")
      .upsert({ team_id: team.id, ...m, status: "active" }, { onConflict: "team_id,email" })
      .select("id, actor_handle")
      .single();
    if (data) members[data.actor_handle] = data.id;
  }

  // 3. demo API key (printed once; sha256 stored)
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `aios_${keyId}_${secret}`;
  await supabase.from("api_keys").insert({
    team_id: team.id,
    member_id: members["alex"],
    key_id: keyId,
    key_hash: createHash("sha256").update(secret).digest("hex"),
    name: "seed-demo key",
  });

  // 4. ingest Northwind through lib/ingest (regression test for the write path)
  const nw = path.join(FIXTURES, "northwind");
  const auth = { teamId: team.id, memberId: members["alex"], apiKeyId: "00000000-0000-0000-0000-000000000000" };
  let pushed = 0, skipped = 0;
  for (const rel of walk(nw, nw)) {
    const raw = readFileSync(path.join(nw, rel), "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const tier = normalizeTier(fm.access || "");
    if (!tier) { skipped++; continue; } // default-deny: untagged/admin never ingests
    const kind = classifyKind(rel, fm);
    const rows =
      kind === "task" ? parseTaskRows(body)
      : kind === "decision" ? parseDecisionRows(body)
      : undefined;
    await ingestItem(
      supabase,
      auth,
      {
        project: PROJECT_SLUG,
        path: rel,
        kind,
        content_sha256: createHash("sha256").update(raw).digest("hex"),
        actor: fm.owner || "alex",
        access: tier,
        frontmatter: fm,
        body,
        rows,
      },
      tier
    );
    pushed++;
  }

  // 5. Veridian graph
  const v = path.join(FIXTURES, "veridian");
  const load = (f: string) => JSON.parse(readFileSync(path.join(v, f), "utf8"));
  const entityFiles: [string, string, string][] = [
    ["actors.json", "actors", "actor"],
    ["workflows.json", "workflows", "workflow"],
    ["decisions.json", "decisions", "decision"],
    ["commitments.json", "commitments", "commitment"],
    ["value-objects.json", "value_objects", "value_object"],
  ];
  let entities = 0;
  for (const [file, arrayKey, type] of entityFiles) {
    const json = load(file);
    const items = Array.isArray(json) ? json : json[arrayKey] ?? Object.values(json)[0];
    for (const e of items as Record<string, unknown>[]) {
      await supabase.from("graph_entities").upsert(
        {
          team_id: team.id,
          entity_id: String(e.id),
          entity_type: type,
          name: String(e.name ?? e.title ?? ""),
          attrs: e,
        },
        { onConflict: "team_id,entity_id" }
      );
      entities++;
    }
  }
  const relJson = load("relationships.json");
  const rels = Array.isArray(relJson) ? relJson : relJson.relationships ?? Object.values(relJson)[0];
  let relCount = 0;
  for (const r of rels as Record<string, unknown>[]) {
    const { error } = await supabase.from("graph_relationships").upsert(
      {
        team_id: team.id,
        from_id: String(r.from_id),
        to_id: String(r.to_id),
        relationship_type: String(r.relationship_type),
        attrs: r,
      },
      { onConflict: "team_id,from_id,to_id,relationship_type" }
    );
    if (!error) relCount++;
  }

  // 6. verify materialization (the regression assertions)
  const { count: taskCount } = await supabase
    .from("tasks").select("id", { count: "exact", head: true }).eq("team_id", team.id);
  const { count: decisionCount } = await supabase
    .from("decisions").select("id", { count: "exact", head: true }).eq("team_id", team.id);
  const { count: itemCount } = await supabase
    .from("items").select("id", { count: "exact", head: true }).eq("team_id", team.id);

  console.log(`team: demo (${team.id})`);
  console.log(`members: ${Object.keys(members).join(", ")}`);
  console.log(`items ingested: ${pushed} (skipped untagged/admin: ${skipped}) → ${itemCount} in db`);
  console.log(`tasks materialized: ${taskCount}`);
  console.log(`decisions materialized: ${decisionCount}`);
  console.log(`graph: ${entities} entities, ${relCount} relationships`);
  console.log("");
  console.log(`demo API key (shown once): ${fullKey}`);

  if ((taskCount ?? 0) < 8) throw new Error(`expected >=8 tasks, got ${taskCount}`);
  if ((decisionCount ?? 0) < 20) throw new Error(`expected >=20 decisions, got ${decisionCount}`);
  console.log("\nregression assertions passed (>=8 tasks, >=20 decisions).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
