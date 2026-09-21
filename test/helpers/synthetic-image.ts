/**
 * A synthetic single-platform image and its `docker save`-shaped export, for AIO-997 audit tests.
 *
 * Extracted so the content, scan-surface and assembled-run suites drive the SAME fixture shape. A
 * second hand-rolled copy of this builder is how two suites end up disagreeing about what a valid
 * export looks like, and then about which of them found a real bug.
 *
 * Everything here is generated. No real image, digest or credential is used, and the export names its
 * blobs unhelpfully on purpose: the inspector looks members up by hash and never reads the archive's
 * index, so deliberately meaningless names are the honest fixture.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AUDIT_LIMITS, SUBJECT } from "../../scripts/staging-ops/image-audit/subject.mjs";
import { sha256, verifyManifest } from "../../scripts/staging-ops/image-audit/layers.mjs";
import { inspectExport } from "../../scripts/staging-ops/image-audit/inspect.mjs";
import { buildTar } from "./tar-fixture";

export interface SyntheticImageOptions {
  env?: string[];
  history?: string[];
  labels?: Record<string, string>;
  uncompressed?: boolean;
}

export interface SyntheticImage {
  manifestBytes: Buffer;
  manifestDigest: string;
  exportTar: Buffer;
  configBytes: Buffer;
  blobs: Buffer[];
}

export function synthesizeImage(layerTars: Buffer[], options: SyntheticImageOptions = {}): SyntheticImage {
  const blobs = layerTars.map((tar) => (options.uncompressed ? tar : gzipSync(tar)));
  const config = {
    architecture: "amd64",
    os: "linux",
    config: {
      Env: options.env ?? ["PATH=/usr/local/bin", "NODE_ENV=production"],
      Entrypoint: ["/usr/bin/tini", "-s", "--", "node"],
      User: "node",
      Labels: options.labels ?? {
        "org.opencontainers.image.revision": SUBJECT.sourceRevision,
        "org.opencontainers.image.source": `https://github.com/${SUBJECT.repository}`,
      },
    },
    history: (options.history ?? ["RUN npm ci --ignore-scripts"]).map((created_by) => ({ created_by })),
    rootfs: { type: "layers", diff_ids: layerTars.map((tar) => sha256(tar)) },
  };
  const configBytes = Buffer.from(JSON.stringify(config), "utf8");
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(configBytes), size: configBytes.length },
    layers: blobs.map((blob) => ({
      mediaType: options.uncompressed ? "application/vnd.oci.image.layer.v1.tar" : "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: sha256(blob),
      size: blob.length,
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const exportTar = buildTar([
    { name: "oci-layout", content: '{"imageLayoutVersion":"1.0.0"}' },
    { name: "blobs/sha256/aaaaaaaa", content: configBytes },
    ...blobs.map((blob, index) => ({ name: `blobs/sha256/zzzz${index}`, content: blob })),
  ]);
  return { manifestBytes, manifestDigest: sha256(manifestBytes), exportTar, configBytes, blobs };
}

/** Scratch directories this process created, so a suite can clean up in `afterAll`. */
export function scratchPool() {
  const dirs: string[] = [];
  return {
    make(): string {
      const dir = mkdtempSync(join(tmpdir(), "aios-audit-test-"));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An operation budget as `inspectExport` consumes it: only `assert` is reached from inside the walk. */
export interface InspectDeadline {
  assert(operation?: string): unknown;
}

/** Drive the real inspector over a synthetic export. `limits` overrides are merged onto the real ones. */
export async function inspectSynthetic(
  image: SyntheticImage,
  dir: string,
  limits: Partial<typeof AUDIT_LIMITS> = {},
  { deadline }: { deadline?: InspectDeadline } = {},
) {
  const exportPath = join(dir, "image.tar");
  writeFileSync(exportPath, image.exportTar);
  const manifest = verifyManifest(image.manifestBytes, image.manifestDigest);
  const result = await inspectExport({
    exportPath,
    manifest,
    scratchDir: dir,
    limits: { ...AUDIT_LIMITS, ...limits },
    platform: "linux/amd64",
    deadline,
  });
  return { ...result, dir, exportPath };
}

/** Everything the scanner would be pointed at, as one string. The scan surface, measured. */
export function scanSurface(scanDir: string): string {
  return scanFiles(scanDir).map((path) => readFileSync(path, "utf8")).join("\n");
}

/** Every staged scan file, absolute, depth-first. */
export function scanFiles(scanDir: string): string[] {
  return readdirSync(scanDir).flatMap((entry) => {
    const full = join(scanDir, entry);
    return statSync(full).isDirectory() ? scanFiles(full) : [full];
  });
}
