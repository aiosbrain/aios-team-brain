/**
 * Team Brain TASK CLI — make the brain `tasks` table the canonical, easy path.
 *
 * The brain is the source of truth: every task is created/edited HERE and then
 * PROJECTED one-way into the team's primary PM tool (Linear). Never hand-create
 * a Linear issue and expect the brain to know about it — that produces stale
 * context, which is the whole thing the brain exists to prevent. Author here,
 * then `project`.
 *
 * Run:  npx tsx --conditions react-server scripts/brain-tasks.ts <command> [args] [--flags]
 * Prod: railway run -s Postgres bash -lc \
 *         'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/brain-tasks.ts <cmd>'
 *
 * Commands:
 *   add    --team <slug|id> --project <id> --title <t> [--row-key <k>] [--status <s>]
 *          [--priority <p>] [--labels a,b,c] [--parent <row_key>] [--sprint <s>]
 *          [--assignee <text>] [--body-file <path>] [--origin ui|sync]
 *   set    <row_key> --project <id> [--team <slug|id>] [--title <t>] [--status <s>]
 *          [--priority <p>] [--labels a,b,c] [--parent <row_key>] [--sprint <s>]
 *          [--clear-sprint] [--body-file <path>]
 *   list   --team <slug|id> [--project <id>] [--sprint <s>]
 *   show   <row_key> --project <id> [--team <slug|id>]
 *   project --team <slug|id> [--project <id>]   # projectAllTasks (all projects if --project omitted)
 *
 * status:   backlog | ready | in_progress | blocked | done   (default backlog)
 * priority: none | low | medium | high | urgent              (default none)
 */
import { readFileSync } from "node:fs";
import { adminClient } from "@/lib/db/admin";
import { uiRowKey } from "@/lib/ids";
import { normalizeTaskPriority } from "@/lib/api/schemas";
import { projectAllTasks } from "@/lib/pm-sync";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";
import { linearGraphql } from "@/lib/pm-sync/linear-client";

type Flags = Record<string, string | boolean>;
type Admin = ReturnType<typeof adminClient>;
type ResolvePage = {
  team: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { id: string; identifier: string; url: string }[] } } | null;
};

const STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"];

function parseArgs(argv: string[]): { cmd: string; positionals: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(a);
  }
  return { cmd, positionals, flags };
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function resolveTeam(admin: Admin, ref: string) {
  const col = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ref) ? "id" : "slug";
  const { data } = await admin.from("teams").select("id, slug").eq(col, ref).maybeSingle();
  if (!data) die(`no team '${ref}'`);
  return data as { id: string; slug: string };
}

function parseLabels(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== "string") return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readBody(flags: Flags): string | undefined {
  const f = flags["body-file"];
  if (typeof f !== "string") return undefined;
  return readFileSync(f, "utf8");
}

function checkStatus(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!STATUSES.includes(s)) die(`invalid status '${s}' (one of: ${STATUSES.join(", ")})`);
  return s;
}

const USAGE = `Team Brain task CLI — brain is canonical, project one-way to Linear.
  add     --team <slug|id> --project <id> --title <t> [--row-key <k>] [--status <s>]
          [--priority <p>] [--labels a,b,c] [--parent <row_key>] [--sprint <s>]
          [--assignee <text>] [--body-file <path>] [--origin ui|sync]
  set     <row_key> --project <id> [--team <slug|id>] [--title <t>] [--status <s>]
          [--priority <p>] [--labels a,b,c] [--parent <row_key>] [--sprint <s>]
          [--clear-sprint] [--body-file <path>]
  list    --team <slug|id> [--project <id>] [--sprint <s>]
  show    <row_key> --project <id> [--team <slug|id>]
  project --team <slug|id> [--project <id>]
  resolve --team <slug|id> [--filter <substr>]      # Linear identifier → node UUID + url
  adopt   <row_key> --project <id> --resource-id <linear-uuid> [--url <u>]  # bind to existing issue
status: ${STATUSES.join(" | ")}   priority: none|low|medium|high|urgent
Requires DATABASE_URL (postgres). Defaults --team aios.`;

// Null the stored projection_fingerprint on a row's links so the next `project` re-writes the
// provider even if only fields the engine already saw changed. Idempotent + cheap.
async function bumpFingerprint(admin: Admin, teamId: string, projectId: string, rowKey: string) {
  await admin
    .from("task_pm_links")
    .update({ projection_fingerprint: null })
    .eq("team_id", teamId)
    .eq("project_id", projectId)
    .eq("row_key", rowKey);
}

