-- HostSeam: the embedding-host contract (host/launch.json, host/mods.json,
-- host/state.json, host/import_status.json).  Everything runs against an
-- injected in-memory fs; the no-host parity block is the guarantee that a
-- standalone install (no host/ files) is byte-identical to before the seam
-- existed.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host seam")
local check = S.check

local HostSeam = require("src.core.HostSeam")
local Json = require("src.link.Json")

local function fakeFs()
  local files = {}
  return {
    read = function(name) return files[name] end,
    write = function(name, contents) files[name] = contents; return true end,
    remove = function(name) files[name] = nil; return true end,
    getInfo = function(name) return files[name] and { type = "file" } or nil end,
    createDirectory = function() return true end,
    _files = files,
  }
end

-- ------- no-host parity: absent files change nothing and write nothing

local fs = fakeFs()
check(HostSeam.consumeLaunch(fs) == nil, "no launch file -> nil")
check(HostSeam.applyModIntents(fs) == false, "no intents file -> false")
local wroteAnything = false
for _ in pairs(fs._files) do wroteAnything = true end
check(not wroteAnything, "parity: reads of absent host files write nothing")

-- ------- launch directive

fs = fakeFs()
fs._files["host/launch.json"] = '{"version":"yellow","autoplay":true}'
local launch = HostSeam.consumeLaunch(fs)
check(launch and launch.version == "yellow" and launch.autoplay == true,
  "launch directive decodes")
check(fs._files["host/launch.json"] == nil, "launch directive is consumed")

-- A known version is accepted. Gold was once the example of an UNKNOWN one,
-- until upstream shipped Gold.
fs = fakeFs()
fs._files["host/launch.json"] = '{"version":"gold","autoplay":true}'
local goldLaunch = HostSeam.consumeLaunch(fs)
check(goldLaunch and goldLaunch.version == "gold",
  "gold is a known version -> directive accepted")

-- Silver too, since v0.2.12. This assertion is the seam's half of the
-- evidence that the pin bump actually reached the payload: a GameVersion
-- table without silver in it fails right here.
fs = fakeFs()
fs._files["host/launch.json"] = '{"version":"silver","autoplay":true}'
local silverLaunch = HostSeam.consumeLaunch(fs)
check(silverLaunch and silverLaunch.version == "silver",
  "silver is a known version since v0.2.12 -> directive accepted")

-- The refused case needs a token the engine does not declare, and THIS
-- FIXTURE HAS NOW GONE STALE TWICE: gold was the unknown example until
-- upstream shipped gold, silver replaced it and upstream shipped silver.
-- Naming the next unreleased game (crystal) just queues the same break up
-- again. So the token is synthetic, and the precondition is asserted rather
-- than assumed, which is the property this check actually needs.
local GameVersion = require("src.core.GameVersion")
local UNKNOWN_VERSION = "phosphor-not-a-real-version"
check(GameVersion.VERSIONS[UNKNOWN_VERSION] == nil,
  "fixture precondition: the refused token is genuinely undeclared")

fs = fakeFs()
fs._files["host/launch.json"] =
  '{"version":"' .. UNKNOWN_VERSION .. '","autoplay":true}'
check(HostSeam.consumeLaunch(fs) == nil, "unknown version -> treated absent")
check(fs._files["host/launch.json"] == nil, "bad directive still deleted")

fs = fakeFs()
fs._files["host/launch.json"] = "{not json"
check(HostSeam.consumeLaunch(fs) == nil, "malformed json -> treated absent")
check(fs._files["host/launch.json"] == nil,
  "malformed directive deleted so it cannot wedge later boots")

