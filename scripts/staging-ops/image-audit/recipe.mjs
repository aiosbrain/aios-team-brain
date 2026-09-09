/**
 * AIO-997 audit — MEASURED assertions about the build recipe that produced the pinned image.
 *
 * READ THE CEILING FIRST (M3). This is evidence that the build's CONFIGURED INPUTS were public and
 * carried no credential. It is **not** a hermeticity claim and must never be reported as one: the
 * Dockerfile runs `apt-get`, `curl` and `npm ci` against the network, base images move underneath
 * tags, and public bytes can themselves contain credentials. Everything here can be satisfied while
 * the image still contains a secret — which is exactly why it supplements scanning every layer and
 * never substitutes for it.
 *
 * EVERY ROW IS satisfied | violated | unverified. `unverified` is used whenever the input could not
 * be read, and it is NOT the same as `satisfied` — an assertion nobody could evaluate is a gap in the
 * evidence, and the readiness computation treats it as one.
 *
 * The files are read from the ORIGINAL source checkout at the pinned revision, in a separate
 * directory with no persisted credentials — never from the audit's own checkout, which is different
 * code at a different commit.
 */
import { createHash } from "node:crypto";

export const RECIPE_FILES = Object.freeze([
  ".github/workflows/staging-ops-image.yml",
  "docker/staging-ops.Dockerfile",
  ".dockerignore",
  "package-lock.json",
]);

const satisfied = (id, detail) => ({ id, status: "satisfied", detail });
const violated = (id, detail) => ({ id, status: "violated", detail });
const unverified = (id, detail) => ({ id, status: "unverified", detail });

/**
 * The publisher workflow at the pinned revision: did it have anything to bake in?
 *
 * Text-level checks on a YAML file are usually the wrong tool, but the property here IS textual —
 * "the string `secrets.` does not occur" is precisely the claim, and parsing would only let a
 * secret reference reach the build through a shape the parser normalised away.
 */
