/// What KIND of mod this is, derived — separately from whether anyone cleared it.
///
/// **Why this file exists.** Every tier-2 listing used to carry exactly one
/// category, `PENDING`, which is not a kind of mod: it is a fact about
/// Phosphor's permission paperwork, parked in the taxonomy field because there
/// was nowhere else to put it. By 19 Sep 2026 that was 233 of 379 entries and
/// 214 of them installable, so tapping any chip in the app — Gameplay, UI,
/// Art — silently dropped three fifths of the catalog, including mods a player
/// had been told by name to look for. The chip row read 43 / 30 / 44 over a
/// catalog of 379.
///
/// The fix is not to file paperwork under a taxonomy, nor a taxonomy under
/// paperwork. It is to stop storing two facts in one field: this derives the
/// kind, and `project.status` keeps carrying the review state it always did.
///
/// **Deliberately a keyword table and not a model.** The manifest is rebuilt
/// on a schedule and has to produce identical bytes from identical inputs, or
/// every downstream hash check becomes noise. A table is also auditable: when
/// a mod lands in the wrong place, the line responsible is findable and
/// fixable, and the fix is permanent.
///
/// **It declines rather than guesses.** A mod whose words match nothing keeps
/// `PENDING` and behaves exactly as it does today. Under-labelling costs a
/// chip; over-labelling files somebody's translation mod under Audio and is
/// worse than the problem being solved.

/// Ordered most specific first. A rule that matches contributes its category;
/// several may match, which is correct — Voxel Ascendant is genuinely ART and
/// VOXEL, and the curated catalog already files it under both.
///
/// Patterns are matched against title, tagline and mod id, lowercased, with
/// word boundaries where a bare substring would overreach: "ui" inside
/// "build", "art" inside "start", "exp" inside "expand".
const RULES = [
  ["VOXEL", [
    /\bvoxels?\b/, /\bdiorama\b/, /\bbrick[- ]mode\b/, /\b3d\s+(overworld|world|battle)\b/,
  ]],
  ["TRANSLATION", [
    /\btranslat(e|ed|ion|ions)\b/, /\btraduc(ao|ão|cion|ción|tion)\b/, /\btradu(ção|zione)\b/,
    /\bportugu(es|ês)\b/, /\bespa(n|ñ)ol\b/, /\bdeutsch\b/, /\bfran(c|ç)ais\b/,
    /\bitaliano\b/, /\bpt[- ]?br\b/, /\bes[- ]?es\b/, /\blocali[sz]ation\b/,
    /\bedici(o|ó)n\b/, /\bvers(a|ã)o\b/, /\bmultiling(ual|ue)\b/, /\blanguages?\b/,
  ]],
  ["AUDIO", [
    /\bmusic\b/, /\bsound(s|track)?\b/, /\baudio\b/, /\bsfx\b/, /\bvoice[- ]?(line|over)?s?\b/,
    /\bsongs?\b/, /\bost\b/, /\bsirens?\b/, /\bjingles?\b/, /\bbgm\b/, /\bbeeps?\b/,
    /\bmutes?\b/, /\bducking\b/, /\btracks?\b/, /\bcr(y|ies)\b/, /\bvolume\b/,
  ]],
  ["UI", [
    /\bui\b/, /\bhud\b/, /\bmenus?\b/, /\binterfaces?\b/, /\bscreens?\b/, /\blayouts?\b/,
    /\bfonts?\b/, /\btext ?box(es)?\b/, /\boverlays?\b/, /\bicons?\b/, /\bdex\b/, /\bcursors?\b/, /\bpockets?\b/, /\bbag\b/,
    /\blogs?\b/, /\bjournals?\b/, /\bphone ?book\b/, /\bagenda\b/, /\bzoom\b/,
    /\bgrid\b/, /\bstorage\b/, /\bwraps? around\b/, /\bslots?\b/, /\btells? you\b/,
    /\bcards?\b/, /\bpokegear\b/, /\bpok(e|é)dex\b/, /\bselectors?\b/, /\bpickers?\b/,
    // Showing the player something they could not see. A mod whose whole job
    // is to display information is UI even when the information is about
    // battle: Damage Numbers and Minimap were both derived as nothing before
    // these, and both are filed under UI by hand.
    /\bminimaps?\b/, /\bmaps? (of|view|screen)\b/, /\b(shows?|showing|displays?|lists?) \b/,
    /\bnumbers?\b/, /\bprogress bar\b/, /\bpreviews?\b/, /\bguide\b/, /\bmarkers?\b/,
    /\bvisible\b/, /\bindicators?\b/, /\bat a glance\b/,
  ]],
  ["ART", [
    /\bsprites?\b/, /\bpalettes?\b/, /\bcolou?rs?\b/, /\bart(work)?\b/, /\btextures?\b/,
    /\bportraits?\b/, /\bskins?\b/, /\bvisuals?\b/, /\banimat(ed|ion|ions)\b/,
    /\btilesets?\b/, /\bshaders?\b/, /\bmodels?\b/, /\bhd\b/, /\bframes?\b/,
    /\bre-?skins?\b/, /\bcinematic\b/, /\bcameras?\b/,
  ]],
  ["QOL", [
    /\bquality[- ]of[- ]life\b/, /\bqol\b/, /\bshortcuts?\b/, /\bsort(ing)?\b/,
    /\bauto[- ]?save\b/, /\bskip(s|ping)?\b/, /\bfaster\b/, /\bquick(er)?\b/,
    /\bconvenien(t|ce)\b/, /\bspeed[- ]?up\b/, /\brenames?\b/, /\bsave slots?\b/,
    // Saving the player a walk, a limit or a repetition. This is the line the
    // curated catalog actually draws between QOL and GAMEPLAY: Access PC
    // Anywhere, Heal Anywhere, Bike Anywhere and Bottomless Bag are all
    // "the rule that made you go back is relaxed", not new mechanics.
    /\banywhere\b/, /\bwithout (walking|going|backtrack)/, /\bfrom the start menu\b/,
    /\bon any map\b/, /\bexpands? the\b/, /\bbottomless\b/, /\bunlimited\b/,
    /\bmultipliers?\b/, /\bselectable\b/, /\btoggle(s|able)?\b/, /\bconfigurable\b/,
    /\bany ?time\b/, /\bno more\b/, /\bhold b\b/, /\bat once\b/,
    /\bquick ?saves?\b/, /\bauto ?saves?\b/, /\bsave ?states?\b/, /\bremembers?\b/,
    /\bstraight to\b/, /\bboots? (straight|to)\b/, /\bwithout spending\b/,
    /\binfinite\b/, /\bfree\b/, /\bbonus\b/, /\bmore room\b/, /\boptional\b/,
    /\bclock\b/, /\btime\b/, /\bdate\b/, /\bfly\b/, /\bwarp\b/, /\bteleport\b/,
    /\bautomatic\b/, /\blets? you (choose|pick|set)\b/, /\bhm slaves?\b/,
  ]],
  ["GAMEPLAY", [
    /\bbattles?\b/, /\bcatch(ing|able)?\b/, /\bencounters?\b/, /\bexperience\b/, /\bexp\b/,
    /\bmechanics?\b/, /\bdifficulty\b/, /\bnuzlocke\b/, /\bchallenges?\b/,
    /\bevolutions?\b/, /\bmoves?\b/, /\btype chart\b/, /\btrainers?\b/, /\blevel(s|ling)?\b/,
    /\bshin(y|ies)\b/, /\bwild\b/, /\bpok(e|é)balls?\b/, /\bstarters?\b/,
    /\brematch(es)?\b/, /\bcasino\b/, /\bminigames?\b/, /\bmini games?\b/,
    /\bruns?\b/, /\bphysical\/special\b/, /\bai\b/, /\brumbles?\b/,
  ]],
  ["CONTENT", [
    /\bnew (area|region|map|town|route)s?\b/, /\bstory\b/, /\bquests?\b/, /\bnpcs?\b/,
    /\bevents?\b/, /\bpost[- ]?game\b/, /\bfak(e|é)mons?\b/, /\bspecies\b/,
    /\bexpansions?\b/, /\bsecret base\b/, /\bdialogue\b/, /\bsidequests?\b/,
    /\blegendar(y|ies)\b/, /\bhidden\b/, /\brumou?rs?\b/, /\bcatchable\b/,
    /\bcontests?\b/, /\btournaments?\b/, /\bcircuits?\b/, /\branks?\b/,
    /\bmarts?\b/, /\bshops?\b/, /\bgame corner\b/, /\bunderground\b/,
    /\bbeneath\b/, /\bstirs?\b/, /\bsomething finally\b/,
    /\bdistricts?\b/, /\blobb(y|ies)\b/, /\bliving\b/, /\bcit(y|ies)\b/,
  ]],
];

