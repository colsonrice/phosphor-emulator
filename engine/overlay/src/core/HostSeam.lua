-- HostSeam -- the contract an EMBEDDING HOST (a native app that boots this
-- engine in-process, e.g. gbal8r "Phosphor" on iOS) speaks with the game.
-- Four JSON files under host/ in the save directory:
--
--   host/launch.json         (host -> game, consumed at boot)
--       { "version": "yellow", "autoplay": true }
--       Skip the interactive launcher entirely: import headlessly from a
--       staged picked_rom.gb when the version isn't ready, then boot
--       straight into the game. Absent file = the launcher runs exactly as
--       it always has.
--   host/mods.json           (host -> game, consumed at boot)
--       { "set": { "SOME_MOD": false, ... } }
--       Enable/disable intents merged into the enable flags before the mod
--       loader reads them. On gen1 that means clearing any per-game override
--       as well as writing the shared one: modsByVersion outranks options.mods.
--   host/state.json          (game -> host, written after mods load)
--       { "engine": "...", "mods": [ { id, version, enabled, state } ] }
--   host/import_status.json  (game -> host, written while a host-driven
--       import runs; removed when it completes)
--       { "phase": "working"|"complete"|"error", "percent": 0-100,
--         "status": "...", "detail": "..." }
--   host/last_frame.png      (game -> host, refreshed every ~10s while a
--       host that asked for it plays)
--       A downscaled snapshot of the picture, for the host's Lock Screen
--       card and Dynamic Island. Written by HostSeam.displayBackend, which
--       main.lua installs on src/core/HostDisplay (upstream's optional
--       display-lifecycle seam); see HostSeam.applyLaunchCapture for the
--       switch that turns it on.
--
-- Every reader tolerates a malformed file (treated as absent) and every
-- function no-ops without love.filesystem, so headless test runs and
-- standalone builds are byte-identical when no host files exist.

local Json = require("src.link.Json")

local HostSeam = {}

local DIR = "host"

local function fsOrDefault(fs)
  return fs or (love and love.filesystem)
end

local function readJson(fs, name)
  fs = fsOrDefault(fs)
  if not (fs and fs.read) then return nil end
  local raw = fs.read(DIR .. "/" .. name)
  if type(raw) ~= "string" or raw == "" then return nil end
  local ok, decoded = pcall(Json.decode, raw)
  if not ok or type(decoded) ~= "table" then return nil end
  return decoded
end

local function writeJson(fs, name, tbl)
  fs = fsOrDefault(fs)
  if not (fs and fs.write) then return false end
  if fs.createDirectory then pcall(fs.createDirectory, DIR) end
  local ok, encoded = pcall(Json.encode, tbl)
  if not ok then return false end
  local wrote = pcall(fs.write, DIR .. "/" .. name, encoded)
  return wrote and true or false
end

local function removeFile(fs, name)
  fs = fsOrDefault(fs)
  if fs and fs.remove then pcall(fs.remove, DIR .. "/" .. name) end
end

local function fileExists(fs, name)
  fs = fsOrDefault(fs)
  if not (fs and fs.getInfo) then return false end
  local ok, info = pcall(fs.getInfo, DIR .. "/" .. name)
  return ok and info ~= nil
end

-- Read a host->game file and ALWAYS consume it, decodable or not -- a
-- malformed directive must not wedge every later boot.
local function consumeJson(fs, name)
  local existed = fileExists(fs, name)
  local decoded = readJson(fs, name)
  if existed then removeFile(fs, name) end
  return decoded
end

-- ------------------------------------------------------------------ launch

-- Read-and-delete the launch directive. Returns the decoded table only when
-- it names a real version; anything else is treated as absent (and still
-- deleted, so a bad directive can't wedge every future boot).
function HostSeam.consumeLaunch(fs)
  local launch = consumeJson(fs, "launch.json")
  if type(launch) ~= "table" or type(launch.version) ~= "string" then
    return nil
  end
  local GameVersion = require("src.core.GameVersion")
  if not GameVersion.VERSIONS[launch.version] then return nil end
  return launch
end

-- Apply the directive's option preferences. `touchControls = false` turns
-- the game's own touch overlay off (persisted -- the same flag the player's
-- own preference uses), for hosts that draw their own controls and feed a
-- virtual gamepad. A boolean true re-enables; absent leaves the player's
-- choice alone.
function HostSeam.applyLaunchPrefs(launch, fs)
  if type(launch) ~= "table" then return false end
  if type(launch.touchControls) ~= "boolean" then return false end
  local SaveData = require("src.core.SaveData")
  local options = SaveData.loadOptions(fs)
  local tc = options.touchControls
  if type(tc) ~= "table" then
    tc = {}
    options.touchControls = tc
  end
  if tc.enabled == launch.touchControls then return false end
  tc.enabled = launch.touchControls
  SaveData.saveOptions(options, fs)
  return true
end

-- Apply the directive's render-pipeline levels (`pipelines = {voxel = 3}`)
-- — the same persisted bucket Pipelines.syncOptions writes, so a host can
-- put a mode up (a dev build pre-seeding the voxel look) without the player
-- diving to the bottom of the OPTIONS list. A world pipeline level > 0
-- also zeroes tilt, mirroring Pipelines.syncOptions' rule.
function HostSeam.applyLaunchPipelines(launch, fs)
  if type(launch) ~= "table" or type(launch.pipelines) ~= "table" then
    return false
  end
  local SaveData = require("src.core.SaveData")
  local options = SaveData.loadOptions(fs)
  local bucket = options.pipelines
  if type(bucket) ~= "table" then
    bucket = {}
    options.pipelines = bucket
  end
  local changed = false
  local anyOn = false
  for id, level in pairs(launch.pipelines) do
    if type(id) == "string" and type(level) == "number" then
      local clamped = math.max(0, math.floor(level))
      if bucket[id] ~= clamped then
        bucket[id] = clamped
        changed = true
      end
      if clamped > 0 then anyOn = true end
    end
  end
  if anyOn and options.tilt ~= 0 then
    options.tilt = 0
    changed = true
  end
  if changed then SaveData.saveOptions(options, fs) end
  return changed
end

-- ------------------------------------------------------------ frame capture

-- Whether the host wants a periodic snapshot of the picture written to
-- host/last_frame.png. Default OFF, and deliberately: the snapshot costs a
-- full-window readback, and a host that never asked has nowhere to put the
-- result. A standalone run pays nothing.
local captureFrames = false

-- `captureFrames = true` in the boot directive turns the snapshot on.
--
-- A BOOT-time switch rather than a runtime one because the player's control
-- over this lives in the host's own Settings, which they can only reach by
-- leaving the session — so there is never a live run whose answer changed.
-- Off means no capture at all, not capture-and-discard: a switched-off
-- feature should not be costing a readback every ten seconds.
function HostSeam.applyLaunchCapture(launch)
  if type(launch) ~= "table" then return false end
  captureFrames = launch.captureFrames == true
  return captureFrames
end

function HostSeam.captureFramesEnabled()
  return captureFrames
end

