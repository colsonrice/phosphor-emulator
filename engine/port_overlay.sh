#!/usr/bin/env bash
# Re-ports LoveCore/gen1recomp-overlay/ against a newer gen1recomp commit.
#
# WHY THIS EXISTS. Upstream ships several times a day (see
# docs/superpowers/specs/2026-08-25-engine-catalog-design.md §8a), and any of
# the nine files BASE_SHA256SUMS covers can drift out from under the pin at
# any moment -- main.lua and src/mods/Loader.lua are the two upstream keeps
# moving. When that happens the overlay was written against a version of that
# file that no longer exists, and the port has to be redone. A human doing
# this by hand runs the recipe in docs/RECOMP_OVERLAY_PORTING.md: OURS (the
# overlay file), BASE (upstream at the CURRENT pin, LoveCore/GEN1RECOMP_SHA),
# THEIRS (upstream at the commit under review), three-way merged with `git
# merge-file`. This script is that recipe, run honestly instead of by hand:
#
#   port_overlay.sh <new-sha>          re-port for real; writes files
#   port_overlay.sh --check <new-sha>  dry run -- writes NOTHING. This is the
#                                       hourly publishing Action's "check
#                                       overlay against BASE_SHA256SUMS at
#                                       that commit" step: clean means build
#                                       and publish, drifted means publish
#                                       nothing and surface which files.
#
# For each of the nine BASE_SHA256SUMS paths, in order:
#   unchanged at <new-sha>   -> nothing to do
#   changed, merges clean    -> overlay file replaced with the merge result
#   changed, conflicts       -> overlay file replaced anyway, WITH conflict
#                                markers left in, for a human to resolve --
#                                never silently dropped or skipped
#
# BASE_SHA256SUMS is regenerated from <new-sha>'s hashes ONLY when every
# covered file was either unchanged or merged clean. One conflicted file must
# not move the drift guard for the other eight: a half-updated guard would
# claim the overlay is current when part of it still has <<<<<<< markers
# sitting in it, which is worse than a guard that is honestly stale.
#
# This intentionally lets BASE_SHA256SUMS move ahead of LoveCore/GEN1RECOMP_SHA
# when it regenerates: the overlay becomes provably portable to <new-sha>
# while the SHIPPING pin does not move. That gap is not a bug -- taking the
# pin is a separate, human decision (see CLAUDE.md's "Never bump the build
# number unasked" neighbour rule and its own pin-check section) -- but until
# someone closes it, Scripts/fetch_gen1recomp.sh's check_overlay_bases will
# correctly REFUSE to build: it hashes upstream at the pin GEN1RECOMP_SHA
# names and compares to BASE_SHA256SUMS, and after a re-port those two now
# disagree on purpose, pending the pin bump. That refusal is the point.
#
# SAFETY CARVE-OUTS -- do not remove:
#   * src/mods/Sandbox.lua is NEVER auto-merged into the real file, clean or
#     not. Its deny lists are a blacklist (every pin bump is a reading task
#     for exactly that reason -- see docs/RECOMP_OVERLAY_PORTING.md's "What a
#     pin bump has to be READ for"), and a three-way merge that silently
#     drops one deny entry is a sandbox escape that no test would catch. A
#     drifted Sandbox.lua is merged to a `Sandbox.lua.proposed` sidecar for a
#     human to read; the real file is left alone and the run reports itself
#     refused, same as a conflict.
#   * src/mods/Loader.lua and src/mods/Registry.lua DO get auto-merged, but
#     are always named separately in the summary as needing a read before the
#     result is trusted: they are mod-loading code sitting right next to the
#     boundary Sandbox.lua guards.
#
# A CLEAN MERGE IS NOT A WORKING ENGINE. All this script verifies is that
# git's line-based three-way merge found no textual conflict; it never runs a
# line of Lua. Per CLAUDE.md, the fork test suite has to pass AND a real
# session has to be played before anything this script writes is trusted --
# doubly so before LoveCore/GEN1RECOMP_SHA is ever pointed at <new-sha>.
#
# WHAT A READER MUST NOT ASSUME:
#   * A zero exit status means "safe to ship". It means "safe to look at" --
#     see the paragraph above.
#   * LoveCore/.gen1recomp-pin is a clone SHARED across every worktree by a
#     symlink (see fetch_gen1recomp.sh's own warning about this). This script
#     only ever reads objects out of it by SHA (`git show`, `git cat-file
#     -e`) -- never `checkout`, `fetch`, or anything that moves HEAD or refs,
#     because that clone belongs to every sibling worktree at once.
#   * --check writes nothing at all, not even the Sandbox.lua `.proposed`
#     sidecar. It exists so the Action can ask the question without
#     committing to an answer.
#   * This script never writes LoveCore/GEN1RECOMP_SHA. Which engine Phosphor
#     ships is a decision made elsewhere, on purpose, by a person.
#
# NOTE: no `| head` anywhere in this file -- SIGPIPE under `set -euo
# pipefail` kills the script, and it has bitten the sibling packaging
# scripts twice already. Use awk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="$ROOT/LoveCore"
OVERLAY="$CORE/gen1recomp-overlay"
PIN_CLONE="$CORE/.gen1recomp-pin"
SUMS_FILE="$OVERLAY/BASE_SHA256SUMS"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() {
  if [ -t 2 ]; then printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2
  else printf 'warning: %s\n' "$*" >&2; fi
}
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'usage: %s [--check] <new-sha>\n' "$(basename "$0")" >&2
  exit 64
}

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi
[ $# -eq 1 ] || usage
NEW_SHA="$1"
[ -n "$NEW_SHA" ] || usage

[ -f "$CORE/GEN1RECOMP_SHA" ] || fail "no $CORE/GEN1RECOMP_SHA -- what is this script running against?"
CURRENT_PIN="$(tr -d '[:space:]' < "$CORE/GEN1RECOMP_SHA")"
[ -n "$CURRENT_PIN" ] || fail "$CORE/GEN1RECOMP_SHA is empty"

[ -d "$PIN_CLONE/.git" ] || fail "no gen1recomp pin clone at $PIN_CLONE -- run Scripts/fetch_gen1recomp.sh first"
[ -f "$SUMS_FILE" ] || fail "no $SUMS_FILE -- nothing to re-port against"

git -C "$PIN_CLONE" cat-file -e "$CURRENT_PIN^{commit}" 2>/dev/null \
  || fail "current pin $CURRENT_PIN is not in $PIN_CLONE"
git -C "$PIN_CLONE" cat-file -e "$NEW_SHA^{commit}" 2>/dev/null \
  || fail "$NEW_SHA is not in $PIN_CLONE -- fetch it into the shared clone first (this script never fetches)"

# Tripwire: reproduce ONE known-good hash through this script's own hashing
# pipeline before trusting it for anything. docs/RECOMP_OVERLAY_PORTING.md
# records a real incident where a broken git/shasum silently hashed empty
# input for every path (e3b0c442...), which reads as "everything drifted" or
# "nothing drifted" depending which side of the compare it lands on -- never
# as the tool failure it actually was. Reproducing BASE_SHA256SUMS's own
# first entry, at the pin it was already written against, catches that
# before it can produce a false report instead of after.
FIRST_LINE="$(awk 'NF{print; exit}' "$SUMS_FILE")"
[ -n "$FIRST_LINE" ] || fail "$SUMS_FILE has no entries to check"
FIRST_HASH="${FIRST_LINE%% *}"
FIRST_PATH="${FIRST_LINE##* }"
TRIPWIRE_HASH="$(git -C "$PIN_CLONE" show "$CURRENT_PIN:$FIRST_PATH" | shasum -a 256 | cut -d' ' -f1)"
[ "$TRIPWIRE_HASH" = "$FIRST_HASH" ] || fail \
  "tripwire failed: hashing $FIRST_PATH at the current pin ${CURRENT_PIN:0:10} gave $TRIPWIRE_HASH, but $SUMS_FILE already records $FIRST_HASH for it. git/shasum are not behaving as expected in this environment -- fix that before trusting anything below (see docs/RECOMP_OVERLAY_PORTING.md's hashing-loop trap)."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$CHECK" -eq 1 ]; then
  say "checking whether gen1recomp-overlay could be re-ported: ${CURRENT_PIN:0:10} -> ${NEW_SHA:0:10} (dry run, writes nothing)"
else
  say "re-porting gen1recomp-overlay: ${CURRENT_PIN:0:10} -> ${NEW_SHA:0:10}"
fi

# The one file that must never be auto-merged, however clean the merge would
# be -- see the header. Space-padded on both ends so the `case` membership
# tests below only ever match a whole path, never a substring of one.
SANDBOX_PATH="src/mods/Sandbox.lua"
REVIEW_PATHS=" src/mods/Loader.lua src/mods/Registry.lua "

TOTAL=0
UNCHANGED=0
CLEAN=0
CONFLICTS=0
CONFLICT_FILES=""
REVIEW_FILES=""
SANDBOX_REVIEW=0
MISSING=0
MISSING_FILES=""
PORTABLE=1
# Accumulates exactly the lines a regenerated BASE_SHA256SUMS should have.
# Only ever appended to for the unchanged/merged-clean cases below, so its
# own line count doubling as a check that PORTABLE=1 really did mean "every
# file, no exceptions" -- see the count check right after the loop.
NEW_SUMS=""

trim() { printf '%s' "${1# }"; }

# One BASE_SHA256SUMS entry whose hash no longer matches <new-sha>: reads
# BASE/OURS/THEIRS, three-way merges them, and either installs the result
# (clean or conflicted -- both get written, for everything but Sandbox.lua)
# or, for Sandbox.lua, refuses and writes a sidecar instead.
#
# Mutates the aggregator variables declared above directly and must only
# ever be called from the main loop below via plain invocation (never inside
# a subshell or a pipeline), or those writes vanish the moment it returns.
port_one_file() {
  local path="$1" new_hash="$2"
  local safe base_tmp ours_tmp theirs_tmp merged_tmp err_tmp
  safe="$(printf '%s' "$path" | tr '/' '_')"
  base_tmp="$TMP/BASE_$safe"
  ours_tmp="$TMP/OURS_$safe"
  theirs_tmp="$TMP/THEIRS_$safe"
  merged_tmp="$TMP/MERGED_$safe"
  err_tmp="$TMP/ERR_$safe"

  git -C "$PIN_CLONE" show "$CURRENT_PIN:$path" > "$base_tmp" \
    || fail "$path: could not read it from the pin clone at the CURRENT pin ${CURRENT_PIN:0:10} -- BASE_SHA256SUMS already does not describe reality"
  git -C "$PIN_CLONE" show "$NEW_SHA:$path" > "$theirs_tmp" \
    || fail "$path: could not read it at ${NEW_SHA:0:10} after already confirming it exists there"
  [ -f "$OVERLAY/$path" ] \
    || fail "$path: BASE_SHA256SUMS covers it but $OVERLAY/$path does not exist"
  cp "$OVERLAY/$path" "$ours_tmp"

  # -p: print the merge to stdout rather than overwriting $ours_tmp in
  # place. Load-bearing beyond just "don't mutate the temp copy" -- it also
  # means the result is captured with `>`, not `$(...)`, which would eat the
  # file's trailing newline and silently change its bytes even on a fully
  # clean merge. Labels match docs/RECOMP_OVERLAY_PORTING.md's recipe so a
  # conflict here reads exactly like one a human produced by hand.
  local rc
  if git merge-file -L "ours" -L "upstream-old" -L "upstream-new" \
       -p "$ours_tmp" "$base_tmp" "$theirs_tmp" \
       > "$merged_tmp" 2>"$err_tmp"; then
    rc=0
  else
    rc=$?
  fi

  # Documented git-merge-file contract: 0 clean, negative on error, the
  # conflict COUNT otherwise (see `git merge-file --help`) -- so `rc` could
  # be used directly as the hunk count. Trusted only as a clean/conflict
  # boolean here; the count reported everywhere below is grep's count of
  # actual marker lines in the output, since that is what a human opening
  # the file will actually see, and because trusting it also lets the two
  # numbers be cross-checked instead of taking either blind.
  local hunks
  hunks="$(grep -c '^<<<<<<<' "$merged_tmp" || true)"

  if [ "$rc" -eq 0 ] && [ "$hunks" -ne 0 ]; then
    fail "$path: git merge-file exited 0 but left $hunks conflict marker(s) in the output -- do not trust this script's merge logic until that is understood"
  fi
  if [ "$rc" -ne 0 ] && [ "$hunks" -eq 0 ]; then
    fail "$path: git merge-file exited $rc with no conflict markers in the output: $(cat "$err_tmp")"
  fi
  if [ "$rc" -ne 0 ] && [ "$rc" -le 127 ] && [ "$rc" -ne "$hunks" ]; then
    warn "$path: git merge-file's exit code ($rc) and its conflict-marker count ($hunks) disagree -- reporting $hunks, the number a human opening the file would actually count"
  fi

  local review_note=""
  case "$REVIEW_PATHS" in
    *" $path "*) review_note=" (mod-loading code -- review before trust)" ;;
  esac

  if [ "$path" = "$SANDBOX_PATH" ]; then
    SANDBOX_REVIEW=1
    PORTABLE=0
    if [ "$rc" -eq 0 ]; then
      if [ "$CHECK" -eq 1 ]; then
        warn "$path: upstream changed this file and it merges clean, but Sandbox.lua is NEVER auto-applied -- would write $path.proposed for review (dry run -- not written), real file untouched"
      else
        cp "$merged_tmp" "$OVERLAY/$path.proposed"
        warn "$path: upstream changed this file and it merges clean, but Sandbox.lua is NEVER auto-applied -- wrote $path.proposed for review, real file untouched. Its deny lists are a blacklist; a clean merge can still silently drop an entry."
      fi
    else
      if [ "$CHECK" -eq 1 ]; then
        warn "$path: upstream changed this file AND the merge conflicts ($hunks hunk(s)) -- would write $path.proposed with markers (dry run -- not written), real file untouched"
      else
        cp "$merged_tmp" "$OVERLAY/$path.proposed"
        warn "$path: upstream changed this file AND the merge conflicts ($hunks hunk(s)) -- wrote $path.proposed with conflict markers, real file untouched"
      fi
    fi
    return 0
  fi

  case "$REVIEW_PATHS" in
    *" $path "*) REVIEW_FILES="$REVIEW_FILES $path" ;;
  esac

  if [ "$rc" -eq 0 ]; then
    CLEAN=$((CLEAN + 1))
    NEW_SUMS="${NEW_SUMS}${new_hash}  ${path}
