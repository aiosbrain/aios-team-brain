/** A release tag is EXACTLY `vX.Y.Z`. No pre-release, build metadata, or leading zeros. */
export const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/**
 * Side-effect-free release-candidate decision shared by the tag gate and the trusted controller.
 * This module must remain safe to import when the controller process itself was invoked with
 * `--run`; executable entrypoint acknowledgement belongs only to the two owning CLI modules.
 */
export function releaseCandidateVerdict({
  tagName,
  tagObjectType,
  taggedTreeVersion,
  mainIsAncestor,
  reachableFromIntegration,
}) {
  const failures = [];

  if (!RELEASE_TAG.test(String(tagName))) {
    failures.push(
      `A: ${tagName} is not exactly vX.Y.Z. Pre-release and build-metadata tags are refused rather ` +
        `than skipped, so the refusal is LOUD — use a non-\`v\` prefix (\`rc/\`, \`cutover/\`) for ` +
        `anything that is not a release.`
    );
  } else if (tagObjectType !== "tag") {
    failures.push(
      `A: ${tagName} is a LIGHTWEIGHT tag (object type ${tagObjectType ?? "unknown"}). A release tag ` +
        `must be annotated, so it carries an author, a date and a message.`
    );
  }

  if (RELEASE_TAG.test(String(tagName))) {
    const expected = String(tagName).slice(1);
    if (taggedTreeVersion !== expected) {
      failures.push(
        `B: ${tagName} points at a tree whose package.json version is ${taggedTreeVersion ?? "absent"}, ` +
          `not ${expected}. Either the version bump is missing or the tag is on the wrong commit.`
      );
    }
  }

  if (mainIsAncestor !== true) {
    failures.push(
      `C: the current \`main\` is not an ancestor of this commit, so advancing \`main\` to it would ` +
        `not be a fast-forward.`
    );
  }

  if (reachableFromIntegration !== true) {
    failures.push(
      `D: this commit is not reachable from the integration branch, so it never crossed integration. ` +
        `A+B+C alone certify only "some descendant of main", not "the release".`
    );
  }

  return { verdict: failures.length === 0 ? "PASS" : "FAIL", failures };
}
