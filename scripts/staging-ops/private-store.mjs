import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

function safeId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(id ?? ""))) throw new Error("invalid immutable bundle ID");
  return id;
}

export class PrivateFileStore {
  constructor({ root, role }) {
    if (!path.isAbsolute(root)) throw new Error("private store root must be absolute");
    if (!new Set(["publisher", "source-reader", "rollback-owner"]).has(role)) throw new Error("invalid private store role");
    this.root = root; this.role = role;
  }
  file(id) { return path.join(this.root, `${safeId(id)}.bundle`); }
  async putImmutable(id, bytes) {
    if (this.role === "source-reader") throw new Error("source bundle identity is read-only");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.file(id);
    const temp = `${target}.${process.pid}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      // link(2) is the no-clobber publication primitive. rename(2) would overwrite a file
      // published after a preceding stat and is therefore unsafe under concurrent retries.
      await link(temp, target);
      await chmod(target, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error(`immutable bundle ${id} already exists with different bytes`);
    } finally {
      await unlink(temp).catch(() => {});
    }
    await this.syncDirectory();
    return target;
  }
  async syncDirectory() {
    const directory = await open(this.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async read(id) {
    if (this.role === "publisher") throw new Error("publisher identity is write-only");
    return readFile(this.file(id));
  }
  async list(prefix = "") {
    if (this.role === "publisher") throw new Error("publisher identity cannot list source bundles");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.root).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    return entries.filter((name) => name.endsWith(".bundle") && name.startsWith(prefix)).map((name) => name.slice(0, -7)).sort();
  }
  async verify(id, expectedSha256) {
    const bytes = await this.read(id);
    return createHash("sha256").update(bytes).digest("hex") === expectedSha256;
  }
  async pinFrom(source, id) {
    if (this.role !== "rollback-owner") throw new Error("only rollback owner may pin a source bundle");
    const bytes = await source.read(id);
    await this.putImmutable(id, bytes);
    return bytes;
  }
  async writePointer(name, value) {
    if (this.role !== "rollback-owner" || !/^[a-z-]+$/.test(name)) throw new Error("only rollback owner may update a named pointer");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, `${name}.json`); const temp = `${target}.${process.pid}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target); await chmod(target, 0o600); await this.syncDirectory();
  }
  async readPointer(name) { return JSON.parse(await readFile(path.join(this.root, `${name}.json`), "utf8")); }
  async delete(id) {
    if (this.role !== "rollback-owner") throw new Error("only rollback owner may delete a retained bundle");
    await unlink(this.file(id)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    await this.syncDirectory();
  }
}

export async function withPrivateTempDir(prefix, body) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(root, 0o700);
  try { return await body(root); }
  finally { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); }
}