"
    if [ "$CHECK" -eq 1 ]; then
      say "$path: upstream changed this file, merges clean${review_note} (dry run -- not written)"
    else
      cp "$merged_tmp" "$OVERLAY/$path"
      say "$path: upstream changed this file, merged clean${review_note}"
    fi
  else
    CONFLICTS=$((CONFLICTS + 1))
    CONFLICT_FILES="$CONFLICT_FILES $path"
    PORTABLE=0
    if [ "$CHECK" -eq 1 ]; then
      warn "$path: upstream changed this file, would CONFLICT ($hunks hunk(s))${review_note} (dry run -- not written)"
    else
      cp "$merged_tmp" "$OVERLAY/$path"
      warn "$path: upstream changed this file, merge CONFLICTS ($hunks hunk(s))${review_note} -- markers left in the file for a human"
    fi
  fi
}

# `|| [ -n "$line" ]` so a file whose last line lacks a trailing newline
# still gets checked instead of silently skipped (matches
# fetch_gen1recomp.sh's check_overlay_bases). Redirected from the file
# rather than piped into the loop so port_one_file's mutations land in THIS
# shell, not a subshell that vanishes when the pipeline ends.
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  TOTAL=$((TOTAL + 1))
  old_hash="${line%% *}"
  path="${line##* }"

  if ! git -C "$PIN_CLONE" cat-file -e "$NEW_SHA:$path" 2>/dev/null; then
    MISSING=$((MISSING + 1))
    MISSING_FILES="$MISSING_FILES $path"
    PORTABLE=0
    warn "$path: upstream no longer has this file at ${NEW_SHA:0:10} -- cannot re-port it, refusing to touch BASE_SHA256SUMS"
    continue
  fi

  new_hash="$(git -C "$PIN_CLONE" show "$NEW_SHA:$path" | shasum -a 256 | cut -d' ' -f1)"

  if [ "$old_hash" = "$new_hash" ]; then
    UNCHANGED=$((UNCHANGED + 1))
    NEW_SUMS="${NEW_SUMS}${new_hash}  ${path}
