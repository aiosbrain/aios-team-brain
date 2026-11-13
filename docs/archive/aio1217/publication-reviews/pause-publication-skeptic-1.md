**FINDING_STANDS**: I could not refute it from the supplied source. The guard fails deterministically on these files, though this is a red-guard and hygiene defect, not an auth exposure.

**Why the counterarguments fail**

- **"Scanner ignores docs"**: it does not. `SERVER_ACTION_EXCLUSIONS.rootNames` has no `docs` entry, and `exclusionFor` matches root names exactly. The root `.context` exclusion is relative to the supplied root, so the worktree living under a parent `.context/` does not help.
- **"Documentation only / not imported / unused"**: irrelevant by design. `discoverSourceTree` reads every file whose name ends in a supported extension and never consults imports, git state or tsconfig. The header says discovery is "a conservative source inventory, not proof a file is bundled," and that a directive outside the reviewed roots "is unclassified."
- **"Not a reviewed root, so skipped"**: the opposite happens. In `inventoryServerActions`, `inReviewedRoot("docs/…")` is false, so it pushes an `unclassified action location` problem and then still analyses the module and counts it in the census. The test "refuses a directive outside the reviewed action roots" pins this for `scripts/`, `test/fixtures/` and a root-level file.

**Concrete failures**

The supplied `owner-1.ts` has `"use server";` as its first statement, two async function exports and two exported interfaces. Assuming the other three match it:

| Assertion | Expected | Actual |
|---|---|---|
| `REAL_INVENTORY.problems` (AC-01) | `[]` | 4 location problems |
| Per-module counts vs `EXPECTED_MODULES` | 20 keys | 24 keys |
| Census | 20 / 96 / 13 / 0 | 24 / 104 / 21 / 0 |
| Registry keys and `toHaveLength` | 96 | 104 |
| `REGISTERED_OWNER_SETS` vs credited | equal | 8 extra keys |
| Dropped-pinned-principal mutant, `ownerSets(mutant)` | equal to registry | not equal |

The `identityFree` check still passes, because the aliased `requireTeamAdmin` import is credited. The four registry mutants' `.not.toEqual(REGISTERED_OWNER_SETS)` assertions become vacuously true while these files exist, which quietly degrades those controls.

**Severity**

- **Security**: none. Nothing imports these files, so they are not live Server Actions.
- **Branch integrity**: real. The paused branch's own guard is red at HEAD, and the handoff's "20 modules / 96 exports" census is not reproducible from the backup. That undermines a preservation push even as a WIP draft.
- **Typecheck**: tsconfig `**/*.ts` with no `docs` exclude does pull all eight files into `tsc`. Whether that produces errors is not shown; treat it as secondary exposure.

**Fix assessment**

The proposed rename to `.ts.txt` is appropriate and weakens no policy:

- `hasSourceExtension` uses `endsWith`, so `owner-1.ts.txt` is skipped unread.
- The tsconfig globs no longer match it.
- Bytes and git blob hashes are unchanged; only path references in the handoff or manifest need updating.
- Rename all eight files, not just the four with the directive. The `owner-0.ts` files are still parsed by the guard (a parse diagnostic would fail AC-01) and still typechecked.

Adding `docs` to the exclusions is the wrong fix: it would require editing the literally pinned exclusion list and would hide a whole root from the inventory.

**Not verifiable from what was supplied**

- The value of `REPO_ROOT` (assumed to be the worktree root).
- The contents of the other three `owner-1.ts` files and all `owner-0.ts` files.
- Whether the pre-push hook or vitest config actually runs `test/guards/server-action-auth.test.ts`.

If the hook does not run this suite, the push is not mechanically blocked, but the defect remains on the branch.