async function main() {
  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || flags.help) return console.log(USAGE);
  if (!process.env.DATABASE_URL) die("DATABASE_URL is required");

  const admin = adminClient();
  const teamSlug = (flags.team as string) || "aios";

  switch (cmd) {
    case "add": {
      const title = (flags.title as string)?.trim() || die("--title required");
      const projectId = (flags.project as string) || die("--project <id> required");
      const team = await resolveTeam(admin, teamSlug);
      const row = {
        team_id: team.id,
        project_id: projectId,
        row_key: (flags["row-key"] as string) || uiRowKey(),
        title,
        assignee: (flags.assignee as string) || "",
        sprint: (flags.sprint as string) || "",
        status: checkStatus(flags.status as string) || "backlog",
        priority: normalizeTaskPriority((flags.priority as string) || "none"),
        labels: parseLabels(flags.labels) ?? [],
        parent_row_key: (flags.parent as string) || null,
        body: readBody(flags) ?? "",
        origin: ((flags.origin as string) || "ui") as "ui" | "sync",
      };
      const { data, error } = await admin
        .from("tasks")
        .insert(row)
        .select("id, row_key, title, status, priority, parent_row_key")
        .single();
      if (error) die(error.message);
      const t = data as { id: string; row_key: string };
      console.log(`✓ added task ${t.row_key} (${t.id}) — "${title}" [${row.status}/${row.priority}]`);
      break;
    }
    case "set": {
      const rowKey = positionals[0] || die("usage: set <row_key> --project <id>");
      const projectId = (flags.project as string) || die("--project <id> required");
      const team = await resolveTeam(admin, teamSlug);
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (flags.title !== undefined) update.title = flags.title;
      if (flags.status !== undefined) update.status = checkStatus(flags.status as string);
      if (flags.priority !== undefined) update.priority = normalizeTaskPriority(flags.priority as string);
      if (flags.labels !== undefined) update.labels = parseLabels(flags.labels) ?? [];
      if (flags.parent !== undefined) update.parent_row_key = (flags.parent as string) || null;
      if (flags["clear-sprint"]) update.sprint = "";
      else if (flags.sprint !== undefined) update.sprint = flags.sprint;
      const body = readBody(flags);
      if (body !== undefined) update.body = body;

      const { data, error } = await admin
        .from("tasks")
        .update(update)
        .eq("team_id", team.id)
        .eq("project_id", projectId)
        .eq("row_key", rowKey)
        .select("id, row_key, title")
        .maybeSingle();
      if (error) die(error.message);
      if (!data) die(`no task '${rowKey}' in project ${projectId}`);
      await bumpFingerprint(admin, team.id, projectId, rowKey);
      console.log(`✓ updated ${rowKey}: ${Object.keys(update).filter((k) => k !== "updated_at").join(", ")} (re-project to push)`);
      break;
    }
    case "list": {
      const team = await resolveTeam(admin, teamSlug);
      let q = admin
        .from("tasks")
        .select("row_key, title, status, priority, sprint, parent_row_key")
        .eq("team_id", team.id);
      if (flags.project) q = q.eq("project_id", flags.project as string);
      if (flags.sprint) q = q.eq("sprint", flags.sprint as string);
      const { data } = await q.order("row_key");
      console.table(data ?? []);
      break;
    }
    case "show": {
      const rowKey = positionals[0] || die("usage: show <row_key> --project <id>");
      const projectId = (flags.project as string) || die("--project <id> required");
      const team = await resolveTeam(admin, teamSlug);
      const { data } = await admin
        .from("tasks")
        .select("id, row_key, title, status, priority, labels, sprint, parent_row_key, assignee, body")
        .eq("team_id", team.id)
        .eq("project_id", projectId)
        .eq("row_key", rowKey)
        .maybeSingle();
      if (!data) die(`no task '${rowKey}' in project ${projectId}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case "project": {
      const team = await resolveTeam(admin, teamSlug);
      let projectIds: string[];
      if (flags.project) projectIds = [flags.project as string];
      else {
        const { data } = await admin.from("projects").select("id").eq("team_id", team.id);
        projectIds = ((data ?? []) as { id: string }[]).map((p) => p.id);
      }
      for (const pid of projectIds) {
        const { provider, reports, reason } = await projectAllTasks(admin, team.id, pid);
        if (reason) {
          console.log(`• project ${pid}: no projection (${reason})`);
          continue;
        }
        const counts: Record<string, number> = {};
        for (const r of reports) counts[r.status] = (counts[r.status] ?? 0) + 1;
        const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "no rows";
        console.log(`✓ project ${pid} → ${provider}: ${summary}`);
        const notable = reports.filter((r) => !["synced", "skipped"].includes(r.status));
        for (const r of notable) console.log(`    ${r.status.padEnd(18)} ${r.row_key}${r.error ? ` — ${r.error}` : ""}`);
      }
      break;
    }
    case "resolve": {
      // Dump Linear identifier → node UUID + url for the team's Linear integration, so existing
      // issues can be adopted (brain-canonical) without editing their descriptions. --filter greps
      // identifiers (case-insensitive substring).
      const team = await resolveTeam(admin, teamSlug);
      const integrations = await getEnabledIntegrationsWithSecrets(admin, team.id);
      const lin = integrations.find((i) => i.type === "linear" && i.secret);
      if (!lin) die("no enabled Linear integration with a secret for this team");
      const teamId = (lin.config as { teamId?: string } | null)?.teamId || die("Linear integration has no config.teamId");
      const filter = typeof flags.filter === "string" ? (flags.filter as string).toLowerCase() : null;
      const rows: { identifier: string; id: string; url: string }[] = [];
      let after: string | null = null;
      for (let i = 0; i < 100; i++) {
        const page: ResolvePage = await linearGraphql<ResolvePage>(
          fetch,
          lin.secret as string,
          `query ResolveIssues($teamId: String!, $after: String) {
            team(id: $teamId) { issues(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id identifier url } } }
          }`,
          { teamId, after }
        );
        const conn = page.team?.issues;
        if (!conn) break;
        for (const n of conn.nodes) if (!filter || n.identifier.toLowerCase().includes(filter)) rows.push(n);
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
      rows.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
      for (const r of rows) console.log(`${r.identifier}\t${r.id}\t${r.url}`);
      console.error(`(${rows.length} issues)`);
      break;
    }
    case "adopt": {
      // Bind a brain task's row_key to an EXISTING Linear issue (by node UUID) so the next `project`
      // updates it in place instead of creating a duplicate. Idempotent.
      const rowKey = positionals[0] || die("usage: adopt <row_key> --project <id> --resource-id <linear-uuid>");
      const projectId = (flags.project as string) || die("--project <id> required");
      const resourceId = (flags["resource-id"] as string) || die("--resource-id <linear-uuid> required");
      const team = await resolveTeam(admin, teamSlug);
      const { data: task } = await admin
        .from("tasks")
        .select("id")
        .eq("team_id", team.id)
        .eq("project_id", projectId)
        .eq("row_key", rowKey)
        .maybeSingle();
      // Require the brain task to exist: a link with a null task_id would still exclude this Linear
      // issue from inbound import (by resource id), then the next mirror diff-delete drops its synced
      // row — silently orphaning a genuinely Linear-authored task. Add the task first.
      const taskId = (task as { id: string } | null)?.id;
      if (!taskId) die(`no brain task '${rowKey}' in project ${projectId} — \`add\` it before \`adopt\``);
      const { data: existing } = await admin
        .from("task_pm_links")
        .select("id")
        .eq("team_id", team.id)
        .eq("project_id", projectId)
        .eq("row_key", rowKey)
        .eq("provider", "linear")
        .maybeSingle();
      const patch = {
        task_id: taskId,
        provider_resource_id: resourceId,
        provider_url: (flags.url as string) || "",
        projection_fingerprint: null,
        updated_at: new Date().toISOString(),
      };
      const { error: adoptErr } = existing
        ? await admin.from("task_pm_links").update(patch).eq("id", (existing as { id: string }).id)
        : await admin.from("task_pm_links").insert({
            team_id: team.id,
            project_id: projectId,
            row_key: rowKey,
            provider: "linear",
            provider_external_id: rowKey,
            provider_external_source: "aios-backlog",
            ...patch,
          });
      if (adoptErr) die(adoptErr.message);
      console.log(`✓ adopted ${rowKey} → linear ${resourceId} (re-project to push brain state)`);
      break;
    }
    default:
      die(`unknown command '${cmd}'\n\n${USAGE}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => die(e instanceof Error ? e.message : String(e)));
