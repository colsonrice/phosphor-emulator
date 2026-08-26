#!/usr/bin/env bash
# Packs one gen1recomp release into a Phosphor `.love`, on Linux, in CI.
#
# This is the same recipe Scripts/package_recomp.sh runs on a Mac when a
# release is cut: upstream's tree at a commit, with Phosphor's overlay copied
# over it, zipped with upstream's own file list, then Version.lua stamped with
# the engine release number. Kept deliberately close to that file: if the two
# recipes drift, the workflow publishes something a release build would not.
#
# WHAT IT DOES NOT DO, AND MUST NOT.
#
#   * It does not port the overlay. `port_overlay.sh --check` decides whether
#     the overlay even applies to this commit, and the caller runs it FIRST.
#     A drifted overlay is a human's problem, not something to merge in CI.
#   * It does not run a line of Lua. A packed archive is not a working engine;
#     that is what a real session on a phone is for. What this publishes is a
#     PREVIEW, offered to players who ask for it, never chosen for them.
#   * It does not aim for byte-identical output. zip is not deterministic
#     between runs (verified: the same commit and overlay repacked on one Mac
#     minutes apart produced two different hashes), and it does not need to
#     be: the id IS whatever these bytes hash to, and the app verifies the
#     download against that id. What this DOES mean is that the artifact this
#     publishes for a commit and the artifact a release build later ships for
#     the same commit are two different ids. The app handles that by
#     preferring the shipped one; see RecompEngineChoiceModel.
#
# USAGE
#   build_payload.sh <src-tree> <overlay-dir> <engine-version> <out.love>
#
# Emits machine-readable facts on stdout for the workflow to read:
#   BUILD_SHA256, BUILD_BYTES, BUILD_GAMES (space separated engine tokens)
set -euo pipefail

say()  { printf '==> %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ $# -eq 4 ] || fail "usage: $(basename "$0") <src-tree> <overlay-dir> <engine-version> <out.love>"
SRC="$1"; OVERLAY="$2"; ENGINE_VERSION="$3"; OUT="$4"

[ -d "$SRC" ] || fail "no source tree at $SRC"
[ -d "$OVERLAY" ] || fail "no overlay at $OVERLAY"
printf '%s' "$ENGINE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "engine version must be a strict X.Y.Z (got '$ENGINE_VERSION')"

# ------------------------------------------------------------------ overlay
# Copied over upstream's tree, BASE_SHA256SUMS excluded: it is the drift
# guard, not a file the engine runs.
say "applying overlay"
( cd "$OVERLAY" && find . -type f ! -name 'BASE_SHA256SUMS' -print0 ) \
  | while IFS= read -r -d '' f; do
      mkdir -p "$SRC/$(dirname "$f")"
      cp "$OVERLAY/$f" "$SRC/$f"
    done

# ---------------------------------------------------------------- manifests
# Read out of src/core/GameVersion.lua exactly as upstream does, so a fourth
# game version cannot ship without its import manifest.
MANIFESTS="$(python3 - "$SRC/src/core/GameVersion.lua" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
print(" ".join(dict.fromkeys(re.findall(r'manifest\s*=\s*"([^"]+)"', src))))
PY
)"
[ -n "$MANIFESTS" ] || fail "could not read any manifest path out of src/core/GameVersion.lua"

# ---------------------------------------------------------------------- pack
say "packing $(basename "$OUT")"
rm -f "$OUT"
# shellcheck disable=SC2086  # MANIFESTS is a deliberate word list
( cd "$SRC" && zip -q -9 -r "$OUT" \
    main.lua conf.lua src data assets tools/save-editor \
    $MANIFESTS \
    -x '*.DS_Store' -x '*/.git/*' -x '*/.DS_Store' \
    -x 'data/generated/*' -x 'assets/generated/*' )

# Upstream's own refusal, kept: generated ROM data must never be inside a
# payload. grep -q would SIGPIPE under `set -o pipefail`.
if unzip -Z1 "$OUT" \
    | grep -E '^(data|assets)/generated/[^/]+|^(data|assets)/generated/.+/' >/dev/null; then
  fail "payload unexpectedly contains generated ROM data"
fi
for required in src/update/Boot.lua tools/save-editor/App.lua src/core/GameVersion.lua; do
  unzip -Z1 "$OUT" | grep -Fxq "$required" || fail "payload is missing $required"
done

# --------------------------------------------------------------- version stamp
# Updated in place inside the archive, then read back, because a stamp that
# silently did not take would publish an engine that reports the wrong release
# and refuses every third-party mod.
say "stamping engine version $ENGINE_VERSION"
STAMP="$(mktemp -d)"
mkdir -p "$STAMP/src/core"
sed -E "s/(engine[[:space:]]*=[[:space:]]*\")[^\"]*(\")/\1$ENGINE_VERSION\2/" \
  "$SRC/src/core/Version.lua" > "$STAMP/src/core/Version.lua"
( cd "$STAMP" && zip -q "$OUT" src/core/Version.lua )
rm -rf "$STAMP"
version_re="$(printf '%s' "$ENGINE_VERSION" | sed 's/\./\\./g')"
unzip -p "$OUT" src/core/Version.lua \
  | grep -Eq "engine[[:space:]]*=[[:space:]]*\"$version_re\"" \
  || fail "version stamp failed: payload does not report engine $ENGINE_VERSION"

# ---------------------------------------------------------------------- facts
# Declared games are read from the payload's OWN GameVersion.lua, the same
# source the app reads at runtime, rather than from a list maintained here.
# The app needs them to decide whether a download row can run a given
# cartridge, and it cannot open a `.love` it has not downloaded yet.
GAMES="$(unzip -p "$OUT" src/core/GameVersion.lua \
  | grep -oE '^[[:space:]]*(red|blue|yellow|gold|silver|crystal)[[:space:]]*=' \
  | tr -d ' =' | sort -u | tr '\n' ' ')"
[ -n "$GAMES" ] || fail "payload declares no games: that is not a usable engine"

printf 'BUILD_SHA256=%s\n' "$(sha256sum "$OUT" | cut -d' ' -f1)"
printf 'BUILD_BYTES=%s\n'  "$(stat -c%s "$OUT")"
printf 'BUILD_GAMES=%s\n'  "$(printf '%s' "$GAMES" | sed 's/[[:space:]]*$//')"