-- ------------------------------------------------------- island frame snapshot
-- The host shows the last frame you saw on its Lock Screen card and in the
-- Dynamic Island, and it cannot get that picture any other way: we draw
-- through a CAMetalLayer, whose contents a UIKit window snapshot comes back
-- black on.
--
-- PERIODIC rather than on request, because the moment the host actually
-- wants the frame -- the app going to the background -- is the one moment we
-- cannot serve it. By then the display link is winding down, and GPU work
-- after didEnterBackground is a termination rather than a glitch. Leaving a
-- recent frame sitting on disk lets the host's background handler do nothing
-- but copy a file. Ten seconds matches the cadence its own headless capture
-- already uses, and the picture is a glance, not a live view.
--
-- This rides src/core/HostDisplay, upstream's optional display-lifecycle
-- backend, rather than a hand-patch of love.draw. `update` is where the beat
-- is counted and `endFrame` is where the picture exists: the engine calls it
-- with the render target still ours to borrow, immediately after the drawn
-- subject's own draw and before the frame is presented -- exactly the window
-- the hand-patched version carved out for itself. Riding the seam means a
-- pin bump moves the call sites for us. See HostSeam.displayBackend.
local ISLAND_FRAME_INTERVAL = 10
-- Comfortably above the largest island region (51x34pt ~ 153x102px at 3x),
-- small enough that the PNG encode is a rounding error.
local ISLAND_FRAME_WIDTH = 360
-- The island's own proportions, and near enough the GBA's 3:2 and the GB's
-- 10:9 that the crop lands on the picture rather than beside it.
local ISLAND_FRAME_ASPECT = 3 / 2
local islandFrameTimer = 0
local islandFrameDue = false
-- The readback waiting for a frame with a legitimate draw context to be
-- shrunk in: { data = ImageData, island = bool, slot = path-or-nil }. See
-- endFrame below.
local islandPendingShot = nil

-- ------- slot pictures (spec §3.6)
--
-- The engine keeps no screenshots of its saves. The host's save handler and
-- the watcher below ask for one whenever a slot is written, and it is
-- served by the SAME readback the Lock Screen frame uses, downscaled the
-- same way, written beside the slot as saves/<version>/<slot>.png. One
-- readback per save, so it is not gated on captureFrames.
local pendingSlotPicture = nil

-- Where a slot's picture lives: beside the slot.
function HostSeam.slotPicturePath(version, slot)
  return "saves/" .. tostring(version) .. "/" .. tostring(slot) .. ".png"
end

function HostSeam.requestSlotPicture(version, slot)
  if not (version and slot) then return end
  pendingSlotPicture = HostSeam.slotPicturePath(version, slot)
end

function HostSeam.pendingSlotPicture() return pendingSlotPicture end
function HostSeam.clearSlotPicture() pendingSlotPicture = nil end

-- Watches the active slot file for the game's own START -> SAVE, which
-- never passes through the host. `getInfo` is love.filesystem.getInfo,
-- injected so the pure part is testable. modtime is whole seconds, so two
-- writes inside one second read as one change; and the host's own `save`
-- changes the modtime too, so the poll after a host save asks for one
-- extra, harmless readback. The first sight of a slot only records it: a
-- boot onto an existing slot must not take a picture of the title.
function HostSeam.newSlotWatcher(getInfo)
  local seen = {}
  return {
    check = function(version, slot)
      if not (version and slot) then return nil end
      local info = getInfo("saves/" .. tostring(version) .. "/" .. tostring(slot) .. ".lua")
      if not info then return nil end
      local key = tostring(version) .. "/" .. tostring(slot)
      local last = seen[key]
      seen[key] = info.modtime
      if last ~= nil and info.modtime ~= last then return slot end
      return nil
    end,
  }
end

-- Shrink the pending screenshot and leave it where the host can pick it up.
--
-- Runs a frame LATER than the readback that produced it, and that delay is
-- the point: captureScreenshot's callback fires from inside present(), after
-- the frame has been handed to the compositor, and binding a canvas there is
-- drawing outside a frame. Here we are inside the engine's draw pass with the
-- render target ours to borrow and give back.
--
-- Downscaled BEFORE encoding. The readback is full-window whatever we do,
-- but PNG-encoding three million pixels every ten seconds is a hitch you can
-- feel, where encoding a 360-wide thumbnail is not.
--
-- CROPPED to a centred landscape band, not shrunk whole. A phone screenshot
-- is a tall portrait picture of which the game is the middle third: the rest
-- is letterbox above and the engine's own touch controls below. Every region
-- that shows this is landscape and fills rather than fits, so handing over the
-- whole window means handing over something that gets centre-cropped anyway --
-- but stored at twice the bytes, and cropped by a widget that cannot know
-- where the picture was. Cropping here, where the window is, lands on the game.
--
-- The host's bottom inset comes off first, for the presentations that reserve
-- a band for native chrome; then whatever is left is trimmed to 3:2.
local function drainIslandFrame()
  local shot = islandPendingShot
  islandPendingShot = nil
  local ok, err = pcall(function()
    local iw, ih = shot.data:getDimensions()
    -- captureScreenshot works in PIXELS and the inset is in points, so it
    -- has to cross the DPI scale or it removes a third of what it should.
    local scale = love.window.getDPIScale and love.window.getDPIScale() or 1
    local inset = math.floor((HostSeam.viewportBottomInset() or 0) * scale)
    local gh = math.max(1, ih - inset)
    -- Widest centred 3:2 band that fits. Falls back to the full frame on a
    -- window already wider than 3:2 (landscape), where there is nothing to
    -- trim and cropping would throw the picture away.
    local cw, ch = iw, math.floor(iw / ISLAND_FRAME_ASPECT)
    if ch > gh then
      ch = gh
      cw = math.min(iw, math.floor(gh * ISLAND_FRAME_ASPECT))
    end
    local cx = math.floor((iw - cw) / 2)
    local cy = math.floor((gh - ch) / 2)

    local w = math.min(ISLAND_FRAME_WIDTH, cw)
    local h = math.max(1, math.floor(w * ch / cw))
    local s = w / cw
    local full = love.graphics.newImage(shot.data)
    local canvas = love.graphics.newCanvas(w, h, { dpiscale = 1 })
    local previous = love.graphics.getCanvas()
    love.graphics.setCanvas(canvas)
    love.graphics.clear(0, 0, 0, 1)
    love.graphics.setColor(1, 1, 1, 1)
    -- Negative offsets scroll the crop origin up and left under the canvas.
    love.graphics.draw(full, -cx * s, -cy * s, 0, s, s)
    love.graphics.setCanvas(previous)
    local encoded = canvas:newImageData():encode("png")
    local bytes = encoded:getString()
    -- One plain write. love.filesystem has no rename, so there is no atomic
    -- swap to be had here — the guard against a torn read lives on the host
    -- side instead, which decodes the bytes before promoting them and keeps
    -- the frame it already had when they don't. That is the right place for
    -- it: the host is the only reader, and it reads once per session.
    if shot.island then
      love.filesystem.createDirectory(DIR)
      love.filesystem.write(DIR .. "/last_frame.png", bytes)
    end
    -- A slot picture: the same shrunken frame, beside the slot it is of.
    -- A torn read on the host side shows the row's badge until the next
    -- reload, which is the behaviour wanted.
    if shot.slot then
      love.filesystem.write(shot.slot, bytes)
    end
  end)
  if not ok then
    print("[island] frame snapshot failed: " .. tostring(err))
  end
end

-- The backend main.lua hands to HostDisplay.setBackend. Every method is
-- optional per that contract, so this implements only the three the snapshot
-- needs: count the beat, ASK at the top of the frame, WRITE at the bottom.
HostSeam.displayBackend = {}