"
    say "$path: unchanged at ${NEW_SHA:0:10}"
    continue
  fi

  port_one_file "$path" "$new_hash"
done < "$SUMS_FILE"

if [ "$PORTABLE" -eq 1 ]; then
  NEW_SUMS_LINES="$(printf '%s' "$NEW_SUMS" | awk 'NF{n++} END{print n+0}')"
  [ "$NEW_SUMS_LINES" -eq "$TOTAL" ] \
    || fail "internal error: $TOTAL file(s) covered but only $NEW_SUMS_LINES collected as portable -- refusing to write a partial BASE_SHA256SUMS"
  if [ "$CHECK" -eq 1 ]; then
    say "BASE_SHA256SUMS: would regenerate for ${NEW_SHA:0:10} -- every covered file is unchanged or merges clean"
  else
    printf '%s' "$NEW_SUMS" > "$SUMS_FILE"
    say "BASE_SHA256SUMS: regenerated for ${NEW_SHA:0:10} -- every covered file was unchanged or merged clean"
  fi
else
  warn "BASE_SHA256SUMS: left untouched, still records ${CURRENT_PIN:0:10} -- not every covered file ported cleanly"
fi

say ""
say "candidate only, not a working engine: this only verified that git's"
say "three-way text merge finds no conflict. Per CLAUDE.md, the fork test"
say "suite has to pass and a real session has to be played before any of"
say "this is trusted, and LoveCore/GEN1RECOMP_SHA is untouched either way --"
say "taking the pin is still a separate, human decision."