/// At most this many categories on one entry.
///
/// A mod described in enough words matches half the table, and an entry filed
/// under every chip is filed under none of them. Three rather than the one or
/// two a curated row carries, because the job here is findability and not
/// taxonomy: when a hand-curated mod says QOL and this says GAMEPLAY, both are
/// defensible readings of the same sentence, and a player who taps either one
/// should find it. Measured against the 150 hand-curated rows, three is where
/// recall stops improving.
const MAX_CATEGORIES = 3;

/// The categories for one listing, strongest first, or `[]` if nothing matched.
///
/// Strength is how many distinct patterns in a rule fired, because a tagline
/// that says "sprite", "palette" and "animation" is more confidently ART than
/// one that happens to contain "model". Ties break on RULES order, which puts
/// the specific categories (VOXEL, TRANSLATION) above the broad ones.
export function categorize({ title = "", tagline = "", modId = "" } = {}) {
  const text = [title, tagline, modId].join(" ").toLowerCase().replace(/[_/-]+/g, " ");
  if (!text.trim()) return [];

  const scored = [];
  for (const [category, patterns] of RULES) {
    const hits = patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    if (hits > 0) scored.push({ category, hits });
  }
  if (!scored.length) return [];

  scored.sort((a, b) => b.hits - a.hits);   // Array#sort is stable, so RULES order breaks ties.
  return scored.slice(0, MAX_CATEGORIES).map((s) => s.category);
}