-- The readback request itself, shared by update (the normal asker) and
-- beginFrame (the first game frame after a scene change). `includeSlot`
-- is true only from askIfDue: a slot picture is asked for from inside
-- pollHostCommands, which runs AFTER love.update's first askIfDue, so the
-- caller asks again right after the poll and before Game:update. It must
-- never be served from beginFrame, which runs after a mod's update hook
-- may have drawn (see beginFrame below for why that is a hard assert).
-- Set when a readback has been ASKED for and not yet arrived. `islandPendingShot`
-- alone cannot say so: captureScreenshot's callback fires from inside present(),
-- at the END of the frame, so two asks in one frame (the island beat from
-- love.update's first askIfDue, then a slot picture from the host poll) both
-- saw nil, both queued, and the second callback overwrote the first -- with
-- `islandFrameDue` already cleared, so the Lock Screen frame was simply lost
-- for another ten seconds. Whichever asks first now wins the frame; the other
-- stays pending and is served on the next one.
local captureAsked = false
-- ...and the frame it was asked on. LOVE does not call the screenshot
-- callback at all when the readback yields no ImageData, and this flag is
-- otherwise only cleared there: one such frame would stop every Lock Screen
-- frame AND every slot picture for the rest of the session, silently. A
-- readback that has not arrived within a second of frames is treated as
-- lost, which is what the code did before the flag existed.
local captureAskedFrame = 0
local captureFrameCounter = 0
local CAPTURE_ASK_TIMEOUT = 60

local function requestCapture(includeSlot)
  if not (love and love.graphics and love.graphics.captureScreenshot) then return end
  if islandPendingShot then return end   -- one in flight is enough
  if captureAsked then
    if captureFrameCounter - captureAskedFrame < CAPTURE_ASK_TIMEOUT then return end
    captureAsked = false   -- the readback never arrived; do not seize up
  end
  local wantIsland = islandFrameDue
  local wantSlot = includeSlot and pendingSlotPicture or nil
  if not (wantIsland or wantSlot) then return end
  islandFrameDue = false
  if wantSlot then pendingSlotPicture = nil end
  captureAsked = true
  captureAskedFrame = captureFrameCounter
  love.graphics.captureScreenshot(function(imagedata)
    captureAsked = false
    islandPendingShot = { data = imagedata, island = wantIsland, slot = wantSlot }
  end)
end

-- Count the beat. Called for EVERY engine frame, including the launcher, the
-- importer and the save editor -- which the hand-patched version could not
-- do, because it had to sit after love.update's early returns. That is a
-- small improvement rather than a regression: nothing is captured off a
-- non-game frame (see beginFrame), so the only effect is that a player who
-- spent four minutes importing gets their Lock Screen card on the first
-- second of play instead of ten seconds in.
function HostSeam.displayBackend:update(dt)
  captureFrameCounter = captureFrameCounter + 1
  if not captureFrames then return end
  if islandPendingShot then return end   -- one in flight is enough
  islandFrameTimer = islandFrameTimer + (tonumber(dt) or 0)
  if islandFrameTimer < ISLAND_FRAME_INTERVAL then return end
  islandFrameTimer = 0
  islandFrameDue = true
end

-- Ask for a due readback from love.update, once the caller knows this is a
-- game frame (i.e. past love.update's early returns) and BEFORE anything
-- runs that could draw.
--
-- beginFrame is early enough only if nothing has drawn yet this frame, and
-- that is not ours to assume: a MOD may draw from an update hook, which
-- takes the drawable before the draw phase begins and leaves the request too
-- late to matter. A player running a world-billboard mod hit exactly that --
-- every wild encounter aborted the app under Metal validation. The kind gate
-- still holds, because only the caller past those early returns calls this.
function HostSeam.displayBackend:askIfDue()
  requestCapture(true)
end

-- Ask for the readback BEFORE the frame draws anything, and never after.
--
-- This ordering is load-bearing on Metal, not a tidiness preference.
-- captureScreenshot only queues a callback; the copy itself happens in
-- love.graphics.present(), which blits out of the frame's CAMetalDrawable.
-- A drawable is framebufferOnly -- unreadable -- unless the layer said
-- otherwise BEFORE it was handed out, and LOVE's Metal backend clears that
-- flag in exactly one place: the moment it calls nextDrawable, and only if a
-- capture is already pending. The drawable is taken on the frame's first
-- draw call, so a request made after the game has drawn arrives too late to
-- change anything, and present() then reads a texture Metal will not let it
-- read. Under Metal API validation (any Xcode run) that is a hard assert:
-- "sourceTexture must not be a framebufferOnly texture", the whole app gone
-- mid-session. Asking here, before Game:draw, is what makes the readback
-- legal -- and it still captures THIS frame, since present() is the one that
-- serves the request either way.
--
-- `kind ~= "game"` is the whole gate, and it has to be explicit. The
-- hand-patched version got this for free by sitting below love.draw's early
-- returns; HostDisplay calls the frame hooks for the launcher, the
-- touch-controls editor and the save editor too, and the host's card should
-- show the game rather than whichever menu happened to be up when the timer
-- came round.
function HostSeam.displayBackend:beginFrame(kind)
  if kind ~= "game" then return end
  -- A no-op when update already asked this frame, which is the common case.
  -- Still the only asker on the first game frame after a scene change.
  -- Island only: a slot picture waits for the next frame's askIfDue.
  requestCapture(false)
end

-- Shrink and write whatever the last readback produced.
--
-- Still a frame later than the request that produced it: the callback fires
-- from inside present(), after this frame's endFrame has already run, so the
-- earliest a shot can be drained is the frame after. See drainIslandFrame.
function HostSeam.displayBackend:endFrame(kind)
  if kind ~= "game" then return end
  if islandPendingShot then drainIslandFrame() end
end

-- ----------------------------------------------------------------- session

-- The live game, through one shape whichever generation booted.
--
-- Gold and Silver boot `Game2` (main.lua bootGame), which keeps `self.world`
-- rather than `self.overworld`, has `continueGame(save)` rather than
-- `restoreSave`, and reads its slot through src/core/gen2/Save.lua. The host
-- command handlers were written against Gen 1's `Game`, so on Gen 2 `save`
-- refused from the overworld and `load` called a method that does not exist.
-- Every handler asks these questions through here instead, and nothing in
-- main.lua names `overworld`, `restoreSave` or `SaveData.load` again.
--
-- `deps` is for tests: { SaveData = ..., Save = ... } stand in for the two
-- slot readers, which need a filesystem and a ROM cache to run for real.
function HostSeam.session(game, generation, deps)
  deps = deps or {}
  if generation == 2 then
    return {
      inWorld = function()
        return game.world ~= nil and game.world.map ~= nil
      end,
      -- Game2:startWorld's own test; the stack above the world is UI.
      topIsWorld = function()
        return game.world ~= nil and game.world.map ~= nil and game.phase == "play"
      end,
      readSlot = function(version)
        local Save = deps.Save or require("src.core.gen2.Save")
        local loaded, recovered = Save.load(version)
        return loaded, recovered
      end,
      -- continueGame(nil) starts a NEW GAME (Game2.lua:269). A host load with
      -- nothing to load must never reach it.
      enterWorld = function(loaded, recovered)
        if type(loaded) ~= "table" then error("no save to load", 0) end
        game:continueGame(loaded)
      end,
      writeSave = function() return game:writeSave() end,
      returnToTitle = function() game:returnToTitle() end,
    }
  end
  -- Gen 1 keeps one OverworldState for the whole process and returnToTitle
  -- never clears its map, so `overworld.map ~= nil` stays true on the title
  -- after a Restart. Asked that way, the exit's save would write the position
  -- the Restart just discarded back into the slot. "In the world" is
  -- therefore "the overworld is on the stack": under a battle too, which is
  -- where captureSave has always been allowed to run.
  local function overworldOnStack()
    local states = game.stack and game.stack.states
    if type(states) ~= "table" then return false end
    for _, state in ipairs(states) do
      if state == game.overworld then return true end
    end
    return false
  end
  return {
    inWorld = function()
      return game.overworld ~= nil and game.overworld.map ~= nil and overworldOnStack()
    end,
    topIsWorld = function()
      return game.overworld ~= nil and game.overworld.map ~= nil
        and game.stack ~= nil and game.stack:top() == game.overworld
    end,
    readSlot = function(version)
      local SaveData = deps.SaveData or require("src.core.SaveData")
      return SaveData.load(version)
    end,
    enterWorld = function(loaded, recovered)
      if type(loaded) ~= "table" then error("no save to load", 0) end
      -- The title's own onContinue and the F2 hotkey make this exact call.
      game:restoreSave(loaded, recovered, { freshBoot = true })
    end,
    writeSave = function() return game:writeSave() end,
    returnToTitle = function() game:returnToTitle() end,
  }
end

-- Point the version at the slot the directive names, BEFORE boot, so the
-- engine's own reads see it. True when nothing was asked or the slot was
-- selected; false when a slot was named and no longer exists, in which case
-- the caller must not `continue`: entering whichever slot happens to be
-- active is not the save that was tapped.
function HostSeam.selectLaunchSlot(launch, version, deps)
  if type(launch) ~= "table" or type(launch.slot) ~= "string" then return true end
  local LaunchOptions = (deps and deps.LaunchOptions) or require("src.core.LaunchOptions")
  return LaunchOptions.selectSlot(version, launch.slot) ~= nil
end

-- `continue = true` in the directive: enter the active slot's world right
-- after bootGame, in place of the splash and the title. This is the title
-- screen's own CONTINUE (Game:makeTitleState's onContinue, Game2's intro
-- menu) without the title: restoreSave / continueGame pop whatever the boot
-- pushed and push the world. A save that fails to load, or no save at all,
-- leaves the title exactly as today. The outcome lands in
-- host/continue_result.json so the host (and the boot probe) can read it.
function HostSeam.continueAfterBoot(launch, game, version, generation, deps, fs)
  if type(launch) ~= "table" or launch["continue"] ~= true then return false end
  deps = deps or {}
  local SaveData = deps.SaveData or require("src.core.SaveData")
  local lfs = fsOrDefault(fs)
  local function report(tbl) writeJson(lfs, "continue_result.json", tbl) end
  local name = SaveData.saveFilename(version)
  if not (lfs and lfs.getInfo and lfs.getInfo(name)) then
    report({ ok = true, entered = false, reason = "no save" })
    return false
  end
  local session = HostSeam.session(game, generation, deps)
  local ok, err = pcall(function()
    local loaded, recovered = session.readSlot(version)
    session.enterWorld(loaded, recovered)
  end)
  if not ok then
    report({ ok = false, entered = false, error = tostring(err) })
    return false
  end
  report({ ok = true, entered = true })
  return true
end

-- ---------------------------------------------------------------- commands

-- The cartridge image a host export writes back into. The staged template
-- (host/export_template.sav, the host's CURRENT library save — the freshest
-- image, staged only when it validates for this cartridge) wins and is
-- consumed; with none, the active slot's own .cart sidecar — the image an
-- imported Gen 2 slot came from, written by SaveFileIO.importToSlot and
-- read by the launcher's own exportActiveSlot. Nil when neither exists, so
-- the codec's refusal (Gen 2) or the template-less path (Gen 1) decides.
-- Handing exportSav the template ALONE was the device failure of Aug 27
-- 2026: an imported Crystal slot, sidecar on disk, refused to export the
-- moment the host staged nothing.
function HostSeam.resolveExportCartImage(fs, version, deps)
  -- The image passes through WHOLE, RTC footer included. A real GBC .sav
  -- is 32786 bytes -- 32 KiB of SRAM plus the cart's clock -- and the
  -- exporters hand the footer back on purpose: dropping it resets the
  -- Gen 2 clock, which costs the player daily events and earns them the
  -- clock-adjustment penalty. The host tolerates the footer on the far
  -- side (an early version trimmed here to appease a strict size check,
  -- which was fixing the wrong end).
  local lfs = fsOrDefault(fs)
  local template = lfs and lfs.read and lfs.read("host/export_template.sav") or nil
  if template then
    removeFile(fs, "export_template.sav")
    return template, "template"
  end
  deps = deps or {}
  local SaveData = deps.SaveData or require("src.core.SaveData")
  local SaveFileIO = deps.SaveFileIO or require("src.import.SaveFileIO")
  local slot = SaveData.activeSlot(version)
  if not slot then return nil end
  local sidecar = SaveFileIO.readCart(version, slot)
  if sidecar then return sidecar, "sidecar" end
  return nil
end

local lastCommandSeq = nil

-- Poll host/command.json — the host's runtime channel for the things its
-- own chrome offers on every game (save, load, fast-forward). The file is
-- consumed on read; `seq` de-dupes a rewrite of the same command. The
-- caller (main.lua) owns dispatch, since it holds the live Game.
function HostSeam.pollCommand(fs)
  local cmd = consumeJson(fs, "command.json")
  if type(cmd) ~= "table" then return nil end
  if type(cmd.seq) ~= "number" or cmd.seq == lastCommandSeq then return nil end
  lastCommandSeq = cmd.seq
  if type(cmd.cmd) ~= "string" then return nil end
  return cmd
end

-- Report a command's outcome so the host can surface success/failure in
-- its own UI instead of guessing. Overwritten per command; the host
-- consumes it.
function HostSeam.writeCommandResult(tbl, fs)
  return writeJson(fs, "command_result.json", tbl)
end

-- ----------------------------------------------------------- session menu

-- The host's way out, reached from the engine's OWN hotbar: the strip of
-- SAVE LOAD SPEED COLOR TILT ZOOM cells the pad's "..." toggle drops.
--
-- Under Phosphor's "Mod's Own" control style the engine draws its whole
-- touch UI and Phosphor used to add one floating menu button beneath that
-- "...". That button faded to nothing after six idle seconds, and nothing a
-- player does on the engine's pad restarted its clock, so a few seconds into
-- every session the only way back to Phosphor was an invisible corner nobody
-- knew to tap. Reported on LeafGreen, Sep 23 2026: "no way to exit the game".
-- The hotbar never fades and is where a player reaches anyway, so the way
-- out lives there too, as two cells after the engine's own:
--
--   EXIT  back to the host's library, through the host's own exit, which
--         saves and carries the save across first (a LOVE quit would skip
--         all of that).
--   MORE  the host's session sheet: the saves list, the control style,
--         skins, restart, 2D mode.
--
-- MORE is last because the last cell sits right under the "..." toggle, and
-- a tap meant for the toggle that lands a little low should open a menu, not
-- leave the game. Neither is called MENU: under Phosphor's own controls MENU
-- is the host's button that OPENS this bar (Colson, Sep 24 2026: "calling it
-- menu, and then having a menu button is bad ia").
--
-- game -> host: host/menu_request.json { seq, action = "menu" | "exit" }.
-- The host consumes it and does what its own sheet would. `seq` is monotonic
-- so a host that reads late still sees one press as one request. A host that
-- predates `action` reads every request as the menu, which is the safe way
-- to misread one.
local menuRequestSeq = 0

HostSeam.MENU_HOTKEY = "phosphor_menu"
HostSeam.MENU_LABEL = "MORE"
HostSeam.EXIT_HOTKEY = "phosphor_exit"
HostSeam.EXIT_LABEL = "EXIT"

function HostSeam.requestMenu(fs, action)
  menuRequestSeq = menuRequestSeq + 1
  return writeJson(fs, "menu_request.json",
                   { seq = menuRequestSeq, action = action or "menu" })
end

-- ------------------------------------------------ the bar, opened by the host
--
-- Under Phosphor's OWN control style ("Overlay") the engine's pad is switched
-- off (launch.touchControls = false), and the "..." toggle goes with it, so
-- the bar above could not be reached at all: Phosphor's MENU opened a sheet
-- of its own with Save, Load and Speed but no COLOR, TILT or ZOOM. Colson,
-- Sep 24 2026, asked for the engine's bar from that MENU instead. So the
-- host opens the SAME bar, with the pad still off, hung under the host's
-- button rather than under a toggle that is not on screen.
--
-- host -> game: host/hotbar_request.json { op = "toggle" | "close" |
--   "anchor", anchor = { x, y } }, consumed on read. `anchor` is where the
--   bar hangs, as fractions of the window: centred on x, top edge at y. The
--   host picks a y below everything its own window claims, so no tap on the
--   bar lands on the host instead of here. "anchor" only moves it, for a
--   MENU that moved.
-- game -> host: host/hotbar.json carries `hostStrip`, true while the engine
--   takes those requests. A payload older than this never writes it, and one
--   whose bar failed to draw writes false: either way the host's MENU opens
--   the host's own sheet, so it can never become a button that does nothing.
--
-- The pad draws its strip only from inside its own draw, after its d-pad and
-- buttons and only while it is visible, so the painting here is this file's,
-- copied from the strip branch of TouchControls:draw (same fills, alphas and
-- label shadow), and the geometry is TouchControls:hotbarStrip's, centred on
-- the anchor. The CELLS are never copied: they come from hotbarItems(), so a
-- cell upstream adds turns up here on its own, and a press does what the
-- pad's own press does: the cell's keys through love.keypressed, its hotkeys
-- through the pad's handler.

-- Where the bar hangs when a request names no anchor: top centre.
local DEFAULT_ANCHOR = { x = 0.5, y = 0.12 }

local function clamp01(v)
  if v < 0 then return 0 end
  if v > 1 then return 1 end
  return v
end

-- The host bar's state lives on the pad module it belongs to, one per
-- TouchControls, so the suite's stand-ins never share it.
local function hostBar(tc)
  local bar = rawget(tc, "_phosphorBar")
  if not bar then
    bar = { open = false, touches = {} }
    tc._phosphorBar = bar
  end
  return bar
end

-- One press or release of a bar cell, the way the pad's own enterControl /
-- exitControl fire a hotbar cell: keys through love.keypressed /
-- love.keyreleased (the engine's F1 / F2 / 1..4 ladder), hotkeys through the
-- pad's handler, and the pad's own buzz on the press.
local function fireBarCell(tc, bar, ctl, down)
  local env = bar.env or {}
  for _, key in ipairs(ctl.keys or {}) do
    if env.key then env.key(key, down) end
  end
  for _, action in ipairs(ctl.hotkeys or {}) do
    local handler = tc.hotkeyHandler
    if type(handler) == "function" then pcall(handler, action, down) end
  end
  if down and type(tc.buzz) == "function" then pcall(tc.buzz, tc.haptics) end
end

-- Close the bar and let go of anything held on it. The held set is swapped
-- out before it is released, because releasing a hotkey cell can land back
-- here (MORE and EXIT close the bar from inside the handler).
local function closeBar(tc)
  local bar = hostBar(tc)
  bar.open = false
  bar.cells = nil
  local held = bar.touches
  bar.touches = {}
  for _, ctl in pairs(held) do fireBarCell(tc, bar, ctl, false) end
end

-- Whether the pad has its own strip on screen. The host's then never draws:
-- the player switched to the engine's own controls under an open bar, and
-- one bar is the most there should ever be.
local function padShowsOwnHotbar(tc)
  return type(tc.visible) == "function" and tc:visible() == true
    and type(tc.hotbarShown) == "function" and tc:hotbarShown() == true
end

-- Where the host bar's cells go. TouchControls:hotbarStrip's arithmetic cell
-- for cell, except that the bar is centred on the anchor instead of ending
-- under the "..." toggle, and kept below the safe rect's top as well as above
-- its bottom. `cellH` is the pad's own cell height and `labelWidth` measures
-- in the pad's own font; `safe` is { x, y, w, h }.
function HostSeam.hotbarLayout(items, cellH, labelWidth, safe, anchorX, anchorY)
  local cells = {}
  local n = type(items) == "table" and #items or 0
  if n == 0 or type(cellH) ~= "number" or cellH <= 0 then return cells end
  local pad = cellH * 0.14
  local cw = cellH * 1.9
  for _, ctl in ipairs(items) do
    cw = math.max(cw, labelWidth(tostring(ctl.label or "")) + pad * 3)
  end
  local total = math.min(safe.w - pad * 2, cw * n)
  cw = total / n
  local x0 = math.max(safe.x + pad,
                      math.min(anchorX - total / 2, safe.x + safe.w - pad - total))
  local y0 = math.max(safe.y, math.min(anchorY, safe.y + safe.h - cellH))
  for i, ctl in ipairs(items) do
    cells[i] = { ctl = ctl, label = ctl.label, h = cellH,
                 x = x0 + (i - 1) * cw, y = y0, w = cw - pad }
  end
  return cells
end

-- Whether the host has the bar open right now.
function HostSeam.hotbarOpenedByHost(TouchControls)
  if type(TouchControls) ~= "table" then return false end
  local bar = rawget(TouchControls, "_phosphorBar")
  return bar ~= nil and bar.open == true
end

-- The cells the host bar drew last frame: the touch path hit-tests these, so
-- a press lands on exactly what is on screen.
function HostSeam.hotbarCells(TouchControls)
  if type(TouchControls) ~= "table" then return nil end
  local bar = rawget(TouchControls, "_phosphorBar")
  if not (bar and bar.open) then return nil end
  return bar.cells
end

-- Apply the host's request, if there is one. Returns whether the bar is open
-- after it, or nil when there was nothing to apply. A pad the seam was never
-- installed on is left alone, request and all.
function HostSeam.pollHotbarRequest(TouchControls, fs)
  if type(TouchControls) ~= "table" or not rawget(TouchControls, "_phosphorHotbarMenu") then
    return nil
  end
  local req = consumeJson(fs, "hotbar_request.json")
  if type(req) ~= "table" then return nil end
  local bar = hostBar(TouchControls)
  local a = req.anchor
  if type(a) == "table" and type(a.x) == "number" and type(a.y) == "number"
     and a.x == a.x and a.y == a.y then
    bar.anchor = { x = clamp01(a.x), y = clamp01(a.y) }
  end
  -- MENU moved (the phone turned, and the engine never resets its pad for
  -- that): re-hang the bar, open or closed, without toggling it.
  if req.op == "anchor" then return bar.open end
  if req.op ~= "close" and not bar.open and not bar.broken then
    bar.open = true
  else
    closeBar(TouchControls)
  end
  return bar.open
end

local function paintBar(bar, g, font)
  local cells = bar.cells
  local first, last = cells[1], cells[#cells]
  if not (first and last) then return end
  local held = {}
  for _, ctl in pairs(bar.touches) do held[ctl] = true end
  g.setFont(font)
  local pad = first.h * 0.14
  g.setColor(0.15, 0.15, 0.15, 0.55)
  g.rectangle("fill", first.x - pad, first.y - pad,
              last.x + last.w - first.x + pad * 2, first.h + pad * 2, first.h * 0.3)
  for _, cell in ipairs(cells) do
    local down = held[cell.ctl] == true
    g.setColor(0.3, 0.3, 0.3, down and 0.85 or 0.6)
    g.rectangle("fill", cell.x, cell.y, cell.w, cell.h, cell.h * 0.25)
    local label = tostring(cell.label or "")
    local tw = font:getWidth(label)
    local ty = cell.y + (cell.h - font:getHeight()) * 0.5
    g.setColor(0, 0, 0, 0.6)
    g.print(label, cell.x + (cell.w - tw) * 0.5 + 1, ty + 1)
    g.setColor(1, 1, 1, down and 0.95 or 0.85)
    g.print(label, cell.x + (cell.w - tw) * 0.5, ty)
  end
end

-- Lay out and paint the host bar, last thing in the frame like the pad
-- itself. Any failure closes the bar AND withdraws it (`broken`), which the
-- next report tells the host: a bar that cannot draw must hand MENU back to
-- the host's own sheet rather than leave a button that opens nothing.
local function drawHostBar(tc)
  local bar = hostBar(tc)
  if not bar.open then bar.cells = nil return end
  if tc.preview or padShowsOwnHotbar(tc) then closeBar(tc) return end
  local env = bar.env or {}
  local g = env.graphics
  if not g then return end
  local pushed = false
  local ok, err = pcall(function()
    local L = tc:layout()
    local zone = L and L.hotbar
    local font = tc.labelFont
    if not (zone and type(zone.w) == "number" and font) then
      error("the pad has no layout to size the bar from", 0)
    end
    local ox, oy, sw, sh = env.windowRect()
    local ww, wh = env.fullDimensions()
    local anchor = bar.anchor or DEFAULT_ANCHOR
    bar.cells = HostSeam.hotbarLayout(tc:hotbarItems(), zone.w * 0.95,
      function(label) return font:getWidth(label) end,
      { x = ox, y = oy, w = sw, h = sh }, anchor.x * ww, anchor.y * wh)
    g.push("all")
    pushed = true
    g.origin()
    paintBar(bar, g, font)
    g.pop()
    pushed = false
  end)
  if not ok then
    if pushed then pcall(g.pop) end
    bar.broken = true
    closeBar(tc)
    print("[phosphor] host hotbar withdrawn: " .. tostring(err))
  end
end

-- What the bar's cells and draw need from the running engine, looked up the
-- way the pad itself looks them up; the suite hands in stand-ins.
local function barEnv(deps)
  deps = deps or {}
  return {
    graphics = deps.graphics or (love and love.graphics),
    windowRect = deps.windowRect or function()
      return require("src.core.SafeArea").windowRect()
    end,
    fullDimensions = deps.fullDimensions or function()
      return require("src.render.GameViewport").fullDimensions()
    end,
    -- TouchControls' own pressKey, looked up per press as it does it.
    key = deps.key or function(key, down)
      local fn = love and (down and love.keypressed or love.keyreleased)
      if type(fn) == "function" then pcall(fn, key, key, false) end
    end,
  }
end

-- Put EXIT and MORE in the hotbar, route their presses to the host, and let
-- the host open the bar itself.
--
-- All of it is wrapping, on the touch modules, and none of it is a file the
-- overlay has to carry: the hotkey NAMES are registered (TouchSkin.newControl
-- parses a spec through TouchSkin.HOTKEYS and drops anything it does not know
-- as decoration), the item list gains the two cells after the engine's own
-- six, the handler every generation installs from its load() is wrapped so a
-- press never reaches the game as an unknown action, and draw / touches /
-- reset / init are wrapped for the host-opened bar. Idempotent, and pure over
-- the modules it is handed so the suites drive it with stand-ins. Embedded
-- hosts call this; standalone keeps the hotbar it shipped, because there is
-- no host to go back to.
function HostSeam.installHotbarMenu(TouchControls, TouchSkin, fs, deps)
  if type(TouchControls) ~= "table" or type(TouchSkin) ~= "table" then return false end
  if TouchControls._phosphorHotbarMenu then return false end
  TouchControls._phosphorHotbarMenu = true
  -- A previous session's report must not decide this one's fallback, and a
  -- request it left behind must not open this one's bar.
  removeFile(fs, "hotbar.json")
  removeFile(fs, "hotbar_request.json")
  hostBar(TouchControls).env = barEnv(deps)

  TouchSkin.HOTKEYS = TouchSkin.HOTKEYS or {}
  TouchSkin.HOTKEYS[HostSeam.MENU_HOTKEY] = HostSeam.MENU_HOTKEY
  TouchSkin.HOTKEYS[HostSeam.EXIT_HOTKEY] = HostSeam.EXIT_HOTKEY

  local baseItems = TouchControls.hotbarItems
  function TouchControls:hotbarItems()
    local items = baseItems(self)
    -- The engine caches the list per init() and hands back the same table,
    -- so the mark on it is what keeps two cells two cells.
    if type(items) == "table" and not items._phosphorMenu then
      for _, cell in ipairs({ { HostSeam.EXIT_HOTKEY, HostSeam.EXIT_LABEL },
                              { HostSeam.MENU_HOTKEY, HostSeam.MENU_LABEL } }) do
        local ctl = TouchSkin.newControl(cell[1], 0, 0, 0, 0, "rect")
        ctl.label = cell[2]
        items[#items + 1] = ctl
      end
      items._phosphorMenu = true
    end
    return items
  end

  local baseSetHandler = TouchControls.setHotkeyHandler
  function TouchControls:setHotkeyHandler(fn)
    local inner = type(fn) == "function" and fn or nil
    local pad = self
    baseSetHandler(self, function(action, pressed)
      if action == HostSeam.MENU_HOTKEY or action == HostSeam.EXIT_HOTKEY then
        if pressed then
          HostSeam.requestMenu(fs, action == HostSeam.EXIT_HOTKEY and "exit" or "menu")
          -- Fold the bar away, whichever one this was: the sheet should close
          -- onto the game, not onto a bar the player has finished with.
          pad.hotbarOpen = false
          closeBar(pad)
        end
        return
      end
      if inner then return inner(action, pressed) end
    end)
  end

  -- What the host can reach, reported from draw once per change, so the file
  -- is written a handful of times per session and never per frame.
  --
  -- `shown`: the hotbar, and so EXIT and MORE, can be reached on the pad's
  -- own controls: the pad is on for this platform, the touch-controls option
  -- is on, the hotbar option is on, and no touch skin has replaced the pad
  -- (skins draw no hotbar). Under "Mod's Own" the host draws nothing of its
  -- own while this is true (Colson, Sep 23 2026: "just use gen1recomp's menu
  -- when we use his overlay"), and a small button only while it is false,
  -- because a session with no way out is the one thing this seam exists to
  -- prevent. A pad hiding the overlay is not "off": one touch brings the pad
  -- back, and the cells with it, which is the engine's own rule.
  --
  -- `hostStrip`: the host may open the bar itself (above). False only once
  -- a draw of it has failed.
  local lastShown, lastOffered = nil, nil
  local baseDraw = TouchControls.draw
  function TouchControls:draw(...)
    local shown = self.active == true and self.enabled ~= false
      and self:hotbarShown() == true
    local offered = not hostBar(self).broken
    if shown ~= lastShown or offered ~= lastOffered then
      lastShown, lastOffered = shown, offered
      writeJson(fs, "hotbar.json", { shown = shown, hostStrip = offered })
    end
    baseDraw(self, ...)
    drawHostBar(self)
  end

  -- The pad keeps first refusal on every touch (#807), and the open bar is
  -- the pad's, so it goes first of all: a press on a cell is captured here
  -- and never reaches the pad or the game, and any other press goes on
  -- exactly as it did.
  local basePressed = TouchControls.touchpressed
  function TouchControls:touchpressed(id, x, y, ...)
    local bar = hostBar(self)
    if bar.open and bar.cells and not self.preview then
      for _, cell in ipairs(bar.cells) do
        if x >= cell.x and x <= cell.x + cell.w
           and y >= cell.y and y <= cell.y + cell.h then
          bar.touches[id] = cell.ctl
          fireBarCell(self, bar, cell.ctl, true)
          return true
        end
      end
    end
    if basePressed then return basePressed(self, id, x, y, ...) end
  end

  local baseMoved = TouchControls.touchmoved
  function TouchControls:touchmoved(id, ...)
    -- A captured finger holds its cell wherever it wanders, like the pad's
    -- own hotbar cells do.
    if hostBar(self).touches[id] then return end
    if baseMoved then return baseMoved(self, id, ...) end
  end

  local baseReleased = TouchControls.touchreleased
  function TouchControls:touchreleased(id, ...)
    local bar = hostBar(self)
    local ctl = bar.touches[id]
    if ctl then
      bar.touches[id] = nil
      fireBarCell(self, bar, ctl, false)
      return
    end
    if baseReleased then return baseReleased(self, id, ...) end
  end

  -- LOVE has no touchcancelled; the engine resets the pad on focus and
  -- visibility loss instead, which closes the pad's own strip. The host's
  -- closes with it, letting go of anything held.
  local baseReset = TouchControls.reset
  function TouchControls:reset(...)
    closeBar(self)
    if baseReset then return baseReset(self, ...) end
  end

  -- A new game starts with the bar closed, as it starts with the pad's.
  local baseInit = TouchControls.init
  function TouchControls:init(...)
    closeBar(self)
    if baseInit then return baseInit(self, ...) end
  end
  return true
end

-- ------------------------------------------------------------------- mods

-- Merge host enable/disable intents into the flags the mod loader reads, then
-- delete the intents file. Returns true when anything changed.
function HostSeam.applyModIntents(fs)
  local intents = consumeJson(fs, "mods.json")
  if intents == nil then return false end
  if type(intents.set) ~= "table" then return false end

  local SaveData = require("src.core.SaveData")
  local options = SaveData.loadOptions(fs)
  options.mods = options.mods or {}
  local changed = false
  for id, enabled in pairs(intents.set) do
    if type(id) == "string" and type(enabled) == "boolean" then
      if options.mods[id] ~= enabled then
        options.mods[id] = enabled
        changed = true
      end
      -- options.mods is the SHARED flag, and gen1 reads a per-game answer
      -- ahead of it: SaveData.modEnabled consults
      -- options.modsByVersion[version][id] first, and the loader's one-time
      -- migrateModEnablement gives every installed mod an explicit per-game
      -- entry on the first boot. Left in place, those entries make the write
      -- above a write nothing reads -- the mod keeps loading, the in-game
      -- list keeps showing it on, and the pane's switch snaps back the next
      -- time state.json is written.
      --
      -- Cleared rather than rewritten per version, for two reasons. The pane
      -- is one switch for the whole library with no per-game control on it,
      -- so "off" can only honestly mean off everywhere. And this runs before
      -- consumeLaunch, so the game about to boot is not known here to scope a
      -- write to. No-op when the field is absent, which is every gen2 install
      -- and keeps the two overlays identical.
      local byVersion = options.modsByVersion
      if type(byVersion) == "table" then
        for _, bucket in pairs(byVersion) do
          if type(bucket) == "table" and bucket[id] ~= nil then
            bucket[id] = nil
            changed = true
          end
        end
      end
    end
  end
  -- "Try it anyway": mods the player accepted on a game their author never
  -- claimed. This is the engine's OWN override -- Loader:_gateGeneration reads
  -- SaveData.modForced and loads a forced mod normally, keeping a note that it
  -- was never verified here -- and the host simply had no way to set it.
  --
  -- Scoped to one game, which is why `forcedGame` travels in the payload: this
  -- runs before consumeLaunch, so the cartridge about to boot is not otherwise
  -- knowable here, and setModForced refuses a version it cannot recognise.
  --
  -- A FULL statement, like `set` above: every id the host names is written,
  -- true or false, so taking the acceptance back clears the engine's row
  -- rather than leaving it forced forever.
  local forcedGame = intents.forcedGame
  if type(intents.forced) == "table" and type(forcedGame) == "string" then
    for id, on in pairs(intents.forced) do
      if type(id) == "string" and type(on) == "boolean" then
        if SaveData.setModForced(options, id, on, forcedGame) then changed = true end
      end
    end
  end

  -- "Try it anyway", for the OTHER claim: the engine range in `game_version`.
  -- Flat and per mod rather than per game, because the range is over the
  -- ENGINE and the engine is the same one whichever cartridge boots -- so
  -- unlike `forced` above this needs no game in hand, and the Settings pane
  -- can write it as honestly as a cartridge's own pane can.
  --
  -- A FULL statement, like the two above: every id the host names is written
  -- true or false, so withdrawing the acceptance clears the row instead of
  -- leaving a mod forced past its range forever.
  if type(intents.forcedEngine) == "table" then
    local bucket = options.modsEngine
    if type(bucket) ~= "table" then bucket = {}; options.modsEngine = bucket end
    for id, on in pairs(intents.forcedEngine) do
      if type(id) == "string" and type(on) == "boolean" then
        local want = on or nil
        if bucket[id] ~= want then
          bucket[id] = want
          changed = true
        end
      end
    end
    if next(bucket) == nil then options.modsEngine = nil end
  end

  if changed then SaveData.saveOptions(options, fs) end
  return changed
end

-- Which mods register a world pipeline, and which one is actually drawing.
--
-- Two enabled mods can each register one -- DRAMATIC_SHAPE and its fork
-- TERRARIUM both do -- and the engine draws exactly ONE: worldPipeline takes
-- the first eligible in priority order, and applyOptions pins every other to
-- 0 on restore. Both register at priority 20, so the id breaks the tie and
-- the same one wins every boot. Neither fails, neither declares a conflict,
-- so without this the loser is reported installed, enabled and indisting-
-- uishable from a mod that is simply broken.
--
-- Ownership comes from the merge's `_owners` bookkeeping row, the same
-- provenance the audio registries use. Everything is pcall'd and an absent
-- answer just means no keys: a boot report is not worth crashing a launch
-- over, and callers already treat these as optional.
local function worldDrawers(data)
  local defs = type(data) == "table" and data.render_pipelines or nil
  if type(defs) ~= "table" then return {}, nil end
  local owners = type(defs._owners) == "table" and defs._owners or {}
  local drawers = {}
  for id, def in pairs(defs) do
    if id ~= "_owners" and type(def) == "table" and def.drawWorld and owners[id] then
      drawers[tostring(owners[id])] = true
    end
  end
  -- Asked rather than re-derived: the priority order, the eligibility rule
  -- and the level ladder are the engine's, and a second copy here would be
  -- one that could disagree with what the player is looking at.
  local active = nil
  local okRequire, Pipelines = pcall(require, "src.render.Pipelines")
  if okRequire and type(Pipelines) == "table" and Pipelines.worldPipeline then
    local okCall, id = pcall(Pipelines.worldPipeline)
    if okCall and id and owners[id] then active = tostring(owners[id]) end
  end
  return drawers, active
end

-- Snapshot the loaded mod set for the host's own manager UI. `loader` is
-- the ModLoader instance (Game.mods) and `data` the merged content table
-- (Game.data); tolerant of partial shapes so a future loader change degrades
-- to fewer fields, never a crash.
function HostSeam.writeModState(loader, fs, data)
  local mods = {}
  local list = loader and loader.mods
  if type(list) == "table" then
    for id, mod in pairs(list) do
      if type(mod) == "table" then
        local manifest = type(mod.manifest) == "table" and mod.manifest or {}
        mods[#mods + 1] = {
          id = tostring(id),
          version = tostring(manifest.version or ""),
          enabled = mod.enabled ~= false,
          state = tostring(mod.state or (mod.failed and "failed") or "loaded"),
          -- WHY it failed, so the host can show a reason instead of an
          -- unexplained "broken" chip the player can do nothing with.
          --
          -- `skipReason` as well as `failure`. The loader keeps two fields:
          -- a mod it could not load gets `failure`, a mod it deliberately
          -- left out (wrong generation, a dependency that does not run here)
          -- gets `skipReason`, and only the first was being written. So every
          -- "not for this game" row reached the host with no words at all and
          -- the pane printed a guess, where the engine had a sentence naming
          -- the game. The `state` beside it already says which kind it is.
          failure = (mod.failure or mod.skipReason)
            and tostring(mod.failure or mod.skipReason) or nil,
          -- Loaded, but outside the engine range its author declared, because
          -- the player accepted that. Reported so a row can say "running
          -- unverified" rather than a plain green "loaded" that hides the
          -- deal the player actually made. The host derives the OFFER from
          -- the manifest (it can read `game_version` without a boot); this
          -- reports what the last boot ACTUALLY did with it, which is the
          -- only place the two could disagree.
          forcedEngine = mod.forcedEngine == true or nil,
        }
      end
    end
  end
  -- Installs the loader REFUSED before they were ever mods (Loader:_discover
  -- keeps these in `rejected`). Without them the host sees no row at all for
  -- such an install and cannot tell "the engine has not booted yet" from "the
  -- engine looked at this and said no" -- which is how a mod with one bad
  -- manifest field reads as permanently pending.
  --
  -- `invalid` is the loader's own word for a manifest that failed validation,
  -- so a host already reading boot states needs no new vocabulary. `enabled`
  -- is true because the only interesting case is a mod the player asked for:
  -- the answer they gave is what makes the refusal worth saying out loud.
  local refused = loader and loader.rejected
  if type(refused) == "table" then
    for _, entry in ipairs(refused) do
      if type(entry) == "table" and entry.id then
        mods[#mods + 1] = {
          id = tostring(entry.id),
          version = "",
          enabled = true,
          state = "invalid",
          failure = entry.reason and tostring(entry.reason) or nil,
        }
      end
    end
  end
  -- Only stamped when true, so a boot that registered no mod pipelines writes
  -- exactly the bytes it always did and no reader has to learn a key to skip.
  local okDrawers, drawers, active = pcall(worldDrawers, data)
  if okDrawers and type(drawers) == "table" then
    for _, row in ipairs(mods) do
      if drawers[row.id] then row.drawsWorld = true end
      if active ~= nil and active == row.id then row.worldActive = true end
    end
  end
  table.sort(mods, function(a, b) return a.id < b.id end)
  local Version = require("src.core.Version")
  return writeJson(fs, "state.json", { engine = Version.engine, mods = mods })
end

-- ----------------------------------------------------------------- import

local lastStatusKey = nil

-- Mirror a running host-driven import into import_status.json. Cheap to
-- call every frame: writes only when the (phase, whole-percent) pair moves.
function HostSeam.pumpImportStatus(importer, fs)
  if type(importer) ~= "table" then return end
  local phase = importer.workState or "working"
  local percent = math.floor(math.max(0, math.min(1, importer.progress or 0)) * 100)
  local key = tostring(phase) .. ":" .. tostring(percent)
  if key == lastStatusKey then return end
  lastStatusKey = key
  writeJson(fs, "import_status.json", {
    phase = phase,
    percent = percent,
    status = importer.status,
    detail = importer.detail,
  })
end

function HostSeam.writeImportStatus(tbl, fs)
  lastStatusKey = nil
  return writeJson(fs, "import_status.json", tbl)
end

function HostSeam.clearImportStatus(fs)
  lastStatusKey = nil
  removeFile(fs, "import_status.json")
end

-- ------------------------------------------------------------- viewport
-- The embedding host can reserve a band at the BOTTOM of the window for its
-- own chrome (Phosphor floats its controller deck there in a native overlay
-- above SDL). Without this the game canvas fills the whole framebuffer and
-- the deck simply covers the lower third of the picture.
--
-- Session state rather than a saved option: it describes how THIS launch is
-- being presented, not something the player chose, and a later launch
-- without the deck must not inherit it.
local viewportBottomInset = 0

-- `viewportBottomInset` is in LOVE units (points), matching
-- love.graphics.getDimensions. Absent or malformed leaves it at 0, so a
-- host that says nothing gets the full window exactly as before.
function HostSeam.applyLaunchViewport(launch)
  if type(launch) ~= "table" then return false end
  local inset = tonumber(launch.viewportBottomInset)
  if not inset or inset <= 0 then return false end
  viewportBottomInset = inset
  return true
end

function HostSeam.viewportBottomInset()
  return viewportBottomInset
end

-- Runtime update, for a host whose chrome changes size mid-session (a
-- rotation re-lays-out the deck, and a landscape deck reserves nothing at
-- all because the picture pillarboxes instead). The boot directive cannot
-- express that: it is read once.
function HostSeam.setViewportBottomInset(v)
  local inset = tonumber(v)
  if not inset or inset < 0 then return false end
  viewportBottomInset = inset
  return true
end

return HostSeam