# ---- everything above is for a human; everything below is for a script. ---
# Stable KEY=value lines, one per line, no colour, always printed (both
# modes) so the hourly publishing Action (see engine-catalog-design.md §8a)
# can tell "all clean", "N conflicts" and "sandbox needs review" apart with
# `grep '^PORT_'`, without scraping any of the prose above.
if [ "$SANDBOX_REVIEW" -eq 1 ]; then PORT_SANDBOX_REVIEW=true; else PORT_SANDBOX_REVIEW=false; fi
if [ "$PORTABLE" -eq 1 ]; then PORT_PORTABLE=true; PORT_VERDICT=clean
else PORT_PORTABLE=false; PORT_VERDICT=drifted
fi
printf 'PORT_MODE=%s\n'           "$([ "$CHECK" -eq 1 ] && echo check || echo apply)"
printf 'PORT_BASE_PIN=%s\n'       "$CURRENT_PIN"
printf 'PORT_NEW_SHA=%s\n'        "$NEW_SHA"
printf 'PORT_TOTAL=%s\n'          "$TOTAL"
printf 'PORT_UNCHANGED=%s\n'      "$UNCHANGED"
printf 'PORT_CLEAN=%s\n'          "$CLEAN"
printf 'PORT_CONFLICTS=%s\n'      "$CONFLICTS"
printf 'PORT_CONFLICT_FILES=%s\n' "$(trim "$CONFLICT_FILES")"
printf 'PORT_SANDBOX_REVIEW=%s\n' "$PORT_SANDBOX_REVIEW"
printf 'PORT_REVIEW_FILES=%s\n'   "$(trim "$REVIEW_FILES")"
printf 'PORT_MISSING=%s\n'        "$MISSING"
printf 'PORT_MISSING_FILES=%s\n'  "$(trim "$MISSING_FILES")"
printf 'PORT_PORTABLE=%s\n'       "$PORT_PORTABLE"
printf 'PORT_VERDICT=%s\n'        "$PORT_VERDICT"

[ "$PORTABLE" -eq 1 ] || exit 1
exit 0
