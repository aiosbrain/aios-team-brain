#!/usr/bin/env bash
#
# Copy a canonical .claude/skills/<name>/ skill into the other three agent
# runtimes this repo supports, so Codex, Opencode, and Cursor can use it too.
#
# .claude/skills/<name>/SKILL.md stays the single source of truth. This script
# only ever writes generated copies — never hand-edit the output paths below.
#
# Mirrors the copy-verbatim convention already used by
# aios-engineering-harness's adapters (`cp -R .harness/skills/. .agents/skills/`
# for Codex, `.opencode/skills/` for Opencode) and the generated-Cursor-rule
# pattern in adapters/cursor (`.cursor/rules/harness-context.mdc`).
#
# Multi-runtime publication is OPT-IN per skill through `.skill-runtimes.json`.
# The manifest is publication authority, so deleting every generated copy still
# fails --check instead of silently making a published skill Claude-only.
#
# Usage:
#   bash scripts/sync-skill-runtimes.sh <skill-name>   sync one manifest-listed skill
#   bash scripts/sync-skill-runtimes.sh --all          re-sync every already-published skill
#   bash scripts/sync-skill-runtimes.sh --check        verify copies are in sync (exit 1 on drift)
#   bash scripts/sync-skill-runtimes.sh --prune        delete generated copies with no .claude source
#
# --check is what CI runs (via test/guards/skill-runtime-sync.test.ts) so an
# edit to a canonical SKILL.md that forgets to re-sync fails the build instead
# of silently leaving Codex/Opencode/Cursor on a stale playbook.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$ROOT/.claude/skills"
MANIFEST="$ROOT/.skill-runtimes.json"

usage() {
  cat >&2 <<'EOF'
Usage:
  bash scripts/sync-skill-runtimes.sh <skill-name>   sync one manifest-listed skill
  bash scripts/sync-skill-runtimes.sh --all          re-sync every already-published skill
  bash scripts/sync-skill-runtimes.sh --check        verify copies are in sync (exit 1 on drift)
  bash scripts/sync-skill-runtimes.sh --prune        delete generated copies with no .claude source
EOF
  exit 1
}

# --- helpers ---------------------------------------------------------------

# Every canonical skill name (dirs under .claude/skills with a SKILL.md).
list_skills() {
  local d
  for d in "$SKILLS_DIR"/*/; do
    [[ -f "$d/SKILL.md" ]] || continue
    basename "$d"
  done
}

# The generated paths a published skill owns, one per line.
generated_paths() {
  local name="$1"
  echo "$ROOT/.agents/skills/$name"
  echo "$ROOT/.opencode/skills/$name"
  echo "$ROOT/.cursor/rules/$name.mdc"
}

# A skill is "published" once any of its generated copies exists — that's the
# opt-in signal. Skills with none are intentionally Claude-only.
is_published() {
  local p
  while IFS= read -r p; do
    [[ -e "$p" ]] && return 0
  done < <(generated_paths "$1")
  return 1
}

list_published() {
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    let m;
    try { m = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.error(`sync-skill-runtimes: invalid manifest ${p}: ${e.message}`); process.exit(2); }
    if (m.version !== 1 || !Array.isArray(m.published)) {
      console.error("sync-skill-runtimes: manifest requires version 1 and a published array"); process.exit(2);
    }
    const seen = new Set();
    for (const name of m.published) {
      if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || seen.has(name)) {
        console.error(`sync-skill-runtimes: invalid or duplicate published skill ${JSON.stringify(name)}`); process.exit(2);
      }
      seen.add(name); console.log(name);
    }
  ' "$MANIFEST"
}

is_manifest_published() {
  local wanted="$1" name
  while IFS= read -r name; do
    [[ "$name" == "$wanted" ]] && return 0
  done < <(list_published)
  return 1
}

# Flatten a SKILL.md's YAML `description:` (usually a folded `>` block) onto one
# line, for Cursor's frontmatter which wants a scalar.
skill_description() {
  awk '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm && $0 == "---" { exit }
    infm && /^description:/ {
      sub(/^description:[[:space:]]*/, "")
      if ($0 != ">" && $0 != "|" && $0 != ">-" && $0 != "|-") printf "%s ", $0
      indesc = 1; next
    }
    infm && indesc {
      if ($0 ~ /^[A-Za-z_][A-Za-z0-9_-]*:/) { indesc = 0; next }
      gsub(/^[[:space:]]+/, ""); gsub(/[[:space:]]+$/, "")
      if ($0 != "") printf "%s ", $0
      next
    }
  ' "$1" | sed -e 's/[[:space:]][[:space:]]*/ /g' -e 's/ *$//'
}

# The SKILL.md body with its YAML frontmatter stripped. Cursor only parses rule
# frontmatter when `---` is at byte 0 of the file, so the source block cannot be
# carried through — it would render as literal body text.
skill_body() {
  awk '
    NR == 1 && $0 == "---" { infm = 1; next }
    infm && $0 == "---" { infm = 0; next }
    !infm { print }
  ' "$1"
}

