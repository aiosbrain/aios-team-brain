import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TarFormatError,
  bufferSource,
  classifyLinkTarget,
  classifyMemberPath,
  parsePaxRecords,
  readTarMembers,
} from "../scripts/staging-ops/image-audit/tar-reader.mjs";
import { buildTar, syntheticSecret } from "./helpers/tar-fixture";

/**
 * PUB-07's hostile-archive row, against the reader that will read real image layers.
 *
 * The property under test is NOT "the reader sanitises a path". It is that the reader has no path to
 * sanitise: it parses members, classifies their names, and writes nothing. So each hostile case
 * asserts BOTH that the member is reported AND that the classification says why it would be unsafe to
 * extract — because a reader that silently dropped hostile members would hide content from the scan,
 * which is the same coverage hole from the other side.
 */

const members = (tar: Buffer) => [...readTarMembers(bufferSource(tar))];

describe("tar reader: ordinary members are read exactly", () => {
  it("reads names, types, modes and content hashes", () => {
    const body = "console.log('ok')\n";
    const tar = buildTar([
      { name: "app/", type: "directory" },
      { name: "app/index.js", content: body, mode: 0o644 },
      { name: "app/link", type: "symlink", linkTarget: "index.js" },
    ]);
    const parsed = members(tar);
    expect(parsed.map((m) => [m.name, m.type])).toEqual([
      ["app/", "directory"],
      ["app/index.js", "file"],
      ["app/link", "symlink"],
    ]);
    expect(parsed[1].content()).toEqual({
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
  });

  it("streams content to the caller's sink and nowhere else", () => {
    // The ONE way bytes leave the reader. A member's own name never reaches a filesystem call,
    // which is what makes every hostile case below data rather than a vulnerability.
    const tar = buildTar([{ name: "/etc/shadow", content: "root:x:0:0" }]);
    const chunks: Buffer[] = [];
    const [member] = members(tar);
    member.content((chunk: Buffer) => chunks.push(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("root:x:0:0");
    expect(member.path).toEqual({ safe: false, reason: "absolute" });
  });

  it("refuses to read content from a non-file member", () => {
    const [dir] = members(buildTar([{ name: "app/", type: "directory" }]));
    expect(() => dir.content()).toThrow(/no content/);
  });
});

describe("tar reader: long names (PUB-07, L3)", () => {
  const deep = `app/${"nested-directory-segment/".repeat(9)}a-file-with-a-very-long-name.json`;

  it("reads a GNU long-name member at its FULL path", () => {
    expect(deep.length).toBeGreaterThan(100);
    const [member] = members(buildTar([{ name: deep, content: "{}", gnuLongName: true }]));
    // A reader that ignored the `L` header would report the truncated 100-byte ustar name — a real
    // path, plausible, and wrong, so the inventory comparison would call a known file unexpected.
    expect(member.name).toBe(deep);
    expect(member.content().bytes).toBe(2);
  });

  it("reads a PAX long-name member at its FULL path, including its link target", () => {
    const [member] = members(buildTar([
      { name: deep, type: "symlink", linkTarget: `../${"up/".repeat(20)}target`, paxLongName: true },
    ]));
    expect(member.name).toBe(deep);
    expect(member.linkTarget).toBe(`../${"up/".repeat(20)}target`);
  });

  it("reads a ustar prefix-split long name", () => {
    const [member] = members(buildTar([{ name: deep, content: "{}" }]));
    expect(member.name).toBe(deep);
  });

  it("applies a PAX header to the NEXT member only", () => {
    const parsed = members(buildTar([
      { name: deep, content: "a", paxLongName: true },
      { name: "app/plain.txt", content: "b" },
    ]));
    expect(parsed.map((m) => m.name)).toEqual([deep, "app/plain.txt"]);
  });

  it("parses PAX records whose length field counts its own digits", () => {
    expect(parsePaxRecords("30 path=some/fairly/long/path\n")).toEqual({ path: "some/fairly/long/path" });
    expect(() => parsePaxRecords("9999 path=x\n")).toThrow(TarFormatError);
    expect(() => parsePaxRecords("10 nokeysep\n")).toThrow(TarFormatError);
  });
});

describe("tar reader: hostile members are REPORTED, never extracted (PUB-07)", () => {
  it("classifies an absolute member path", () => {
    const [member] = members(buildTar([{ name: "/etc/cron.d/backdoor", content: "x" }]));
    expect(member.name).toBe("/etc/cron.d/backdoor");
    expect(member.path).toEqual({ safe: false, reason: "absolute" });
  });

  it("classifies a parent-traversal member path", () => {
    const [member] = members(buildTar([{ name: "app/../../../root/.ssh/id_ed25519", content: "x" }]));
    expect(member.path).toEqual({ safe: false, reason: "traversal" });
  });

  it("classifies an escaping symlink AND the member that would be written through it", () => {
    // The two halves of the classic escape. Both are inventoried; neither is followed, because the
    // reader resolves no path at all.
    const parsed = members(buildTar([
      { name: "app/escape", type: "symlink", linkTarget: "../../../../etc" },
      { name: "app/escape/passwd", content: "root:x:0:0" },
    ]));
    expect(parsed[0].type).toBe("symlink");
    expect(classifyLinkTarget(parsed[0].linkTarget)).toEqual({ escapes: true, reason: "traversal" });
    // The follow-through member's own name is ordinary — which is exactly why the LINK has to be
    // classified: nothing about `app/escape/passwd` looks unsafe on its own.
    expect(parsed[1].path.safe).toBe(true);
  });

  it("classifies an absolute symlink target and an external hardlink", () => {
    const parsed = members(buildTar([
      { name: "app/abs", type: "symlink", linkTarget: "/etc/shadow" },
      { name: "app/hard", type: "hardlink", linkTarget: "/etc/shadow" },
    ]));
    expect(parsed.map((m) => m.type)).toEqual(["symlink", "hardlink"]);
    for (const member of parsed) {
      expect(classifyLinkTarget(member.linkTarget)).toEqual({ escapes: true, reason: "absolute" });
      // A link carries no content to read, so there is no host file to open even by mistake.
      expect(() => member.content()).toThrow(/no content/);
    }
  });

  it("classifies contained links as contained", () => {
    expect(classifyLinkTarget("node_modules/.bin/tsc")).toEqual({ escapes: false, reason: "contained" });
    expect(classifyLinkTarget("../lib/index.js")).toEqual({ escapes: false, reason: "contained" });
    expect(classifyMemberPath("app/ok.js")).toEqual({ safe: true, reason: "relative" });
    expect(classifyMemberPath("")).toEqual({ safe: false, reason: "empty" });
  });
});

describe("tar reader: a corrupt or oversized archive FAILS (PUB-02)", () => {
  it("refuses a header whose checksum does not match its bytes", () => {
    expect(() => members(buildTar([{ name: "app/x", content: "y", corruptChecksum: true }]))).toThrow(TarFormatError);
  });

  it("refuses a member whose data runs past the end of the archive", () => {
    const tar = buildTar([{ name: "app/x", content: "y".repeat(1024) }]);
    expect(() => members(tar.subarray(0, 700))).toThrow(TarFormatError);
  });

  it("refuses an archive with more members than the limit allows", () => {
    const tar = buildTar([{ name: "a", content: "1" }, { name: "b", content: "2" }, { name: "c", content: "3" }]);
    expect(() => [...readTarMembers(bufferSource(tar), { maxMembers: 2 })]).toThrow(/2-member limit/);
  });

  it("stops at the end-of-archive marker rather than reading trailing bytes", () => {
    const secret = syntheticSecret();
    const tar = Buffer.concat([buildTar([{ name: "app/x", content: "y" }]), Buffer.from(secret)]);
    expect(members(tar).map((m) => m.name)).toEqual(["app/x"]);
  });
});