export function workflowAssertions(text) {
  if (text === undefined) return [unverified("workflow.readable", "the publisher workflow could not be read at the pinned revision")];
  const secretRefs = text.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const varRefs = text.match(/vars\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [
    secretRefs.length === 0
      ? satisfied("workflow.no-secret-refs", "the publisher referenced no repository/environment secret")
      : violated("workflow.no-secret-refs", `${secretRefs.length} secret reference(s) were in scope during the build`),
    varRefs.length === 0
      ? satisfied("workflow.no-vars-refs", "the publisher referenced no configuration variable")
      : violated("workflow.no-vars-refs", `${varRefs.length} vars reference(s) were in scope during the build`),
    /persist-credentials:\s*false/.test(text)
      ? satisfied("workflow.checkout-credentials-off", "the checkout did not persist credentials into .git")
      : violated("workflow.checkout-credentials-off", "the checkout may have persisted credentials into .git"),
    /^\s*(secrets|secret-files|build-args|ssh):/m.test(text)
      ? violated("workflow.no-build-secret-forwarding", "the build step forwarded secrets, build-args or an ssh agent")
      : satisfied("workflow.no-build-secret-forwarding", "no secret, build-arg or ssh forwarding reached the build step"),
  ];
}

/** The Dockerfile at the pinned revision: no build argument and no secret mount could carry a value in. */
export function dockerfileAssertions(text) {
  if (text === undefined) return [unverified("dockerfile.readable", "the Dockerfile could not be read at the pinned revision")];
  const args = text.match(/^\s*ARG\s+\S+/gm) ?? [];
  const mounts = text.match(/--mount=type=(secret|ssh)/g) ?? [];
  return [
    args.length === 0
      ? satisfied("dockerfile.no-build-args", "the Dockerfile declared no ARG a caller could populate")
      : violated("dockerfile.no-build-args", `${args.length} ARG declaration(s) could have carried a build-time value`),
    mounts.length === 0
      ? satisfied("dockerfile.no-secret-mounts", "the Dockerfile mounted no secret or ssh agent")
      : violated("dockerfile.no-secret-mounts", `${mounts.length} secret/ssh mount(s) were available to the build`),
  ];
}

/**
 * `.dockerignore` at the pinned revision. `.git` is the one entry with a specific, demonstrated
 * failure behind it: a persisted checkout credential lives there, and `COPY . .` would bake it in.
 */
export function dockerignoreAssertions(text) {
  if (text === undefined) return [unverified("dockerignore.readable", "the .dockerignore could not be read at the pinned revision")];
  const entries = text.split("\n").map((line) => line.trim());
  const required = [".git", ".env", ".context"];
  const absent = required.filter((entry) => !entries.includes(entry));
  return [
    absent.length === 0
      ? satisfied("dockerignore.excludes-sensitive-trees", `the build context excluded ${required.join(", ")}`)
      : violated("dockerignore.excludes-sensitive-trees", `the build context did not exclude ${absent.join(", ")}`),
  ];
}

/**
 * The lockfile at the pinned revision: every dependency resolved to a URL and pinned by integrity.
 *
 * This says the DEPENDENCY SET was addressed by content hash. It says nothing about what those
 * packages contain — a hash-pinned dependency carrying a credential is hash-pinned and carrying a
 * credential, which is why every one of those files is still scanned in the image.
 */
export function lockfileAssertions(text) {
  if (text === undefined) return [unverified("lockfile.readable", "the lockfile could not be read at the pinned revision")];
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return [unverified("lockfile.parseable", "the lockfile at the pinned revision did not parse")];
  }
  const packages = lock?.packages ?? {};
  let checked = 0;
  const unresolved = [];
  for (const [path, entry] of Object.entries(packages)) {
    // The root project and workspace links have no registry origin to pin, by construction.
    if (path === "" || entry?.link === true) continue;
    checked += 1;
    const resolved = typeof entry?.resolved === "string" && entry.resolved.startsWith("https://");
    const integrity = typeof entry?.integrity === "string" && entry.integrity.length > 0;
    if (!resolved || !integrity) unresolved.push(path);
  }
  if (checked === 0) return [unverified("lockfile.resolved-and-pinned", "the lockfile declared no resolvable package entries")];
  return [
    unresolved.length === 0
      ? satisfied("lockfile.resolved-and-pinned", `all ${checked} package entries carry an https resolved URL and an integrity hash`)
      : violated("lockfile.resolved-and-pinned", `${unresolved.length} of ${checked} package entries lack a resolved URL or integrity hash`),
  ];
}

/**
 * All of it, plus the hash of each file the assertions were derived from — so a later reader can tell
 * WHICH bytes were measured rather than trusting that a path implies a content.
 */
export function recipeEvidence(files) {
  const assertions = [
    ...workflowAssertions(files[".github/workflows/staging-ops-image.yml"]),
    ...dockerfileAssertions(files["docker/staging-ops.Dockerfile"]),
    ...dockerignoreAssertions(files[".dockerignore"]),
    ...lockfileAssertions(files["package-lock.json"]),
  ];
  const sourceHashes = {};
  for (const path of RECIPE_FILES) {
    sourceHashes[path] = files[path] === undefined
      ? "unreadable"
      : `sha256:${createHash("sha256").update(files[path]).digest("hex")}`;
  }
  const counts = assertions.reduce((totals, assertion) => ({ ...totals, [assertion.status]: (totals[assertion.status] ?? 0) + 1 }), {});
  return Object.freeze({
    assertions: Object.freeze(assertions.map((assertion) => Object.freeze(assertion))),
    sourceHashes: Object.freeze(sourceHashes),
    counts: Object.freeze(counts),
    // Stated IN the artifact, not only in this comment: a reader of the evidence must not be able to
    // mistake these rows for a proof that nothing entered the image from the network.
    limitation:
      "these are configured-input assertions about the reviewed build recipe, NOT a hermeticity claim: " +
      "base images, apt and npm fetches and build-time processes can introduce content, and public bytes " +
      "can contain credentials. Scanning every layer is what covers that, not these rows.",
  });
}