-- ------- mod intents merge into options.mods (the manager's own flag)

fs = fakeFs()
fs._files["host/mods.json"] = '{"set":{"DRAMATIC_SHAPE":false,"OTHER":true}}'
check(HostSeam.applyModIntents(fs) == true, "intents applied -> true")
check(fs._files["host/mods.json"] == nil, "intents file consumed")
local SaveData = require("src.core.SaveData")
local opts = SaveData.loadOptions(fs)
check(opts.mods and opts.mods.DRAMATIC_SHAPE == false,
  "disable intent landed in options.mods")
check(opts.mods and opts.mods.OTHER == true, "enable intent landed too")

-- ------- "try it anyway": the engine's own per-game generation override
--
-- PHOSPHOR: the host had no way to set options.modsGen2, so a Gen 1 mod on a
-- Gen 2 game was skipped as wrong_generation with nothing a player could do
-- about it -- even though Loader:_gateGeneration has always honoured a forced
-- mod ("The player owns the override"). These prove the payload reaches
-- SaveData.setModForced, and that taking the acceptance back clears the row
-- rather than leaving it forced forever.

fs = fakeFs()
fs._files["host/mods.json"] =
  '{"set":{"OLD":true},"forced":{"OLD":true},"forcedGame":"crystal"}'
check(HostSeam.applyModIntents(fs) == true, "forced intents applied")
opts = SaveData.loadOptions(fs)
check(SaveData.modForced(opts, "OLD", "crystal", 2) == true,
  "the accepted risk reached the engine's own store, keyed to crystal")
check(SaveData.modForced(opts, "OLD", "gold", 2) ~= true,
  "and it is scoped to the one cartridge, not the whole generation")

-- taking it back
fs._files["host/mods.json"] =
  '{"set":{"OLD":true},"forced":{"OLD":false},"forcedGame":"crystal"}'
HostSeam.applyModIntents(fs)
opts = SaveData.loadOptions(fs)
check(SaveData.modForced(opts, "OLD", "crystal", 2) ~= true,
  "taking the risk back clears the engine's row")

-- a payload with no game names no version to key on, and must be ignored
-- rather than guessed at
fs = fakeFs()
fs._files["host/mods.json"] = '{"set":{"OLD":true},"forced":{"OLD":true}}'
HostSeam.applyModIntents(fs)
opts = SaveData.loadOptions(fs)
check(SaveData.modForced(opts, "OLD", "crystal", 2) ~= true,
  "forced without a game is ignored, not applied to some default")

check(HostSeam.applyModIntents(fs) == false,
  "second boot with no new intents -> no-op")

-- The host pane is the whole library's switch, so its answer has to be the one
-- the loader reads -- including on a gen1 install where per-game flags are
-- live.  SaveData.modEnabled consults options.modsByVersion[version][id]
-- BEFORE options.mods, and the loader's one-time migrateModEnablement gives
-- every installed mod an explicit per-game entry on the first boot.  Writing
-- only the shared flag after that point is a write nothing ever reads: the mod
-- keeps loading, the in-game list keeps showing it on, and the pane's switch
-- snaps back the next time state.json is written.
fs = fakeFs()
local migrated = { mods = { DRAMATIC_SHAPE = true } }
SaveData.migrateModEnablement(migrated, { { id = "DRAMATIC_SHAPE" } })
SaveData.saveOptions(migrated, fs)
fs._files["host/mods.json"] = '{"set":{"DRAMATIC_SHAPE":false}}'
check(HostSeam.applyModIntents(fs) == true, "intents applied over a migrated install")
local after = SaveData.loadOptions(fs)
for _, version in ipairs({ "red", "blue", "yellow" }) do
  check(SaveData.modEnabled(after, "DRAMATIC_SHAPE", SaveData.modScope(version)) == false,
    "host disable reaches the loader's read path on " .. version)
end

fs = fakeFs()
fs._files["host/mods.json"] = '{"set":{"BAD":"yes"}}'
check(HostSeam.applyModIntents(fs) == false,
  "non-boolean intent ignored, not written")

fs = fakeFs()
fs._files["host/mods.json"] = "{broken"
check(HostSeam.applyModIntents(fs) == false, "malformed intents -> no-op")
check(fs._files["host/mods.json"] == nil, "malformed intents still consumed")

-- ------- launch option preferences

fs = fakeFs()
check(HostSeam.applyLaunchPrefs({ version = "yellow" }, fs) == false,
  "no touchControls key -> player's choice untouched")
check(HostSeam.applyLaunchPrefs({ touchControls = false }, fs) == true,
  "touchControls=false applies")
local prefOpts = require("src.core.SaveData").loadOptions(fs)
check(prefOpts.touchControls and prefOpts.touchControls.enabled == false,
  "touch overlay disabled in persisted options")
check(HostSeam.applyLaunchPrefs({ touchControls = false }, fs) == false,
  "same value again -> no rewrite")
check(HostSeam.applyLaunchPrefs({ touchControls = true }, fs) == true,
  "true re-enables")

-- ------- launch pipeline levels

fs = fakeFs()
check(HostSeam.applyLaunchPipelines({ version = "yellow" }, fs) == false,
  "no pipelines key -> untouched")
check(HostSeam.applyLaunchPipelines(
  { pipelines = { voxel = 3, tiltshift = 0 } }, fs) == true,
  "pipeline levels apply")
local pipeOpts = require("src.core.SaveData").loadOptions(fs)
check(pipeOpts.pipelines and pipeOpts.pipelines.voxel == 3,
  "voxel level persisted")
check(pipeOpts.tilt == 0, "a world pipeline on zeroes tilt")
check(HostSeam.applyLaunchPipelines(
  { pipelines = { voxel = 3, tiltshift = 0 } }, fs) == false,
  "same levels again -> no rewrite")
check(HostSeam.applyLaunchPipelines(
  { pipelines = { voxel = "high" } }, fs) == false,
  "non-numeric level ignored")

-- ------- mod state snapshot

fs = fakeFs()
local loader = { mods = {
  ZED = { enabled = true, state = "loaded", manifest = { version = "2.0.0" } },
  ALPHA = { enabled = false, state = "disabled", manifest = { version = "1.0" } },
  BROKEN = { enabled = true, failed = true, state = "failed", manifest = {} },
} }
check(HostSeam.writeModState(loader, fs) == true, "state write succeeds")
local state = Json.decode(fs._files["host/state.json"])
check(type(state.engine) == "string" and #state.engine > 0,
  "state carries the engine version")
check(#state.mods == 3, "all mods listed")
check(state.mods[1].id == "ALPHA" and state.mods[3].id == "ZED",
  "mods sorted by id")
check(state.mods[1].enabled == false and state.mods[1].state == "disabled",
  "disabled mod reported honestly")
check(state.mods[2].id == "BROKEN" and state.mods[2].state == "failed",
  "failed mod keeps its enabled-but-broken state")

-- Two enabled mods can each register a world pipeline, and the engine draws
-- exactly one of them: Pipelines.worldPipeline takes the FIRST eligible in
-- priority order and applyOptions pins every other to 0. Neither mod fails,
-- neither declares a conflict, and nothing in the report said which one was
-- actually being used -- so the loser looked installed, enabled and simply
-- broken. DRAMATIC_SHAPE and TERRARIUM both register at priority 20, so the
-- id breaks the tie and Terrarium wins on every boot.
fs = fakeFs()
local Pipelines = require("src.render.Pipelines")
local pipeData = { render_pipelines = {
  voxel = { label = "VOXEL", levels = { "OFF", "15", "35" }, priority = 20,
            drawWorld = function() end },
  terrarium_voxel = { label = "VOXEL", levels = { "OFF", "15", "35" }, priority = 20,
                      drawWorld = function() end },
  terrarium_tiltshift = { label = "TILTSHIFT", levels = { "OFF", "ON" }, priority = 10 },
  _owners = { voxel = "DRAMATIC_SHAPE", terrarium_voxel = "TERRARIUM",
              terrarium_tiltshift = "TERRARIUM" },
} }
Pipelines.install(pipeData)
Pipelines.applyOptions({ pipelines = { voxel = 2, terrarium_voxel = 2 } })
local both = { mods = {
  DRAMATIC_SHAPE = { enabled = true, state = "loaded", manifest = { version = "1.3.1" } },
  TERRARIUM = { enabled = true, state = "loaded", manifest = { version = "1.23.1-mobile" } },
  SHINY = { enabled = true, state = "loaded", manifest = { version = "1.0.0" } },
} }
check(HostSeam.writeModState(both, fs, pipeData) == true, "state write with pipelines succeeds")
state = Json.decode(fs._files["host/state.json"])
local byId = {}
for _, row in ipairs(state.mods) do byId[row.id] = row end
check(byId.DRAMATIC_SHAPE.drawsWorld == true, "the shadowed mod is reported as a world drawer")
check(byId.TERRARIUM.drawsWorld == true, "so is the one actually drawing")
check(byId.TERRARIUM.worldActive == true, "and it is named as the active one")
check(byId.DRAMATIC_SHAPE.worldActive ~= true,
  "the shadowed mod is NOT active, which is the whole point of the report")
check(byId.SHINY.drawsWorld ~= true,
  "a mod that registers no world pipeline says nothing about one")

-- Absent rather than false, so a boot with no mod pipelines writes the same
-- bytes it always did and no host has to learn a new key to ignore.
fs = fakeFs()
Pipelines.install({ render_pipelines = {} })
check(HostSeam.writeModState(both, fs, { render_pipelines = {} }) == true,
  "no registered pipelines still writes")
for _, row in ipairs(Json.decode(fs._files["host/state.json"]).mods) do
  check(row.drawsWorld == nil and row.worldActive == nil,
    "no pipeline keys on " .. row.id .. " when nothing registered one")
end

fs = fakeFs()
check(HostSeam.writeModState(nil, fs) == true,
  "nil loader still writes an empty, valid snapshot")
check(#Json.decode(fs._files["host/state.json"]).mods == 0,
  "empty snapshot has zero mods")

-- A manifest the validator refused never becomes a mod, so it is absent from
-- loader.mods entirely. Reported anyway: a host that lists installs from disk
-- would otherwise show it as merely waiting for a boot that already happened
-- and already said no.
fs = fakeFs()
local refusing = {
  mods = { FINE = { enabled = true, state = "loaded", manifest = { version = "1.0" } } },
  rejected = { { id = "potato_voxel", path = "mods/potato_voxel",
                 reason = 'unknown permission "compute"' } },
}
check(HostSeam.writeModState(refusing, fs) == true, "refused install still writes")
state = Json.decode(fs._files["host/state.json"])
check(#state.mods == 2, "the refused install is reported alongside the real mod")
check(state.mods[1].id == "FINE", "sorting still applies across both sources")
check(state.mods[2].id == "potato_voxel",
  "the refused row is named by its directory, not a manifest id we could not trust")
check(state.mods[2].state == "invalid",
  "reported with the loader's own word for a bad manifest")
check(state.mods[2].failure == 'unknown permission "compute"',
  "and with the reason, which is the only actionable half")
check(state.mods[2].enabled == true,
  "reported as on: a refusal is worth saying only for a mod the player asked for")

-- Shape tolerance, same posture as the rest of this seam: a loader without the
-- field (an older one, or a future one that drops it) must not break the write.
fs = fakeFs()
check(HostSeam.writeModState({ mods = {}, rejected = "nonsense" }, fs) == true,
  "a rejected field of the wrong type is ignored rather than fatal")
check(#Json.decode(fs._files["host/state.json"]).mods == 0,
  "and contributes nothing")

-- ------- runtime commands

fs = fakeFs()
check(HostSeam.pollCommand(fs) == nil, "no command file -> nil")
fs._files["host/command.json"] = '{"seq":1,"cmd":"save"}'
local cmd = HostSeam.pollCommand(fs)
check(cmd and cmd.cmd == "save", "command decodes")
check(fs._files["host/command.json"] == nil, "command consumed")
fs._files["host/command.json"] = '{"seq":1,"cmd":"save"}'
check(HostSeam.pollCommand(fs) == nil, "same seq de-duped")
fs._files["host/command.json"] = '{"seq":2,"cmd":"speed","value":3}'
cmd = HostSeam.pollCommand(fs)
check(cmd and cmd.cmd == "speed" and cmd.value == 3, "value rides along")
fs._files["host/command.json"] = "{nope"
check(HostSeam.pollCommand(fs) == nil, "malformed command -> nil")
check(fs._files["host/command.json"] == nil, "malformed command still consumed")

-- ------- import status pump

fs = fakeFs()
HostSeam.writeImportStatus({ phase = "working", percent = 0 }, fs)
local status = Json.decode(fs._files["host/import_status.json"])
check(status.phase == "working" and status.percent == 0, "explicit status write")

local importer = { workState = "working", progress = 0.42,
                   status = "Extracting", detail = nil }
HostSeam.pumpImportStatus(importer, fs)
status = Json.decode(fs._files["host/import_status.json"])
check(status.percent == 42 and status.status == "Extracting",
  "pump mirrors importer progress")

fs._files["host/import_status.json"] = "SENTINEL"
HostSeam.pumpImportStatus(importer, fs)
check(fs._files["host/import_status.json"] == "SENTINEL",
  "pump skips writing when (phase, percent) has not moved")

importer.workState = "error"
importer.status = "That ROM could not be imported"
importer.detail = "wrong checksum"
HostSeam.pumpImportStatus(importer, fs)
status = Json.decode(fs._files["host/import_status.json"])
check(status.phase == "error" and status.detail == "wrong checksum",
  "pump carries the importer's own error strings")

HostSeam.clearImportStatus(fs)
check(fs._files["host/import_status.json"] == nil, "clear removes the file")

-- ------- island frame snapshot, on upstream's HostDisplay seam
--
-- HostSeam.displayBackend is what main.lua hands to HostDisplay.setBackend,
-- so the snapshot rides the seam upstream maintains instead of a hand-patched
-- love.draw.  Driven here through a fake love: the beat, the game-frames-only
-- gate and the write are all assertable headlessly.  What is NOT assertable
-- headlessly is whether real pixels survive a real GPU readback -- that is
-- what the host's -RecompBootProbeGen1 island leg is for.

local D = HostSeam.displayBackend
check(type(D) == "table",
  "display backend is a table (HostDisplay.setBackend rejects anything else)")
check(type(D.beginFrame) == "function",
  "beginFrame exists: the readback is asked for at the TOP of a frame, "
  .. "which is the only place Metal lets present() serve it")

local shots, canvasW, canvasH = 0, nil, nil
local written = {}
local fakeShot
fakeShot = {
  -- A portrait phone window, which is the case the crop exists for.
  getDimensions = function() return 1170, 2532 end,
  encode = function() return { getString = function() return "PNGBYTES" end } end,
  newImageData = function() return fakeShot end,
}
local savedLove = love
love = {
  window = { getDPIScale = function() return 3 end },
  graphics = {
    -- Synchronous here; the real one fires from inside present(), which is
    -- exactly why the drain runs a frame later than the request.
    captureScreenshot = function(cb) shots = shots + 1; cb(fakeShot) end,
    newImage = function(d) return d end,
    newCanvas = function(w, h) canvasW, canvasH = w, h; return fakeShot end,
    getCanvas = function() return nil end,
    setCanvas = function() end,
    clear = function() end,
    setColor = function() end,
    draw = function() end,
  },
  filesystem = {
    createDirectory = function() return true end,
    write = function(name, contents) written[name] = contents; return true end,
    read = function() return nil end,
    remove = function() return true end,
    getInfo = function() return nil end,
  },
}

-- Default OFF: a host that never asked pays nothing, not even the beat.
check(HostSeam.captureFramesEnabled() == false, "frame capture defaults off")
D:update(999)
D:beginFrame("game")
D:endFrame("game")
check(shots == 0, "capture off: no readback however long the game runs")

check(HostSeam.applyLaunchCapture({ captureFrames = true }) == true,
  "captureFrames in the launch directive turns the snapshot on")

D:update(9)
D:beginFrame("game")
D:endFrame("game")
check(shots == 0, "no readback before the ten-second beat comes round")

D:update(2)
-- THE gate that used to be free: the hand-patched version sat below
-- love.draw's early returns, so only a game frame could reach it.  The seam
-- calls the frame hooks for the launcher and both editors too.
D:beginFrame("launcher")
D:beginFrame("touch_editor")
D:beginFrame("editor")
check(shots == 0, "a due snapshot is not taken off a launcher or editor frame")

-- THE ordering, and the crash it holds off.  captureScreenshot is served in
-- present(), which blits the frame's drawable -- and a drawable is readable
-- only if the request was already pending when LOVE took it, on the frame's
-- first draw call.  Asked for at the END of a frame it is too late, and
-- present() aborts the whole app: "sourceTexture must not be a
-- framebufferOnly texture", which is what a player saw mid-session.
D:endFrame("game")
check(shots == 0,
  "endFrame never asks for a readback: the drawable is already framebufferOnly "
  .. "by then and present() would abort")

D:beginFrame("game")
check(shots == 1, "a due snapshot is asked for at the top of the next game frame")
check(written["host/last_frame.png"] == nil,
  "nothing written yet: the real callback lands inside present(), a frame later")

D:update(999)
D:beginFrame("game")
check(shots == 1, "the beat does not run on while a readback is in flight")

D:endFrame("game")
check(written["host/last_frame.png"] == "PNGBYTES",
  "the frame after the readback writes host/last_frame.png")
check(shots == 1, "draining does not immediately request another readback")
-- 1170x2532 portrait, no host inset: widest centred 3:2 band is 1170x780,
-- shrunk to a 360-wide thumbnail.  These are the numbers the boot probe
-- prints back ("ISLAND FRAME OK -- n bytes, 360x240"), so a change to the
-- crop that nobody meant shows up here rather than on a Lock Screen.
check(canvasW == 360 and canvasH == 240,
  "thumbnail is the documented 360x240 (got "
  .. tostring(canvasW) .. "x" .. tostring(canvasH) .. ")")

-- A host with a deck reserves a band at the bottom; the crop takes it off in
-- PIXELS, so it has to cross the DPI scale (3x here) or it removes a third
-- of what it should.
HostSeam.setViewportBottomInset(400)
D:update(999)
D:beginFrame("game")   -- request
D:endFrame("game")     -- drain
check(canvasW == 360 and canvasH == 240,
  "a bottom inset still yields a 3:2 thumbnail")
HostSeam.setViewportBottomInset(0)

-- askIfDue is what love.update calls once it knows the frame is the game's,
-- BEFORE anything that could draw. It exists because beginFrame is only early
-- enough if nothing has drawn yet, and a mod drawing from an update hook
-- takes the drawable first -- which aborted the app on every wild encounter
-- for a player running a world-billboard mod.
D:update(999)
local beforeAsk = shots
D:askIfDue()
check(shots == beforeAsk + 1,
  "askIfDue takes the due readback during update, before anything can draw")
D:beginFrame("game")
check(shots == beforeAsk + 1,
  "beginFrame does not ask again once update already did")
D:endFrame("game")

D:askIfDue()
check(shots == beforeAsk + 1,
  "askIfDue is a no-op when no readback is due")

check(HostSeam.applyLaunchCapture({}) == false,
  "a directive without captureFrames leaves the snapshot off")
love = savedLove

-- ------- session: one shape for both generations (spec §3.5)

local function fakeGen1()
  -- Gen 1 keeps ONE OverworldState for the process: returnToTitle pops it
  -- off the stack but never clears its map, so "in the world" has to be a
  -- question about the stack, not about the overworld object.
  local game = { overworld = { map = nil }, calls = {} }
  game.stack = { states = {} }
  function game.stack:top() return self.states[#self.states] end
  function game:restoreSave(loaded, recovered, opts)
    self.calls[#self.calls + 1] = { "restoreSave", loaded, recovered, opts }
    self.overworld.map = { id = loaded.player.map }
    self.stack.states = { self.overworld }
  end
  function game:writeSave() self.calls[#self.calls + 1] = { "writeSave" }; return true end
  function game:returnToTitle()
    self.calls[#self.calls + 1] = { "returnToTitle" }
    self.stack.states = { "title" }        -- the overworld keeps its stale map
  end
  return game
end

local function fakeGen2()
  local game = { world = nil, phase = "boot", calls = {} }
  game.stack = { states = {} }
  function game.stack:top() return self.states[#self.states] end
  function game:continueGame(save)
    self.calls[#self.calls + 1] = { "continueGame", save }
    self.world = { map = { id = save.player.map } }
    self.phase = "play"
  end
  function game:writeSave() self.calls[#self.calls + 1] = { "writeSave" }; return true end
  function game:returnToTitle()
    self.calls[#self.calls + 1] = { "returnToTitle" }
    self.world = nil
    self.phase = "boot"
  end
  return game
end

local sessionDeps = {
  SaveData = { load = function(version) return { player = { map = "PALLET" }, _v = version }, "bak" end },
  Save = { load = function(version) return { player = { map = "NEW_BARK" }, _v = version }, nil end },
}

local g1 = fakeGen1()
local s1 = HostSeam.session(g1, 1, sessionDeps)
check(s1.inWorld() == false, "gen1: not in the world before any restore")
local loaded1, rec1 = s1.readSlot("yellow")
check(loaded1 and loaded1._v == "yellow" and rec1 == "bak", "gen1 reads through SaveData.load")
s1.enterWorld(loaded1, rec1)
check(g1.calls[1][1] == "restoreSave" and g1.calls[1][4].freshBoot == true,
  "gen1 enters the world through restoreSave with freshBoot")
check(s1.inWorld() == true and s1.topIsWorld() == true, "gen1: in the world after restore")
check(s1.writeSave() == true and g1.calls[2][1] == "writeSave", "gen1 writeSave forwards")
-- mid-battle the overworld is on the stack under the battle: still in the world
g1.stack.states = { g1.overworld, "battle" }
check(s1.inWorld() == true and s1.topIsWorld() == false, "gen1: in the world under a battle, but not on top")
s1.returnToTitle()
check(g1.calls[3][1] == "returnToTitle" and s1.topIsWorld() == false, "gen1 returnToTitle forwards")
check(s1.inWorld() == false,
  "gen1: NOT in the world after returnToTitle, although overworld.map is still set (an exit save here would write the discarded position back)")

local g2 = fakeGen2()
local s2 = HostSeam.session(g2, 2, sessionDeps)
check(s2.inWorld() == false, "gen2: not in the world before continue")
local loaded2 = s2.readSlot("gold")
check(loaded2 and loaded2._v == "gold", "gen2 reads through gen2 Save.load, never SaveData")
s2.enterWorld(loaded2, nil)
check(g2.calls[1][1] == "continueGame", "gen2 enters the world through continueGame")
check(s2.inWorld() == true and s2.topIsWorld() == true, "gen2: in the world after continue")
s2.returnToTitle()
check(s2.inWorld() == false, "gen2 returnToTitle clears the world")

-- continueGame(nil) would start a NEW GAME: the adapter must refuse a nil save
local g2b = fakeGen2()
local s2b = HostSeam.session(g2b, 2, sessionDeps)
local okNil = pcall(s2b.enterWorld, nil, nil)
check(okNil == false and #g2b.calls == 0, "gen2 enterWorld(nil) raises rather than starting a new game")

-- ------- boot directive: slot + continue (spec §3.5)

local selectCalls = {}
local bootDeps = {
  LaunchOptions = { selectSlot = function(version, slot)
    selectCalls[#selectCalls + 1] = { version, slot }
    return slot == "slot2" and "slot2" or nil
  end },
  SaveData = { saveFilename = function(version) return "saves/" .. version .. "/active.lua" end,
               load = sessionDeps.SaveData.load },
  Save = sessionDeps.Save,
}

check(HostSeam.selectLaunchSlot(nil, "yellow", bootDeps) == true, "no directive: nothing to select, proceed")
check(HostSeam.selectLaunchSlot({ version = "yellow" }, "yellow", bootDeps) == true, "no slot named: proceed")
check(HostSeam.selectLaunchSlot({ version = "yellow", slot = "slot2" }, "yellow", bootDeps) == true
  and selectCalls[1][2] == "slot2", "a registered slot is selected before boot")
check(HostSeam.selectLaunchSlot({ version = "yellow", slot = "slot9" }, "yellow", bootDeps) == false,
  "a slot that no longer exists refuses, so continue does not enter a different save")

local bfs = fakeFs()
local gb = fakeGen1()
check(HostSeam.continueAfterBoot({ version = "yellow" }, gb, "yellow", 1, bootDeps, bfs) == false,
  "no continue flag: the title as today")
check(HostSeam.continueAfterBoot({ version = "yellow", ["continue"] = true }, gb, "yellow", 1, bootDeps, bfs) == false
  and #gb.calls == 0, "continue with no save file on disk falls through to the title")
local crNone = Json.decode(bfs._files["host/continue_result.json"])
check(crNone and crNone.ok == true and crNone.entered == false and crNone.reason == "no save",
  "the no-save outcome is reported, not silent")
bfs._files["saves/yellow/active.lua"] = "return {}"
check(HostSeam.continueAfterBoot({ version = "yellow", ["continue"] = true }, gb, "yellow", 1, bootDeps, bfs) == true
  and gb.calls[1][1] == "restoreSave", "continue with a save enters the world")
local cr = Json.decode(bfs._files["host/continue_result.json"])
check(cr and cr.ok == true and cr.entered == true, "the outcome is reported for the host")

local g2c = fakeGen2()
bfs._files["saves/gold/active.lua"] = "return {}"
check(HostSeam.continueAfterBoot({ version = "gold", ["continue"] = true }, g2c, "gold", 2, bootDeps, bfs) == true
  and g2c.calls[1][1] == "continueGame", "gen2 continue goes through continueGame")

-- an engine that raises inside the restore leaves the title up and says why
local gErr = fakeGen1()
function gErr:restoreSave() error("boom", 0) end
check(HostSeam.continueAfterBoot({ version = "yellow", ["continue"] = true }, gErr, "yellow", 1, bootDeps, bfs) == false,
  "a failed restore falls through to the title")
local crErr = Json.decode(bfs._files["host/continue_result.json"])
check(crErr and crErr.ok == false and tostring(crErr.error):find("boom"), "and the failure is reported")

-- ------- commands carry a string value too (slot ids, spec §3.5)

fs = fakeFs()
fs._files["host/command.json"] = '{"seq":41,"cmd":"slot","text":"slot2"}'
local slotCmd = HostSeam.pollCommand(fs)
check(slotCmd and slotCmd.cmd == "slot" and slotCmd.text == "slot2", "a command's text value is kept")

-- ------- tripwire: main.lua must never reach HostSeam through a nil global
--
-- `HostSeam.displayBackend:askIfDue()` was written into love.update with no
-- `local HostSeam` in that function, so the bare name resolved to the GLOBAL,
-- which is nil: the first GAME frame of every 3D session died on it, and
-- because LÖVE's error screen is a frame loop the host then refused every
-- later launch until the app was force quit. Nothing caught it -- no unit
-- test runs main.lua, and the crash is past the importer's early returns, so
-- only a real session reaches it.
--
-- HostSeam is Phosphor's module in Phosphor's copy of main.lua, and the file's
-- idiom is deliberate: require it where it is used (a file-scope require runs
-- before love.filesystem is mounted). This scans for the one shape that
-- breaks -- a bare `HostSeam.x` / `HostSeam:x` with no `local HostSeam` since
-- the enclosing function began.
local mainSource = io.open("main.lua", "r")
if mainSource then
  local body = mainSource:read("*a")
  mainSource:close()
  local functionStart, hasLocal, offenders = nil, false, {}
  local lineNo = 0
  for line in (body .. "\n"):gmatch("([^\n]*)\n") do
    lineNo = lineNo + 1
    -- a column-0 function header opens a new scope
    if line:match("^function ") or line:match("^local function ") then
      functionStart, hasLocal = lineNo, false
    end
    if line:match("local%s+HostSeam%s*=") then hasLocal = true end
    local stripped = line:match("^%s*%-%-") and "" or line
    -- a use that is neither a declaration nor the inline require form
    if stripped:match("[^%w_%.]HostSeam[%.:]") or stripped:match("^%s*HostSeam[%.:]") then
      local isDecl = stripped:match("local%s+HostSeam%s*=")
      local isInline = stripped:match('require%("src%.core%.HostSeam"%)')
      if not isDecl and not isInline and not hasLocal then
        offenders[#offenders + 1] = ("main.lua:%d: %s"):format(lineNo,
          (stripped:gsub("^%s+", "")))
      end
    end
  end
  check(#offenders == 0,
    "every HostSeam use in main.lua has one in scope: "
      .. (offenders[1] or "none bare"))
else
  -- The suite is run from the materialized tree, where main.lua sits beside
  -- it; say so rather than passing silently on a path that checked nothing.
  check(false, "tripwire could not open main.lua to scan it")
end

-- ------- slot pictures (spec §3.6): the path, and the watcher for the
-- game's own START -> SAVE

check(HostSeam.slotPicturePath("yellow", "slot3") == "saves/yellow/slot3.png",
      "slot picture path sits beside the slot")
do
  local now = 100
  local watcher = HostSeam.newSlotWatcher(function(path)
    if path == "saves/yellow/slot1.lua" then return { modtime = now } end
    return nil
  end)
  check(watcher.check("yellow", "slot1") == nil, "watcher: first sight is not a change")
  check(watcher.check("yellow", "slot1") == nil, "watcher: no change, no picture")
  now = 101
  check(watcher.check("yellow", "slot1") == "slot1", "watcher: a newer file asks for a picture")
  check(watcher.check("yellow", "slot1") == nil, "watcher: asked once per change")
  check(watcher.check("yellow", "slot2") == nil, "watcher: a slot with no file is nothing")
  check(watcher.check("yellow", nil) == nil, "watcher: no active slot is nothing")
end
do
  -- A pending slot picture is served only by askIfDue (love.update, before
  -- anything draws), never by beginFrame: the island ask there is the
  -- documented Metal-safe exception, the slot ask is not.
  check(HostSeam.pendingSlotPicture() == nil, "no slot picture pending at rest")
  HostSeam.requestSlotPicture("yellow", "slot1")
  check(HostSeam.pendingSlotPicture() == "saves/yellow/slot1.png", "a request is remembered by path")
  HostSeam.requestSlotPicture(nil, "slot1")
  check(HostSeam.pendingSlotPicture() == "saves/yellow/slot1.png", "a nameless request changes nothing")
  HostSeam.clearSlotPicture()
  check(HostSeam.pendingSlotPicture() == nil, "cleared")
end

-- ------- resolveExportCartImage: what a host export writes back into
--
-- The host `save` handler used to hand exportSav the staged template alone,
-- so an imported Gen 2 slot with a perfectly good .cart sidecar still refused
-- to export whenever the host staged nothing ("this save has no cartridge
-- image to write back into", live on device Aug 27 2026). The launcher's own
-- exportActiveSlot reads the sidecar; the seam now resolves the same way:
-- template first (the host stages its CURRENT library save, the freshest
-- image), then the active slot's sidecar, then nil for the codec to judge.

do
  local fs = fakeFs()
  fs.write("host/export_template.sav", "TEMPLATE")
  local deps = {
    SaveData = { activeSlot = function() return "slot4" end },
    SaveFileIO = { readCart = function() error("must not be asked when a template is staged") end },
  }
  local bytes, source = HostSeam.resolveExportCartImage(fs, "crystal", deps)
  check(bytes == "TEMPLATE", "cart image: the staged template wins")
  check(source == "template", "cart image: and names its source")
  check(fs.read("host/export_template.sav") == nil, "cart image: the template is consumed")
end
do
  local fs = fakeFs()
  local asked = {}
  local deps = {
    SaveData = { activeSlot = function(v) asked.version = v; return "slot7" end },
    SaveFileIO = { readCart = function(v, id) asked.cart = { v, id }; return "SIDECAR" end },
  }
  local bytes, source = HostSeam.resolveExportCartImage(fs, "crystal", deps)
  check(bytes == "SIDECAR", "cart image: no template falls back to the slot's sidecar")
  check(source == "sidecar", "cart image: and names its source")
  check(asked.version == "crystal", "cart image: the active slot asked for is this game's")
  check(asked.cart[1] == "crystal" and asked.cart[2] == "slot7",
        "cart image: the sidecar read is the ACTIVE slot's")
end
do
  local fs = fakeFs()
  local deps = {
    SaveData = { activeSlot = function() return nil end },
    SaveFileIO = { readCart = function() error("no active slot, nothing to read") end },
  }
  check(HostSeam.resolveExportCartImage(fs, "crystal", deps) == nil,
        "cart image: nothing staged and no active slot -> nil")
  local deps2 = {
    SaveData = { activeSlot = function() return "slot1" end },
    SaveFileIO = { readCart = function() return nil end },
  }
  check(HostSeam.resolveExportCartImage(fs, "crystal", deps2) == nil,
        "cart image: nothing staged and no sidecar -> nil, the codec decides")
end
do
  -- The exposure the resolver rests on: SaveFileIO.readCart reads the
  -- sidecar importToSlot writes, by the same path, through the same
  -- persistence fs the slots use — and a miss is nil, never an error.
  local SaveData = require("src.core.SaveData")
  local savedPortable = SaveData.portableFs
  SaveData.portableFs = function()
    return { read = function(path)
      if path == "saves/crystal/slot9.cart" then return "CARTBYTES" end
      error("no such file: " .. tostring(path))
    end }
  end
  local SaveFileIO = require("src.import.SaveFileIO")
  check(SaveFileIO.readCart("crystal", "slot9") == "CARTBYTES",
        "SaveFileIO.readCart reads saves/<version>/<id>.cart")
  check(SaveFileIO.readCart("crystal", "slot1") == nil,
        "SaveFileIO.readCart: a missing sidecar is nil, never an error")
  SaveData.portableFs = savedPortable
end

S.finish()