# The exact bytes the .cursor/rules/<name>.mdc for this skill should contain.
cursor_rule_content() {
  local name="$1" src="$2" desc
  desc="$(skill_description "$src/SKILL.md")"
  # Single-quoted YAML: the only escape needed is doubling a single quote.
  #
  # Via variables, NOT an inline `${desc//\'/\'\'}`: inside double quotes a backslash before `'` is
  # LITERAL, so that form emitted `\'\'` — a stray backslash that YAML then reads as part of the text
  # ("repo\'s"). It also made the guard unfixable-by-running-the-script, since the script's own output
  # never matched the correct committed file.
  local q="'" qq="''"
  desc="${desc//$q/$qq}"
  printf -- '---\n'
  printf -- "description: '%s'\n" "$desc"
  printf -- 'alwaysApply: false\n'
  printf -- '---\n\n'
  printf -- '<!-- generated by scripts/sync-skill-runtimes.sh from .claude/skills/%s/SKILL.md — do not hand-edit -->\n' "$name"
  printf -- '<!-- source of truth: .claude/skills/%s/SKILL.md -->\n' "$name"
  skill_body "$src/SKILL.md"
}

require_source() {
  local name="$1"
  [[ -f "$SKILLS_DIR/$name/SKILL.md" ]] || {
    echo "sync-skill-runtimes: no $SKILLS_DIR/$name/SKILL.md — nothing to sync" >&2
    exit 1
  }
}

validate_name() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "sync-skill-runtimes: '<skill-name>' must be a bare directory name (letters/digits/-/_ only), got '$1'" >&2
    exit 1
  }
}

# --- sync ------------------------------------------------------------------

sync_skill() {
  local name="$1" src="$SKILLS_DIR/$1" dest
  for dest in "$ROOT/.agents/skills/$name" "$ROOT/.opencode/skills/$name"; do
    mkdir -p "$(dirname "$dest")"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -R "$src/." "$dest/"
    echo "synced -> $dest"
  done

  local rule="$ROOT/.cursor/rules/$name.mdc"
  mkdir -p "$(dirname "$rule")"
  cursor_rule_content "$name" "$src" > "$rule"
  echo "synced -> $rule"
}

# --- check -----------------------------------------------------------------

# Returns 0 if every generated copy matches its canonical source, else 1.
# Prints one line per drift.
check_all() {
  local drift=0 name src dest rule

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    src="$SKILLS_DIR/$name"
    for dest in "$ROOT/.agents/skills/$name" "$ROOT/.opencode/skills/$name"; do
      if [[ ! -d "$dest" ]]; then
        echo "PARTIAL: $(rel "$dest") is missing, but $name is published to other runtimes"
        drift=1
      elif ! diff -r -q "$src" "$dest" >/dev/null 2>&1; then
        echo "STALE:   $(rel "$dest") differs from .claude/skills/$name"
        diff -r -q "$src" "$dest" 2>&1 | sed 's/^/         /'
        drift=1
      fi
    done

    rule="$ROOT/.cursor/rules/$name.mdc"
    if [[ ! -f "$rule" ]]; then
      echo "PARTIAL: $(rel "$rule") is missing, but $name is published to other runtimes"
      drift=1
    elif ! cursor_rule_content "$name" "$src" | diff -q - "$rule" >/dev/null 2>&1; then
      echo "STALE:   $(rel "$rule") differs from what .claude/skills/$name/SKILL.md generates"
      drift=1
    fi
  done < <(list_published)

  while IFS= read -r orphan; do
    [[ -n "$orphan" ]] || continue
    echo "ORPHAN:  $orphan (no .claude/skills source — run --prune)"
    drift=1
  done < <(list_orphans)

  return "$drift"
}

# Generated paths whose canonical .claude/skills/<name> source no longer exists.
list_orphans() {
  local dir name rule
  for dir in "$ROOT/.agents/skills"/*/ "$ROOT/.opencode/skills"/*/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    if [[ ! -f "$SKILLS_DIR/$name/SKILL.md" ]] || ! is_manifest_published "$name"; then
      rel "${dir%/}"
    fi
  done
  for rule in "$ROOT/.cursor/rules"/*.mdc; do
    [[ -f "$rule" ]] || continue
    name="$(basename "$rule" .mdc)"
    # Only rules this script generates are ours to prune — hand-written Cursor
    # rules have no generation marker and must be left alone.
    grep -q 'generated by scripts/sync-skill-runtimes.sh' "$rule" || continue
    if [[ ! -f "$SKILLS_DIR/$name/SKILL.md" ]] || ! is_manifest_published "$name"; then
      rel "$rule"
    fi
  done
}

rel() { echo "${1#"$ROOT"/}"; }

prune_all() {
  local pruned=0 path
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    rm -rf "${ROOT:?}/$path"
    echo "pruned  -> $path"
    pruned=1
  done < <(list_orphans)
  [[ "$pruned" == 1 ]] || echo "nothing to prune — every generated copy has a .claude/skills source"
}

# --- main ------------------------------------------------------------------

[[ $# -ge 1 ]] || usage
list_published >/dev/null || exit 2

case "$1" in
  --check)
    if check_all; then
      echo "skill runtimes in sync ($(list_published | wc -l | tr -d ' ') published skills × .agents/.opencode/.cursor)"
    else
      echo >&2
      echo "sync-skill-runtimes: generated runtime copies are out of sync with .claude/skills." >&2
      echo "Fix with: bash scripts/sync-skill-runtimes.sh --all   (and --prune for orphans)" >&2
      exit 1
    fi
    ;;
  --prune)
    prune_all
    ;;
  --all)
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      sync_skill "$name"
    done < <(list_published)
    ;;
  -h | --help)
    usage
    ;;
  -*)
    echo "sync-skill-runtimes: unknown flag '$1'" >&2
    usage
    ;;
  *)
    validate_name "$1"
    require_source "$1"
    is_manifest_published "$1" || {
      echo "sync-skill-runtimes: '$1' is not listed in .skill-runtimes.json" >&2
      exit 1
    }
    sync_skill "$1"
    ;;
esac
