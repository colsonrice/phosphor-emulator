// Mods held out of the catalog for what they DO, never for what licence they
// carry. Licensing stopped being a bar on Sep 19 2026 (see CATALOG_POLICY.md);
// every reason left here is one a player would meet as a broken promise: a
// server Phosphor cannot moderate, a dependency nothing carries, a permission
// the sandbox refuses.
//
// Shared because two scripts have to agree: the survey, which drafts rows, and
// promote-direct-source, which turns a drafted row into an install. One list
// kept in the survey alone let the promoter install what the survey had
// declined to draft, the moment a row for it existed for any other reason.
export const EXCLUDED = {
  "gamecorner-033/Gen1Online":
    "an in-app MMO with chat, PvP and a poker lounge — 4.7.1 would require content filtering, reporting and blocking abusive users, none of which Phosphor can offer for someone else's server",
  "alamops/RBYMMOMod":
    "shared overworld presence, a chat box, friends lists and ranked PvP against strangers: the same 4.7.1 duties as Gen1Online, over sockets the sandbox refuses",
  "AshJamB/SilphNet":
    "accounts with passwords, friends by Trainer ID and online trading; Phosphor cannot moderate someone else's server, and the sockets it needs are refused here",
  "UNDERdecoded/Gen2Recomp---Online":
    "an online multiplayer layer; it opens raw sockets from main.lua, which the sandbox denies, so it would install and fail to load",
  "tebwritescode/gen1mmo":
    "a shared public world with chat, carrying the same 4.7.1 duties",
  "Neburb/pokebox-sync-gen1recomp":
    "a sync client for PokéBox: it requires src.net.Fetch, which this build denies by subtree, so every request answers \"HTTP request pool unavailable\" and the mod installs and does nothing. It is also save custody on somebody else's server, which is the same reason savesync is here. Its own manifest declares `network` honestly; the catalog was stripping that declaration because the detector only looks for third-party transports, and the app's refusal keys on exactly that field",
  "tebwritescode/savesync":
    "uploads the player's save to a public server; save custody is the app's own responsibility and not a thing to hand off in a listing",
  "mresnick67/Gen1ReComp-Pokewalker":
    "needs a companion iOS app and a step feed the sandbox does not provide, so the listing would promise something that cannot work here",
  "dburton95/crystal":
    "a sprite replacement that asks for the network permission; harmless or not, a cosmetic mod wanting the network is not something to wave through",
  "DavidSchuchert/gen1-voxel-dex":
    "hard dependency on DRAMATIC_SHAPE, which the catalog does not carry — it would install and do nothing",
  "masterwebx/gen1recomp-followers-ex":
    "hard dependencies on PokePCFollowers_VoxelMerge and overworld_wild_spawns, neither of them catalogued",
  "eduardocalafell/gen1recomp-player-sprite-flip":
    "flips a sprite in the Dramatic Shape voxel battle specifically; with no Dramatic Shape in the catalog there is nothing for it to flip",
  "randyadr/Gen1-Recomp-HD-Grass":
    "replaces grass objects inside DramaticShapes; with no voxel mod catalogued there is nothing for it to decorate",
};

/// Mods that declare `network`, and work anyway, with one feature missing.
///
/// **The third answer between "refuse" and "fine".** A mod asking for the
/// network was one or the other: excluded, or quietly stripped of the
/// declaration and listed as though nothing were absent. Kanto Battle Royale
/// is neither. Its solo mode runs on a LocalRoom and, in its own words, "never
/// opens a socket": it plays, against bots, exactly as shipped. Its 30-player
/// lobby does not, because the engine's fetch has no iOS transport at all --
/// curl on desktop, a JNI bridge on Android, nothing here -- so `mod.fetch`
/// answers unavailable and the mod's own guarded paths say so.
///
/// It was excluded on "nothing of it runs without the network", which was
/// true of the version surveyed and is not true of v0.53.0. Refusing it now
/// loses a working game; listing it silently sells a battle royale whose
/// headline is thirty players to someone who will only ever meet bots. So it
/// is listed, and the app says which half works, from copy the APP owns: the
/// value here is a judgment, not a sentence to print.
///
/// Deliberately a hand-kept list and not a detector. Whether a mod is still
/// worth playing without its network half is the kind of question a regex has
/// answered wrongly twice already: `mod.fetch` counted as network use and
/// nearly delisted Potato Voxel, and the engine's own fetch matches Kanto
/// Ascendant's optional sprite download. Somebody has to play it and decide.
export const ONLINE_UNAVAILABLE = {
  "campavao/kanto-battle-royale":
    "solo mode runs on a LocalRoom and opens no socket; the relay lobby needs a transport iOS does not have",
};
