import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => {
  const id = "11111111-1111-4111-8111-111111111111";
  const from = vi.fn((table: string) => {
    const data = table === "items" ? [{id, path:"note", kind:"note", access:"team"}] : [];
    const q = {
      select: vi.fn(() => q), eq: vi.fn(() => q), in: vi.fn(() => Promise.resolve({data})),
      maybeSingle: vi.fn(async () => ({data: table === "teams" ? {id:"team-id",slug:"demo"} : null})),
    };
    return q;
  });
  const client = {from};
  return {id, client, adminClient:vi.fn(() => client), purge:vi.fn(async () => ({items:1,episodes:0})),
    remove:vi.fn(async () => ({deleted:false})), project:vi.fn(async () => ({provider:"linear",reports:[]})),
    record:vi.fn(), extract:vi.fn(async () => ({extracted:1,scanned:1,upserted:1,deleted:0,projectId:"project-id",rows:[]}))};
});
vi.mock("@/lib/db/admin", () => ({adminClient:f.adminClient}));
vi.mock("@/lib/ingest/purge", () => ({purgeItemIds:f.purge}));
vi.mock("@/lib/admin/members", () => ({createMember:vi.fn(),deleteMember:f.remove}));
vi.mock("@/lib/pm-sync", () => ({projectAllTasks:f.project,recordProjectionRun:f.record}));
vi.mock("@/lib/meetings/extract-todos", () => ({extractMeetingTodosForTeam:f.extract,MEETING_TODO_PROJECT_NAME:"Meeting todos"}));
import { main as adminMain } from "../scripts/admin";
import { main as taskMain } from "../scripts/brain-tasks";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://unused:unused@127.0.0.1:1/unused");
  vi.spyOn(console,"log").mockImplementation(() => {});
  vi.spyOn(console,"table").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const purge = ["purge-items","--team","demo","--ids",f.id,"--reason","cleanup"];
const paths = [
  {name:"purge", main:adminMain, argv:purge, flag:"confirm", writer:f.purge, args:[f.client,"team-id",[f.id],"cleanup"]},
  {name:"hard delete", main:adminMain, argv:["delete-member","user@example.com"], flag:"hard", writer:f.remove, args:[f.client,"team-id","user@example.com",{hard:true}]},
  {name:"Linear projection", main:taskMain, argv:["extract-meeting-todos"], flag:"project-to-linear", writer:f.project, args:[f.client,"team-id","project-id"]},
];
describe.each(paths)("AC7 $name call site", ({main,argv,flag,writer,args}) => {
  it("bare flag invokes the writer exactly once with expected arguments", async () => {
    await main([...argv,`--${flag}`]);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(...args);
  });
  for (const value of ["false","true","0","yes","","-x","extra","hunter2"]) {
    for (const form of [[`--${flag}`,value],[`--${flag}=${value}`]]) {
      it(`refuses ${JSON.stringify(form)} before any client or writer`, async () => {
        await expect(main([...argv,...form])).rejects.toThrow(/takes no value/);
        expect(f.adminClient).toHaveBeenCalledTimes(0);
        for (const fake of [f.purge,f.remove,f.project,f.extract,f.record]) expect(fake).toHaveBeenCalledTimes(0);
      });
    }
  }
});
it.each([[],["--dry-run"]])("AC7 purge previews %j", async (...tail) => {
  await adminMain([...purge,...tail]);
  expect(f.purge).toHaveBeenCalledTimes(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("DRY RUN"));
});
it("AC7 task dry-run previews even with projection requested", async () => {
  await taskMain(["extract-meeting-todos","--dry-run","--project-to-linear"]);
  expect(f.project).toHaveBeenCalledTimes(0);
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(f.extract).toHaveBeenCalledWith(f.client,"team-id",expect.objectContaining({dryRun:true}));
});
// Real processes pin entry guards, exit status, and arity ahead of environment/server imports.
for (const script of ["admin","brain-tasks"]) {
  for (const database of [undefined,"postgres://unused:unused@127.0.0.1:1/unused"]) {
    it(`AC5 ${script} malformed, DATABASE_URL=${database ? "set" : "unset"}`, () => {
      const env = {...process.env};
      if (database) env.DATABASE_URL = database; else delete env.DATABASE_URL;
      const argv = script === "admin" ? ["purge-items","--confirm","false"] : ["extract-meeting-todos","--project-to-linear","false"];
      const result = spawnSync(process.execPath,["--import","tsx","--conditions","react-server",`scripts/${script}.ts`,...argv],{env,encoding:"utf8"});
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/takes no value/);
      expect(result.stderr).not.toMatch(/DATABASE_URL|server-only/);
    });
  }
  it(`AC5 ${script} help cannot mask malformed flags; valid help works`, () => {
    const run = (args: string[]) => spawnSync(process.execPath,["--import","tsx","--conditions","react-server",`scripts/${script}.ts`,...args],{encoding:"utf8"});
    const bad = run(["help",script === "admin" ? "--confirm" : "--dry-run","false"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/takes no value/);
    expect(bad.stderr).not.toMatch(/DATABASE_URL|server-only/);
    const good = run(["help"]);
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/Team Brain.*CLI/);
  });
}
