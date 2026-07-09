---
name: branch-reconciliation
description: >
  Classify every unmerged remote branch as (a) truly unmerged with live content,
  (b) already shipped under a different hash — a squash-merge duplicate, safe to
  delete, with evidence attached — or (c) genuinely stale/abandoned. Use when asked
  "are these branches actually stale", "check unmerged branches", "clean up feature
  branches", or /branch-reconcile. Classification only — never deletes or merges.
---

# Branch reconciliation

## Why this exists

A 2026-07-09 audit of this repo found ~31 of the 54 non-dependabot "unmerged"
branches were byte-identical duplicates of already-merged work (e.g.
`chetan/fix-gap*` = PRs #182-188, `chat-*` = PRs #117/118/145/177). The repo-wide
`supabase`→`db` rename made merged work *look* unmerged when diffed naively
against `main` — `git branch --no-merged` and a plain `git diff` both false-positive
heavily on squash merges. Don't trust either signal alone; this skill encodes the
cheap-to-expensive verification ladder that catches it.

## Steps

Run the cheap passes on every branch before spending a real read on any of them.

1. **Enumerate.**
   ```bash
   git fetch --prune
   git branch -r --no-merged origin/main
   ```

2. **Cheap pass — patch-equivalence.** For each candidate branch:
   ```bash
   git cherry origin/main origin/<branch>
   ```
   Every commit prefixed `-` is patch-equivalent to something already on `main`.
   If **all** commits come back `-`, bucket as **(b) squash-duplicate** — record
   the matching `main` commit(s) as evidence and stop there.

3. **For branches with `+` commits, check squash-merge equivalence.** `git cherry`
   only catches patch-identical commits — it misses squash merges, which rewrite
   the diff into a single new commit. For each `+` commit / remaining branch:
   ```bash
   git diff origin/main...origin/<branch> --name-only
   # then per changed file, compare current main content directly:
   git diff origin/main:<file> origin/<branch>:<file>
   gh pr list --state merged --search "<branch-name OR topic>"
   git log origin/main --grep="<commit subject>"
   ```
   If the file-level diffs are empty (or trivially whitespace/rename) against
   current `main`, and a merged PR or matching commit subject is found, bucket as
   **(b)** with the PR number / commit SHA as evidence. This step is what catches
   what step 2 misses — squash merges hide equivalence from `git cherry` entirely.

4. **Real read — only for survivors.** Branches that fail both the cherry check
   and the content-compare are the only ones worth actually opening. Read the
   diff for content, assess shippability, and flag merge risk against current
   `main` (conflicts, staleness, whether the feature is still wanted). Bucket as
   **(a) truly unmerged** if it has live, shippable content, or **(c) stale /
   abandoned** if it's dead work, a spike, or superseded by other since-merged
   work.

5. **Report.** Output **one table**, nothing else:

   | branch | class | evidence (PR#/commit) | recommended action |
   |---|---|---|---|
   | `chetan/fix-gap-x` | (b) squash-duplicate | PR #184 | delete-with-evidence |
   | `chat-widget-v2` | (a) truly unmerged | — | needs-owner-decision |
   | `spike/old-idea` | (c) stale | last commit 2025-11 | delete-with-evidence |

   Recommended action is one of: `merge`, `delete-with-evidence`,
   `needs-owner-decision`. **This skill classifies only — it never deletes or
   merges a branch.** Hand the table to a human (or a separate, explicitly
   authorized cleanup step) to act on.

## Model tiering

- Steps 1-3 (fetch, `git cherry`, diff/grep/gh checks) are cheap, mechanical,
  high-volume — run them on a **haiku-tier** model.
- Step 4 (the real read of survivors) needs judgment about shippability and risk
  — run it on a **sonnet-tier** model, and only on the branches that survive the
  cheap passes.
