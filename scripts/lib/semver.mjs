/// Enough semver to read a `game_version` range, shared by the survey (which
/// drafts rows), the tier-2 promoter (which turns a link-out into an install)
/// and the manifest test (which is the standing check).
///
/// Ranges in the wild look like ">=0.1.37 <2.0.0", "0.0.0-dev || >=0.1.99 <2.0.0"
/// and "0.1.94-kanto.22". Prerelease tags are compared on their numeric core:
/// the engine's own tags are build markers, not the ordering npm assumes, and
/// treating "0.0.0-0" as lower than every release would exclude everything.
///
/// One copy. It lived inside survey-mods.mjs, so the promoter never ran it,
/// and three tier-2 rows whose manifests rule out the shipping engine were
/// promoted to installable: a card that installs and never loads, which is
/// the exact thing the survey's gate exists to refuse.
export function parseVersion(text) {
  const [core] = String(text).trim().replace(/^v/i, "").split("-");
  const [major = 0, minor = 0, patch = 0] = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [major, minor, patch];
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/// Whether `version` is inside `range`. A missing or blank range accepts
/// everything, exactly as the engine's own Loader does.
export function satisfies(version, range) {
  if (!range || !String(range).trim()) return true;
  return String(range).split("||").some((clause) =>
    clause.trim().split(/\s+/).filter(Boolean).every((comparator) => {
      const m = comparator.match(/^(>=|<=|>|<|=|\^)?(.+)$/);
      if (!m) return false;
      const [, op = "=", target] = m;
      const c = compareVersions(version, target);
      switch (op) {
        case ">=": return c >= 0;
        case "<=": return c <= 0;
        case ">": return c > 0;
        case "<": return c < 0;
        case "^": {
          // ^ pins the leftmost non-zero component, as the engine's Semver.lua does.
          const [major, minor, patch] = parseVersion(target);
          const upper = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
          return c >= 0 && compareVersions(version, upper.join(".")) < 0;
        }
        default: return c === 0;
      }
    }));
}
