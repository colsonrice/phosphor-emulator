-- Native LÖVE2D port of Pokemon Red. A packaged build creates its private
-- game-data cache from a user-provided ROM on first boot.
--
-- The save editor (tools/save-editor/) ships inside every build and is
-- reachable two ways:
--   * standalone: POKEPORT_EDITOR=1 or `love . --editor`, its own window
--   * from the launcher: Edit on a save row, which suspends the launcher,
--     opens the editor on that slot's file, and restores the launcher when
--     the editor's Close button is pressed (openEditor / closeEditor below)

if POKEPORT_DISPLAY_COMPANION then
  return require("src.render.DesktopCompanion").install(
    POKEPORT_DISPLAY_COMPANION)
end

local editorMode = os.getenv("POKEPORT_EDITOR") == "1" or POKEPORT_EDITOR_MODE == true

local SwitchDiagnostics = require("src.debug.SwitchDiagnostics")
local LaunchOptions = require("src.core.LaunchOptions")
local NxDisplay = require("src.core.NxDisplay")
local PlatformHooks = require("src.core.PlatformHooks")
local HostDisplay = require("src.core.HostDisplay")
local GameViewport = require("src.render.GameViewport")

-- Global emergency quit: holding Start + Select for 5 seconds forcefully terminates LOVE.
local emergencyQuitTimer = 0

local function checkEmergencyQuit(dt)
  local held = false
  if love.joystick and love.joystick.getJoysticks then
    local joysticks = love.joystick.getJoysticks()
    for _, j in ipairs(joysticks) do
      if j:isGamepad() then
        local start = j:isGamepadDown("start")
        local selectBtn = j:isGamepadDown("back") or j:isGamepadDown("guide")
        if start and selectBtn then
          held = true
          break
        end
      else
        local bCount = j:getButtonCount()
        local s1 = (bCount >= 7 and j:isDown(7)) or (bCount >= 9 and j:isDown(9))
        local s2 = (bCount >= 8 and j:isDown(8)) or (bCount >= 10 and j:isDown(10))
        if s1 and s2 then
          held = true
          break
        end
      end
    end
  end

  if love.keyboard and love.keyboard.isDown then
    if (love.keyboard.isDown("escape") and love.keyboard.isDown("return"))
        or (love.keyboard.isDown("lalt") and love.keyboard.isDown("f4")) then
      held = true
    end
  end

  if held then
    emergencyQuitTimer = emergencyQuitTimer + (dt or 0.016)
    if emergencyQuitTimer >= 5.0 then
      print("[FORCE QUIT] Start + Select held for 5 seconds. Exiting forcefully.")
      pcall(function()
        if love.audio and love.audio.stop then love.audio.stop() end
        if love.window and love.window.close then love.window.close() end
      end)
      local exitFn = os["exit"]
      exitFn(0)
    end
  else
    emergencyQuitTimer = 0
  end
end

-- Lua errors: persist a redacted trace in the save dir and surface a hint.
do
  local defaultErrorHandler = love.errorhandler or love.errhand
  function love.errorhandler(msg)
    local ok, hint = pcall(SwitchDiagnostics.logLuaError, msg)
    if ok and hint and type(msg) == "string" then
      msg = msg .. "\n\n" .. hint
    end

    -- PHOSPHOR OVERLAY. 0.2.27 added the screen below, and it must not run
    -- when this LOVE is embedded in a host app.
    --
    -- An error screen is a FRAME LOOP: love.errorhandler returns a per-frame
    -- function and boot.lua installs it as the new `func`, so the boot
    -- coroutine yields forever. Standalone a human presses escape. Embedded,
    -- LoveHost.isRunning never goes false, RecompSession.canStart reads that
    -- process-wide flag, and ONE crash refuses every later launch on every
    -- engine until the app is force quit. That was a real device report
    -- ("if Silver crashes once, no other games will work") and the host's own
    -- handler is the fix: it records the message and returns NOTHING, so
    -- boot.lua retires the loop and the coroutine finishes cleanly.
    --
    -- Falling through to defaultErrorHandler below IS that host handler when
    -- embedded, so the whole port is this one condition.
    if not (love._phosphorEmbedded)
        and love.window and love.window.isOpen and love.window.isOpen() and love.graphics and love.graphics.isActive() then
      local fullMsg = tostring(msg) .. "\n\n" .. tostring(debug.traceback()) .. "\n\n[Hold START + SELECT for 5s to Force Quit]"
      return function()
        love.event.pump()
        for e, a in love.event.poll() do
          if e == "quit" or (e == "keypressed" and a == "escape") then
            return 1
          elseif e == "gamepadpressed" and (a == "start" or a == "back") then
            return 1
          end
        end
        checkEmergencyQuit(0.016)
        love.graphics.origin()
        love.graphics.clear(0.10, 0.10, 0.12)
        love.graphics.setColor(1, 0.4, 0.4, 1)
        love.graphics.printf(fullMsg, 20, 20, love.graphics.getWidth() - 40)
        love.graphics.present()
        love.timer.sleep(0.016)
      end
    end

    if defaultErrorHandler then
      return defaultErrorHandler(msg)
    end
  end
  love.errhand = love.errorhandler
end

local Game, EditorApp, Importer, TouchEditor, Studio

-- #887: quit-to-launcher state, shared by love.load and love.quit (both need
-- it, so it is declared here rather than next to love.quit).
--   * launchedIntoGame -- a --game / POKEPORT_GAME shortcut booted this
--     session straight into a game, so there is no launcher behind it and a
--     window close must exit.  Restarting instead re-read the same shortcut
--     and came right back into the game, and the next close did it again:
--     the app could not be closed at all (macOS feels this worst, where the
--     red X, Cmd+Q and the Dock's Quit are all the same quit event).
--   * RELAUNCH_MARKER -- written in the save dir just before the #785
--     restart, so the fresh boot ignores any boot-straight-into-a-game
--     option exactly once and keeps #785's promise of landing in the
--     launcher, whatever put the game on screen this time.
local launchedIntoGame = false
local RELAUNCH_MARKER = "relaunch_to_launcher.txt"

local autopilot -- optional scripted-input dev tool (tests/autopilot.lua)
local driverCo  -- optional frame-driver (POKEPORT_DRIVER=file.lua): a
                -- coroutine that receives `Game` and yields once per
                -- frame; used headless (xvfb) for scripted screenshots

-- --speed N / POKEPORT_SPEED=N: run the logic clock N times faster without
-- touching audio (src/core/GameSpeed.lua).  Overrides the saved option so a
-- bot or screenshot run is not at the mercy of the player's last choice.
local speedOverride = tonumber(os.getenv("POKEPORT_SPEED"))

-- POKEPORT_TOUCH=1 forces the mobile on-screen controls on and lets the
-- mouse stand in for a finger, so the overlay can be exercised on desktop
-- (see src/core/TouchControls.lua).
local mouseTouch = os.getenv("POKEPORT_TOUCH") == "1"

-- How many times to run a scripted act+step loop per rendered frame.  Only
-- scripted runs use this; interactive play fast-forwards through
-- Game.speedOverride / the GAME SPEED option instead.
local function scriptedIterations()
  if not (autopilot or driverCo) then return 1 end
  return math.max(1, math.floor(require("src.core.GameSpeed").clamp(speedOverride)))
end

-- ------------------------------------------------------------ save editor
-- The launcher instance parked while the editor is up, plus the version whose
-- cache the editor mounted (so closing can put the read path back).
local editorHost, editorVersion, editorWindow
local closeEditor  -- forward declaration: openEditor hands it to the editor

-- Drop CacheFs / Data / mod Runtime / Assets / LegacyCompat for one mounted
-- version session (save editor or game).  closeEditor and returnToLauncher
-- both go through SessionLifecycle so neither path forgets a singleton.
local SessionLifecycle = require("src.core.SessionLifecycle")

-- The editor's modules use flat names (require("Kit"), require("Party")), so
-- their directories have to be on the require path.  It must be
-- love.filesystem's path, not package.path: in a packaged build these files
-- live inside the .love archive, which the stock Lua searcher cannot open.
local function addEditorRequirePath()
  local fs = love.filesystem
  if not (fs.setRequirePath and fs.getRequirePath) then
    -- very old LOVE: a source checkout still resolves through package.path
    package.path = fs.getSource() .. "/tools/save-editor/?.lua;"
                .. fs.getSource() .. "/tools/save-editor/panels/?.lua;"
                .. package.path
    return
  end
  local current = fs.getRequirePath()
  if current:find("tools/save%-editor") then return end
  fs.setRequirePath("tools/save-editor/?.lua;tools/save-editor/panels/?.lua;"
    .. current)
end

-- Desktop only: the launcher window (1024x768) is tighter than the editor's
-- design size, so grow it while editing and put it back on Close.  Never
-- shrinks, never touches a fullscreen or mobile window.
local function resizeForEditor()
  if not (love.window and love.window.getMode and love.window.setMode) then return end
  local osName = love.system.getOS()
  if osName ~= "OS X" and osName ~= "Windows" and osName ~= "Linux" then return end
  local w, h, flags = love.window.getMode()
  if flags.fullscreen then return end
  local dw, dh = love.window.getDesktopDimensions()
  local wantW = math.max(w, math.min(1360, math.floor((dw or w) * 0.92)))
  local wantH = math.max(h, math.min(860, math.floor((dh or h) * 0.88)))
  if wantW <= w and wantH <= h then return end
  editorWindow = { w = w, h = h }
  love.window.setMode(wantW, wantH, flags)
end

local function restoreWindow()
  if not editorWindow then return end
  local _, _, flags = love.window.getMode()
  love.window.setMode(editorWindow.w, editorWindow.h, flags)
  editorWindow = nil
end

-- Open the editor on a launcher save row.  The version's cache has to be
-- mounted before the editor's Data:load runs, or a Blue save would be edited
-- against Red's species/item tables.
local function openEditor(version, slotId)
  local function refuse(text)
    if not Importer then return end
    Importer.saveNotice = Importer.saveNotice or {}
    Importer.saveNotice[version] = { ok = false, text = text }
  end
  local SaveData = require("src.core.SaveData")
  local path = SaveData.slotDiskPath(version, slotId)
  if not path then
    refuse("Could not resolve that save slot on disk.")
    return
  end
  local GameVersion = require("src.core.GameVersion")
  GameVersion.set(version)
  require("src.import.CacheFs").mountVersion(version)
  editorVersion = version
  editorHost = Importer
  -- Drop launcher pad/FlexLove so the save editor owns input (NX shim +
  -- virtual cursor + system hand cursor). Desktop park is a light no-op.
  if Importer and Importer.prepareOverlayHandoff then
    Importer:prepareOverlayHandoff()
  end
  Importer = nil
  editorMode = true
  resizeForEditor()
  addEditorRequirePath()
  local okReq, appOrErr = pcall(require, "App")
  if not okReq then
    editorMode = false
    SessionLifecycle.endEditorSession({ version = version, app = nil })
    restoreWindow()
    Importer = editorHost
    editorHost = nil
    editorVersion = nil
    if Importer and Importer.resumeAfterOverlay then
      Importer:resumeAfterOverlay()
    end
    refuse("Could not open the save editor (" .. tostring(appOrErr) .. ").")
    return
  end
  EditorApp = appOrErr
  local okLoad, loadErr = pcall(EditorApp.load, path, {
    version = version, slotId = slotId, embedded = true,
    onClose = function() closeEditor() end,
  })
  if not okLoad then
    editorMode = false
    if EditorApp.unload then pcall(EditorApp.unload) end
    EditorApp = nil
    SessionLifecycle.endEditorSession({ version = version, app = nil })
    restoreWindow()
    Importer = editorHost
    editorHost = nil
    editorVersion = nil
    if Importer and Importer.resumeAfterOverlay then
      Importer:resumeAfterOverlay()
    end
    refuse("Could not open the save editor (" .. tostring(loadErr) .. ").")
  end
end

-- Back to the launcher.  Everything the editor mounted or cached has to come
-- back out: the version overlay (CacheFs) and the generated modules require
-- cached behind it (Data), or pressing Play on the OTHER game would boot it
-- with this one's data.  Also reset Runtime / Assets / LegacyCompat so the
-- next Edit or Play does not inherit the editor's dead mod loader.
function closeEditor()
  local version = editorVersion
  local app = EditorApp
  editorMode = false
  EditorApp = nil
  SessionLifecycle.endEditorSession({ version = version, app = app })
  editorVersion = nil
  restoreWindow()
  Importer = editorHost
  editorHost = nil
  if Importer and Importer.resumeAfterOverlay then
    Importer:resumeAfterOverlay()
  end
  if Importer and version and Importer.savesChanged then
    Importer:savesChanged(version)
  end
end

-- ------------------------------------------------------------ touch controls editor
-- Suspends the launcher while the player drags on-screen buttons / toggles
-- the overlay off (#327).  No ROM cache needed -- options.lua only.
local touchEditorHost
local closeTouchControlsEditor  -- forward declaration
-- True while a host-launch import runs; love.update mirrors the importer's
-- progress into host/import_status.json for the embedding host's own UI.
local hostImportActive = false
-- Throttle for the host's runtime command poll (save/load/speed from the
-- embedding app's chrome). 0.25s keeps it a directory stat, not a hot path.
local hostCommandTimer = 0

-- The game's own START -> SAVE never passes through the host; this is how
-- it still gets its picture (spec §3.6). See HostSeam.newSlotWatcher.
local slotWatcher = nil

local function pollHostCommands(dt)
  hostCommandTimer = hostCommandTimer + dt
  if hostCommandTimer < 0.25 then return end
  hostCommandTimer = 0
  local HostSeam = require("src.core.HostSeam")
  if Game then
    local GameVersion = require("src.core.GameVersion")
    local SaveData = require("src.core.SaveData")
    slotWatcher = slotWatcher or HostSeam.newSlotWatcher(love.filesystem.getInfo)
    local version = GameVersion.get()
    local changed = slotWatcher.check(version, SaveData.activeSlot(version))
    if changed then HostSeam.requestSlotPicture(version, changed) end
  end
  local cmd = HostSeam.pollCommand()
  if not (cmd and Game) then return end

  -- A host command must never take the game down: the host is not a
  -- keyboard, and there is no player standing at an error screen they
  -- asked for.  Every branch runs under pcall and reports a reason.
  local function report(ok, err, extra)
    -- built stepwise: `ok and nil or tostring(err)` is the and-or trap --
    -- a nil middle operand falls through, so SUCCESS carried error="nil"
    local result = { seq = cmd.seq, cmd = cmd.cmd, ok = ok and true or false }
    if not ok then result.error = tostring(err) end
    for k, v in pairs(extra or {}) do result[k] = v end
    HostSeam.writeCommandResult(result)
  end

  local GameVersion = require("src.core.GameVersion")
  local SaveData = require("src.core.SaveData")
  -- Every question about the live game goes through one shape, whichever
  -- generation booted (HostSeam.session): Gold and Silver are Game2, which
  -- has neither `overworld` nor `restoreSave`.
  local session = HostSeam.session(Game, GameVersion.generation())
  local version = GameVersion.get()

  -- Saving reaches into the live world (captureSave indexes its map), so it
  -- is only meaningful once a game is actually running; on the title screen
  -- it is a nil index, i.e. a crash.
  local function inGame() return session.inWorld() end

  if cmd.cmd == "save" then
    if not inGame() then
      report(false, "Start or continue a game before saving.")
      return
    end
    if cmd.text == "engine" then
      -- The engine-world half only: its own slot, no cartridge export. For a
      -- game the engine cannot export (Gold, Silver: SaveConvert has no Gen 2
      -- codec) this is what the host's Save tile and exit send, so a session
      -- that never pressed the game's own SAVE still keeps its progress.
      local ok, err = pcall(function()
        if not session.writeSave() then error("the engine declined to save", 0) end
      end)
      -- The picture of this save, and only if it happened: asked for here,
      -- before this frame draws (love.update asks again right after this
      -- poll), drained into saves/<version>/<slot>.png a frame later. A
      -- refused save that still wrote a new picture put a fresh screenshot
      -- beside an unchanged timestamp.
      if ok then HostSeam.requestSlotPicture(version, SaveData.activeSlot(version)) end
      report(ok, err, { slot = SaveData.activeSlot(version) })
      return
    end
    local ok, err = pcall(function()
      -- The engine's own save first (its slot/save.lua silo), then a raw
      -- 32768-byte SRAM image for the HOST's library, so a 3D session and
      -- the host's own emulator read the same battery save.
      --
      -- Checked, like the engine-only branch above: writeSave() returns
      -- false when a mod vetoes save.write, and exportSav works off the
      -- in-memory table, so it would still succeed and report ok -- a
      -- picture beside a save that never moved, and a library .sav written
      -- from a slot the engine declined to write.
      if not session.writeSave() then error("the engine declined to save", 0) end
      local SaveConvert = require("src.save_convert.SaveConvert")
      -- The host stages its current library .sav as the export's fallback
      -- template: a playthrough started as a New Game in 3D has no
      -- rawImport, and a template-less export zero-fills the unmodeled
      -- machine regions -- accepted by every checksum, fatal to the real
      -- cartridge on Continue. Consumed per save so a stale copy can never
      -- outlive the library save it mirrored.
      local template = love.filesystem.read("host/export_template.sav")
      love.filesystem.remove("host/export_template.sav")
      -- The staged base cartridge: exportSav derives the map-header cache
      -- from it for the save's position, so Continue on the vanilla game
      -- never runs a stale template's script pointer in the wrong bank.
      -- picked_rom.gb exists until the importer consumes it; the host
      -- refreshes baseroms/baserom.gb every launch as the durable copy.
      local rom = love.filesystem.read("picked_rom.gb")
                  or love.filesystem.read("baseroms/baserom.gb")
      local bytes, cerr = SaveConvert.exportSav(Game.save, version, template, rom)
      if not bytes then error(tostring(cerr), 0) end
      love.filesystem.createDirectory("host")
      local wrote, werr = love.filesystem.write("host/export_save.sav", bytes)
      if not wrote then error(tostring(werr), 0) end
      -- The bag and PC the cartridge could not hold. A Game Boy bag has 20
      -- slots and the PC 50, mods routinely grant hundreds, and the host's
      -- iCloud sync carries nothing but this .sav -- so without the sidecar
      -- every device hop silently truncated the bag to its first 20 rows,
      -- which is exactly the TMs and HMs (Bag.order sorts machine items last).
      -- Stamped with this export's own fingerprint so it can never speak for
      -- a different cartridge; written or cleared every time, so the host can
      -- never pick up one belonging to the save before this one.
      local SaveExtras = require("src.save_convert.SaveExtras")
      local extras = SaveExtras.capture(Game.save, SaveExtras.stamp(bytes))
      if extras then
        love.filesystem.write(SaveExtras.EXPORT_PATH, extras)
      else
        love.filesystem.remove(SaveExtras.EXPORT_PATH)
      end
    end)
    -- Same rule as the engine-only branch above: a picture for a save that
    -- happened. `session.writeSave()` runs first inside that pcall, so a
    -- failure past it (the export) leaves a written slot with no fresh
    -- picture, which is the honest pairing -- the export is the half that
    -- did not happen.
    if ok then HostSeam.requestSlotPicture(version, SaveData.activeSlot(version)) end
    report(ok, err, { slot = SaveData.activeSlot(version) })

  elseif cmd.cmd == "load" then
    local ok, err = pcall(function()
      -- A host-supplied battery save wins: that is the host's library copy,
      -- which the player expects to be the source of truth.
      local raw = love.filesystem.read("host/import_save.sav")
      if raw then
        love.filesystem.remove("host/import_save.sav")
        -- The bag and PC rows that did not fit in those 32768 bytes, read and
        -- cleared together with the save they belong to: a sidecar left lying
        -- in host/ would be offered to the NEXT import, and its stamp would
        -- refuse it, but only after it had already outlived its own save.
        local SaveExtras = require("src.save_convert.SaveExtras")
        local extras = love.filesystem.read(SaveExtras.IMPORT_PATH)
        love.filesystem.remove(SaveExtras.IMPORT_PATH)
        -- The launcher's import path is the whole contract: size + checksum
        -- validation, the meta re-stamp (SaveConvert leaves format =
        -- "gen1_import", which SaveData's migration pass compares
        -- NUMERICALLY -- restoring the raw table crashed there), and a
        -- persisted, activated slot, so the import survives the next boot
        -- instead of living only in this session's memory.
        local SaveFileIO = require("src.import.SaveFileIO")
        -- force: upstream returns (false, nil, {needsConfirm}) for a save
        -- LARGER than 32768 bytes whose main-data checksum is valid -- a cart
        -- save with an emulator RTC footer -- so the launcher can ask before
        -- truncating. The seam has no one to ask, and the host's library copy
        -- is the source of truth, so take it and drop the footer.
        local okImport, slotOrErr = SaveFileIO.importToSlot(raw, version, true, extras)
        if not okImport then error(tostring(slotOrErr), 0) end
      end
      -- With nothing staged this is CONTINUE of the active slot: the same
      -- read and the same entry the title screen makes.
      local loaded, recovered = session.readSlot(version)
      if not loaded then error("no save to load", 0) end
      session.enterWorld(loaded, recovered)
    end)
    -- The slot the load created or entered: the host keys its import ledger
    -- on it, and command_result carried only {seq, cmd, ok, error} before.
    report(ok, err, { slot = SaveData.activeSlot(version) })

  elseif cmd.cmd == "slot" and type(cmd.text) == "string" then
    -- Make a registered slot the active one and enter its world. Ids, never
    -- list indices: the same id the registry and the boot directive use.
    local ok, err = pcall(function()
      local found = false
      for _, s in ipairs(SaveData.listSlots(version)) do
        if s.id == cmd.text then found = true break end
      end
      if not found then error("no 3D save with that id", 0) end
      SaveData.setActiveSlot(version, cmd.text)
      local loaded, recovered = session.readSlot(version)
      if not loaded then error("that 3D save is empty", 0) end
      session.enterWorld(loaded, recovered)
    end)
    report(ok, err, { slot = SaveData.activeSlot(version) })

  elseif cmd.cmd == "deleteslot" and type(cmd.text) == "string" then
    local ok, err = pcall(function()
      local found = false
      for _, s in ipairs(SaveData.listSlots(version)) do
        if s.id == cmd.text then found = true break end
      end
      if not found then error("no 3D save with that id", 0) end
      SaveData.deleteSlot(version, cmd.text)
    end)
    report(ok, err, { slot = SaveData.activeSlot(version) })

  elseif cmd.cmd == "restart" then
    -- Back to the title like a power cycle: the START menu's QUIT.
    local ok, err = pcall(function() session.returnToTitle() end)
    report(ok, err)

  elseif cmd.cmd == "status" then
    -- Where the engine is, for the host and the boot probe: in the world,
    -- and whether the world is what is on top (a title pushed back over it
    -- after a continue would be the thing the directive exists to prevent).
    report(true, nil, { inWorld = session.inWorld() and true or false,
                        topIsWorld = session.topIsWorld() and true or false,
                        slot = SaveData.activeSlot(version) })
  elseif cmd.cmd == "viewport" and type(cmd.value) == "number" then
    -- The host's chrome changed size (rotation). Purely presentational, so
    -- no report(): the renderer picks it up on the next frame.
    HostSeam.setViewportBottomInset(cmd.value)

  elseif cmd.cmd == "speed" and type(cmd.value) == "number" then
    -- The options row's own semantics: options.speed is read live every
    -- frame (Game reads it through GameSpeed.clamp), so setting + saving
    -- takes effect immediately and survives the next boot.
    local opts = Game.save and Game.save.options
    if opts then
      opts.speed = require("src.core.GameSpeed").clamp(cmd.value)
      require("src.core.SaveData").saveOptions(opts)
    end

  elseif cmd.cmd == "touchcontrols" and type(cmd.value) == "number" then
    -- launch.touchControls says the same thing, but it is read once at boot
    -- (HostSeam.applyLaunchPrefs). A host that can swap its OWN controls in
    -- and out mid-session needs to hand the touch pad back the same way,
    -- without making the player relaunch the game to get it.
    local ok, err = pcall(function()
      local opts = Game.save and Game.save.options
      if not opts then error("options not loaded yet", 0) end
      local tc = opts.touchControls
      if type(tc) ~= "table" then
        tc = {}
        opts.touchControls = tc
      end
      tc.enabled = cmd.value ~= 0
      require("src.core.SaveData").saveOptions(opts)
      -- Same call the launcher's editor makes after a save: without it the
      -- option is stored but the live pad keeps its old state.
      if Game.touchControls and Game.touchControls.applyOptions then
        Game.touchControls:applyOptions(opts)
      end
    end)
    report(ok, err)
  end
end

-- `version` is the launcher tab the gear was opened on, and it decides which
-- option block the layout lands in (src/ui/TouchControlsEditor.lua persist).
local function openTouchControlsEditor(version)
  touchEditorHost = Importer
  if Importer and Importer.prepareOverlayHandoff then
    Importer:prepareOverlayHandoff()
  end
  Importer = nil
  TouchEditor = require("src.ui.TouchControlsEditor")
  TouchEditor.load({
    version = version,
    onClose = function() closeTouchControlsEditor() end,
  })
end

function closeTouchControlsEditor()
  if TouchEditor and TouchEditor.unload then TouchEditor.unload() end
  TouchEditor = nil
  Importer = touchEditorHost
  touchEditorHost = nil
  if Importer and Importer.resumeAfterOverlay then
    Importer:resumeAfterOverlay()
  end
end

-- ------------------------------------------------------------ skin studio
local studioHost
local closeSkinStudio
local bootGame

local function openSkinStudio(version, skinId)
  local SkinStudio = require("src.ui.SkinStudio")
  if not SkinStudio.available_desktop() then return end
  studioHost = Importer
  if Importer and Importer.prepareOverlayHandoff then
    Importer:prepareOverlayHandoff()
  end
  Importer = nil
  Studio = SkinStudio
  Studio.load({
    version = version,
    skinId = skinId,
    onClose = function() closeSkinStudio() end,
    onPlay = function(v)
      closeSkinStudio()
      Importer = nil
      bootGame(v or version)
    end,
  })
end

function closeSkinStudio()
  if Studio and Studio.unload then Studio.unload() end
  Studio = nil
  Importer = studioHost
  studioHost = nil
  if Importer and Importer.resumeAfterOverlay then
    Importer:resumeAfterOverlay()
  end
end

local function makeLauncher()
  local RomImporter = require("src.import.RomImporter")
  local forceImport = os.getenv("POKEPORT_FORCE_IMPORT") == "1"
  return RomImporter.new(function(version, cartId)
    Importer = nil
    bootGame(version, cartId)
  end, {
    launcher = true,
    forceImport = forceImport,
    onEditSave = openEditor,
    onEditTouchControls = openTouchControlsEditor,
    -- Skin Studio owns a touch-first layout as well as the desktop workspace.
    -- Keep the compatibility predicate so external hosts using it still work.
    onOpenSkinStudio = require("src.ui.SkinStudio").available_desktop()
      and openSkinStudio or nil,
  })
end

local function returnToLauncher()
  if not Game then return end

  local GameVersion = require("src.core.GameVersion")
  local currentVersion = GameVersion.get()
  SessionLifecycle.endGameSession(Game)
  Game = nil
  autopilot = nil
  driverCo = nil
  -- Leave the cart's scope behind: the launcher's own settings and slots are
  -- the base game's, not the cart's.  The speed ladder is cart state too, so
  -- a 1x/2x cart must not pin the launcher or the next game.
  require("src.core.SaveData").setCart(nil)
  require("src.core.GameSpeed").setAllowed(nil)

  SessionLifecycle.endMountedSession(currentVersion)

  require("src.core.Orientation").applyOptions(
    require("src.core.SaveData").loadOptions())

  local preload = require("src.mods.LauncherMods").translationStrings()
  if preload then require("src.core.Strings").load({ strings = preload }) end

  if love.window and love.window.setTitle then
    local Version = require("src.core.Version")
    love.window.setTitle(Version.title("Gen 1 Recompilation Project"))
  end

  Importer = makeLauncher()
end

function bootGame(version, cartId)
  -- The launcher hands us the chosen game (Red / Blue / Yellow / Gold);
  -- scripted and headless runs fall back to POKEPORT_VERSION, then Red.
  -- Set the active version and overlay its extracted cache BEFORE anything
  -- requires generated data, so data/generated + assets/generated resolve
  -- to that version's files.
  local GameVersion = require("src.core.GameVersion")
  GameVersion.set(version or os.getenv("POKEPORT_VERSION") or "red")
  local CacheFs = require("src.import.CacheFs")
  -- Keep CacheFs.prefix aligned for any CacheFs.read fallback during Data:load
  -- (Blue/Yellow/Gold caches live under blue/ / yellow/ / gold/).
  CacheFs.prefix = GameVersion.cachePrefix()
  CacheFs.mountVersion(GameVersion.get())
  local cartHash, cartSpeeds, cartOptions
  if cartId then
    local ok, cart, hash = pcall(function()
      return require("src.carts.CartStore").get(cartId)
    end)
    if ok and cart then
      cartHash, cartSpeeds, cartOptions = hash, cart.speeds, cart.options
    else
      cartId = nil
    end
  end
  local SaveData = require("src.core.SaveData")
  SaveData.setCart(cartId, cartHash)
  -- The author's settings land in the cart's own scope the first time only;
  -- after that the player owns them.
  if cartOptions then SaveData.seedCartOptions(cartOptions) end
  -- A cart may narrow or pin the speed ladder; nil restores the full one.
  require("src.core.GameSpeed").setAllowed(cartSpeeds)
  if cartId then SaveData.adoptCartSeal(cartId) end
  -- NX: always write nx-asset-probe.log so Yellow/Blue art failures are
  -- diagnosable from the SD without enabling switch-debug.txt.
  pcall(function()
    require("src.debug.SwitchDiagnostics").probeAssets(GameVersion.get())
  end)
  if love.window and love.window.setTitle then
    local Version = require("src.core.Version")
    love.window.setTitle(Version.title(
      GameVersion.info().displayName .. " (Gen 1 Recompilation Project)"))
  end
  -- Gen 2: Gen 1 Game:load cannot consume a Gen 2 cache -- different generated
  -- tables, save shape and screen registry -- so Gold and Silver boot their
  -- own service owner, which mounts src/world/gen2 (walk / warps /
  -- connections) and the Gen 2 screens instead of src/core/Game.lua's Gen 1
  -- wiring.
  if GameVersion.generation() == 2 then
    Game = require("src.core.Game2").new()
    Game:load()
  else
    -- Gen1 Game is a module singleton.  Always re-require after in-process
    -- EXIT GAME so a prior session cannot leave a table whose rawget(load)
    -- is nil (release Android: bootGame then dies with load-a-nil-value).
    -- rawget: type(mod.load) can lie via __index and skip a rebuild.
    package.loaded["src.core.Game"] = nil
    local gameMod = require("src.core.Game")
    if type(rawget(gameMod, "load")) ~= "function" then
      error("src.core.Game missing load after reload")
    end
    Game = gameMod
    Game:load()
    if os.getenv("POKEPORT_AUTOPILOT") then
      autopilot = require("tests.autopilot")
    end
  end
  -- Embedding hosts read the loaded mod set from host/state.json (a no-op
  -- write when love.filesystem is absent; see src/core/HostSeam.lua).
  -- Written for BOTH generations: Game2 keeps the same `mods` loader field,
  -- and the host's mod chips are not Gen 1-specific.
  -- Game.data as well as the loader: the merged content table is where the
  -- render_pipeline records and their `_owners` live, and it is what lets the
  -- report say which of two world-drawing mods is the one being drawn.
  require("src.core.HostSeam").writeModState(Game.mods, nil, Game.data)
  local driverPath = os.getenv("POKEPORT_DRIVER")
  if driverPath then
    local fn = assert(loadfile(driverPath))()
    driverCo = coroutine.create(fn)
  end
  -- After the two above are known: a scripted run drives the multiplier
  -- from love.update's loop, so the in-engine one must stay at 1 or the
  -- two would compound (10x10 = 100 steps per observation).
  Game.speedOverride = (autopilot or driverCo) and 1 or speedOverride
end

function love.load(args)
  -- Before anything can shell out (update check, mod index, ROM picker),
  -- claim one hidden console on Windows so those children inherit it instead
  -- of each flashing their own cmd.exe window (#606).  No-op elsewhere.
  require("src.core.HostShell").hideHostConsole()

  -- Hang gen1tls on love.system before mods boot.  Android already has tls*
  -- from JNI; this is the desktop half.  No DLL / no FFI is fine -- ws://
  -- rooms still work, wss:// just won't.
  pcall(function() require("src.net.Gen1Tls").install() end)

  -- NX fused mounts are unreliable for the blue|yellow cache overlay: wrap
  -- the love loaders once so every generated-asset read falls back to the
  -- versioned save-dir copy.  Never installed on desktop/Android/iOS.
  if require("src.core.Platform").isNX() then
    require("src.core.NxAssetOverlay").install()
  end

  -- Self-updater boot shell: a fused build may mount and chainload a newer
  -- downloaded payload here.  True means it took over, so we must stop.  A
  -- dev / source checkout no-ops (see src/update/Boot.lua).
  local Boot = require("src.update.Boot")
  if Boot.run(args) then return end

  -- Embedding-host contract (see src/core/HostSeam.lua). Both calls no-op
  -- when the host/ files are absent, which is every standalone install.
  local HostSeam = require("src.core.HostSeam")
  -- The island-frame snapshot rides upstream's display-lifecycle seam. Inert
  -- until a host launch directive asks for it (HostSeam.applyLaunchCapture),
  -- so a standalone run installs a backend that does nothing at all.
  HostDisplay.setBackend(HostSeam.displayBackend)
  HostSeam.applyModIntents()
  local hostLaunch = HostSeam.consumeLaunch()

  local savePath
  for i, a in ipairs(args or {}) do
    if a == "--editor" then
      editorMode = true
    elseif a == "--developer" then
      _G.POKEPORT_DEV_MODE = true
    elseif a == "--save" and args[i + 1] and args[i + 1] ~= "" then
      savePath = args[i + 1]
    elseif a == "--speed" and tonumber(args[i + 1]) then
      speedOverride = tonumber(args[i + 1])
    end
  end
  love.graphics.setDefaultFilter("nearest", "nearest")
  -- NX: handheld 720p / docked 1080p. Runs for every boot path (launcher,
  -- editor, scripted); no-op on desktop/mobile.
  NxDisplay.sync()

  -- Apply the persisted Android orientation lock (#592) before the launcher
  -- shows: SDL created the window with no orientation hint, so without this
  -- the launcher would rotate freely until options are applied at boot.
  -- No-op on desktop / iOS / when options.lua does not exist yet.
  require("src.core.Orientation").applyOptions(
    require("src.core.SaveData").loadOptions())

  -- Standalone editor.  A bare `--editor` run has no launcher behind it, so
  -- Close quits; --save points it at a specific file, otherwise it opens the
  -- default save path for POKEPORT_VERSION (Red unless overridden), whose
  -- cache has to be mounted before the editor's Data:load.
  if editorMode then
    local version = os.getenv("POKEPORT_VERSION") or "red"
    require("src.core.GameVersion").set(version)
    require("src.import.CacheFs").mountVersion(version)
    addEditorRequirePath()
    EditorApp = require("App")
    EditorApp.load(savePath, { version = version })
    return
  end

  local RomImporter = require("src.import.RomImporter")
  local forceImport = os.getenv("POKEPORT_FORCE_IMPORT") == "1"
  local importPath = os.getenv("POKEPORT_IMPORT_ROM")
  -- Scripted / headless runs pick their game from POKEPORT_VERSION, then
  -- POKEPORT_GAME / --game= (LaunchOptions), then Red.  Drivers for Gold
  -- must honor POKEPORT_GAME=gold the same way a desktop shortcut does.
  local scriptedVersion = os.getenv("POKEPORT_VERSION")
    or LaunchOptions.resolve(arg)
    or "red"
  local ready = RomImporter.isReady(scriptedVersion)
  -- Scripted / headless runs have to reach the game with no human pressing
  -- Play: an autopilot, a frame driver, an import-only build step, or an
  -- explicit ROM path all bypass the interactive launcher and keep today's
  -- import-then-boot (or boot-straight-in) behavior.
  local scripted = os.getenv("POKEPORT_AUTOPILOT") or os.getenv("POKEPORT_DRIVER")
    or os.getenv("POKEPORT_IMPORT_ONLY") == "1" or importPath ~= nil

  if scripted then
    if forceImport or not ready then
      -- The importer detects the dropped/loaded ROM's version by SHA-1 and
      -- passes it to onComplete; boot that version.
      Importer = RomImporter.new(function(version)
        if os.getenv("POKEPORT_IMPORT_ONLY") == "1" then
          love.event.quit()
          return
        end
        Importer = nil
        bootGame(version or scriptedVersion)
      end)
      if importPath then Importer:startPath(importPath) end
      return
    end
    bootGame(scriptedVersion)
    return
  end

  -- A host launch directive bypasses the interactive launcher exactly the
  -- way scripted runs always have: boot straight in when the version is
  -- ready, otherwise import headlessly from the staged picked_rom.gb and
  -- boot when it lands.  The host draws its own progress UI over the
  -- window, fed by host/import_status.json.
  if hostLaunch and hostLaunch.autoplay ~= false then
    HostSeam.applyLaunchPrefs(hostLaunch)
    HostSeam.applyLaunchPipelines(hostLaunch)
    HostSeam.applyLaunchViewport(hostLaunch)
    HostSeam.applyLaunchCapture(hostLaunch)
    local hostVersion = hostLaunch.version
    -- The directive's slot is selected BEFORE boot so the engine's own reads
    -- see it; `continue` enters that slot's world AFTER boot, in place of the
    -- splash and the title (HostSeam.continueAfterBoot). A slot that is gone
    -- refuses the continue rather than entering a different save.
    local function bootFromHost(version)
      local slotOK = HostSeam.selectLaunchSlot(hostLaunch, version)
      -- No Lua launcher behind this session: Phosphor's own library is the
      -- launcher, and it is what a close returns to. Without this the quit
      -- below read the session as a launcher-hosted one and restarted the
      -- process into a launcher that is never shown -- and an EMBEDDED LOVE
      -- cannot survive that restart: boot.lua re-inits a filesystem that was
      -- never torn down ("already initialized"), the boot dies at frame 0,
      -- and every later 3D launch in that app process dies the same way
      -- until the app is force quit. Reported on device Aug 22 2026 as
      -- "no matter what mod i try it starts to launch and then closes".
      launchedIntoGame = true
      bootGame(version)
      if slotOK then
        HostSeam.continueAfterBoot(hostLaunch, Game, version,
                                   require("src.core.GameVersion").generation())
      end
    end
    if RomImporter.isReady(hostVersion) and not forceImport then
      bootFromHost(hostVersion)
      return
    end
    Importer = RomImporter.new(function(version)
      Importer = nil
      hostImportActive = false
      HostSeam.clearImportStatus()
      bootFromHost(version or hostVersion)
    end)
    local data = love.filesystem.read("picked_rom.gb")
    if data then
      hostImportActive = true
      HostSeam.writeImportStatus({ phase = "working", percent = 0 })
      love.filesystem.remove("picked_rom.gb")
      Importer:startData(data, "picked_rom.gb")
    else
      -- The host asked for autoplay without staging a ROM.  Report it and
      -- leave the (idle, non-launcher) importer up; the host surfaces the
      -- error natively and tears the session down.
      HostSeam.writeImportStatus({ phase = "error", percent = 0,
        status = "No ROM was staged",
        detail = "picked_rom.gb was not present when autoplay was requested." })
    end
    return
  end

  -- The launcher draws before any game boots, so the mod loader has not run
  -- and Strings has no catalog.  Routing the launcher's text through Strings
  -- (#767) only pays off if something fills that catalog this early, and no
  -- restart could: the ordering is the same on every launch.  Read the
  -- enabled mods' string catalogs -- data only, no entry chunk -- so a
  -- translation reaches the launcher too.  The active game's loader replaces
  -- this with the real merged catalog once a version boots.
  do
    local preload = require("src.mods.LauncherMods").translationStrings()
    if preload then require("src.core.Strings").load({ strings = preload }) end
  end

  -- LAUNCH OPTIONS: skip the launcher and boot a game directly.
  --   --game red|blue|yellow|gold  (or POKEPORT_GAME / POKEPORT_LAUNCH)
  --   --slot <id>             optional; picks the save slot to load
  --   --launcher              force the launcher even if a game is set
  -- This is what a desktop shortcut, a Steam entry, or a frontend like
  -- EmulationStation needs: one click into the game the player wants, with no
  -- menu in between.  A game that is not imported falls through to the
  -- launcher on its tab rather than booting into nothing.
  -- A window close that restarted us into the launcher (#785) leaves the
  -- marker behind: consume it and stay on the launcher, or the shortcut below
  -- would boot the same game again and that close would restart again,
  -- forever (#887).  Consumed on read, so the very next launch is normal.
  local relaunched = love.filesystem.getInfo(RELAUNCH_MARKER) ~= nil
  if relaunched then pcall(love.filesystem.remove, RELAUNCH_MARKER) end

  local launchGame, launchSlot = LaunchOptions.resolve(arg)
  if launchGame and not relaunched and not LaunchOptions.forceLauncher(arg) then
    if RomImporter.isReady(launchGame) then
      if launchSlot then LaunchOptions.selectSlot(launchGame, launchSlot) end
      -- No launcher behind this session: love.quit must exit, not restart.
      launchedIntoGame = true
      bootGame(launchGame)
      return
    end
    -- Not importable yet: open the launcher already showing that game, so the
    -- shortcut still lands the player where they meant to go.
    LaunchOptions.pendingTab = launchGame
  end

  -- Interactive: the launcher always runs.  Red, Blue, Yellow, and Gold are
  -- each live: a column shows Play when that game's ROM is already imported,
  -- or Choose ROM / drag-drop when it is not.  Any dropped .gb/.gbc is routed
  -- by its SHA-1 (GameVersion.forSha1); pressing Play boots that game (Gold
  -- goes to its own service owner, src/core/Game2.lua -- docs/gold-phase1.md).
  -- Edit on a save row opens the bundled editor on that slot (openEditor).
  Importer = makeLauncher()
end

function love.update(dt)
  checkEmergencyQuit(dt)
  HostDisplay.update(dt)
  SwitchDiagnostics.maybeFlush(false)
  -- NX only (no-op elsewhere): follow dock/undock without waiting for SDL.
  NxDisplay.sync()
  if editorMode then return EditorApp.update(dt) end
  if TouchEditor then return TouchEditor.update(dt) end
  -- Upstream's desktop skin studio, ahead of the importer exactly as it is
  -- upstream. `Studio` is only ever set by openSkinStudio, which returns early
  -- unless SkinStudio.available_desktop(), so on iOS this stays nil and the
  -- line is a no-op.
  if Studio then return Studio.update(dt) end
  if Importer then
    Importer:update(dt)
    if hostImportActive then
      require("src.core.HostSeam").pumpImportStatus(Importer)
    end
    return
  end
  -- Upstream 0.2.4 added this guard to every input and update callback: the
  -- skin studio and the importer can both be up before a game exists, and
  -- Game:update on a nil Game is a crash. Kept AHEAD of the readback below
  -- rather than merged into it, because the readback's own precondition is
  -- that the frame is provably the game's, and a nil Game is exactly when it
  -- is not.
  if not Game then return end

  -- Past every early return above, so this frame is provably the GAME's --
  -- and nothing has drawn yet. Ask for any due Lock Screen readback here
  -- rather than at the top of love.draw: a mod drawing from an update hook
  -- takes the drawable first and makes the later request illegal.
  --
  -- Required through the module, like the pumpImportStatus call above:
  -- love.update has no `local HostSeam` of its own, and the bare name
  -- resolved to a nil GLOBAL -- which crashed the first game frame of
  -- every 3D session, and LÖVE's error screen is a frame loop, so the
  -- host then refused every later launch until the app was force quit.
  require("src.core.HostSeam").displayBackend:askIfDue()

  -- Scripted runs (autopilot / POKEPORT_DRIVER) observe and act exactly
  -- once per Game:update, so they must keep a 1:1 relationship with the
  -- logic step.  Fast-forwarding them by scaling the step inside
  -- Game:update would run N steps per observation: a held direction walks
  -- through all N, the player slides past the waypoint, and the script
  -- re-plans from an overshot cell.  So iterate the whole act+step loop
  -- instead -- same script, just more of it per rendered frame.
  local iterations = scriptedIterations()

  if autopilot then
    for _ = 1, iterations do
      autopilot.update()
      Game:update(1 / 60) -- deterministic stepping for the autopilot
    end
    return
  end
  if driverCo then
    for _ = 1, iterations do
      local ok, err = coroutine.resume(driverCo, Game)
      if not ok then
        print("driver error: " .. tostring(err))
        love.event.quit(1)
        return
      end
      if coroutine.status(driverCo) == "dead" then
        love.event.quit()
        return
      end
      Game:update(1 / 60)
    end
    return
  end
  pollHostCommands(dt)
  -- A slot picture asked for inside that poll must be requested BEFORE
  -- Game:update, whose mod hooks may draw; beginFrame is too late for it
  -- (see HostSeam.requestCapture). A no-op when nothing is pending.
  require("src.core.HostSeam").displayBackend:askIfDue()
  -- Mods may wrap or veto the per-frame simulation step (pause it, react
  -- to external platform state, etc.) -- see docs/modding.md's core.update
  -- entry. Vanilla behavior (used when no mod claims the hook) is just
  -- Game:update(dt), unconditionally, exactly as before this hook existed.
  -- The host poll above stays OUTSIDE the hook: a mod that vetoes the
  -- simulation step must not also be able to stop the host being answered.
  --
  -- It also stays HERE rather than on HostDisplay's update seam, unlike the
  -- island snapshot. That seam fires on every frame including the launcher's
  -- and the importer's, and pollCommand CONSUMES command.json — a command
  -- polled while the importer owns the session would be eaten with no live
  -- Game to run it and no result written, leaving the host waiting forever.
  PlatformHooks.update(Game, dt)
end

function love.draw()
  if editorMode then
    GameViewport.reset()
    HostDisplay.beginFrame("editor", EditorApp)
    local result = EditorApp.draw()
    HostDisplay.endFrame("editor", EditorApp)
    return result
  end
  if TouchEditor then
    GameViewport.reset()
    HostDisplay.beginFrame("touch_editor", TouchEditor)
    local result = TouchEditor.draw()
    HostDisplay.endFrame("touch_editor", TouchEditor)
    return result
  end
  if Studio then
    HostDisplay.beginFrame("skin_studio", Studio)
    local result = Studio.draw()
    HostDisplay.endFrame("skin_studio", Studio)
    return result
  end
  if Importer then
    GameViewport.reset()
    HostDisplay.beginFrame("launcher", Importer)
    local result = Importer:draw()
    HostDisplay.endFrame("launcher", Importer)
    return result
  end
  if not Game then
    GameViewport.reset()
    return
  end

  HostDisplay.beginFrame("game", Game)
  -- Frame capture requested by a driver. Asked for BEFORE the frame draws,
  -- for the reason spelled out over HostSeam.displayBackend.beginFrame: the
  -- copy happens in present(), out of a drawable that is only readable if
  -- the request was already pending when LOVE took it. Still captures this
  -- frame -- present() serves it after Game:draw either way.
  if Game.capturePath then
    local path = Game.capturePath
    Game.capturePath = nil
    love.graphics.captureScreenshot(function(imagedata)
      local fd = imagedata:encode("png")
      local f = io.open(path, "wb")
      if f then
        f:write(fd:getString())
        f:close()
      end
    end)
  end
  Game:draw()
  HostDisplay.endFrame("game", Game)
end

function love.keypressed(key, scancode, isrepeat)
  if editorMode then return EditorApp.keypressed(key) end
  if TouchEditor then return TouchEditor.keypressed(key) end
  if Studio then return Studio.keypressed(key) end
  if Importer then return Importer:keypressed(key) end
  if not Game then return end
  Game:keypressed(key)
end

function love.keyreleased(key)
  if editorMode or TouchEditor or Studio then return end
  if Importer then return end
  if not Game then return end
  Game:keyreleased(key)
end

function love.gamepadpressed(joystick, button)
  SwitchDiagnostics.onJoystickEvent("gamepadpressed", joystick, button)
  if editorMode then
    if EditorApp and EditorApp.gamepadpressed then
      return EditorApp.gamepadpressed(joystick, button)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.gamepadpressed then
      return TouchEditor.gamepadpressed(joystick, button)
    end
    return
  end
  if Studio then return Studio.gamepadpressed(joystick, button) end
  if Importer then return Importer:gamepadpressed(joystick, button) end
  if not Game then return end
  Game:gamepadpressed(joystick, button)
end

function love.gamepadreleased(joystick, button)
  SwitchDiagnostics.onJoystickEvent("gamepadreleased", joystick, button)
  if editorMode then
    if EditorApp and EditorApp.gamepadreleased then
      return EditorApp.gamepadreleased(joystick, button)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.gamepadreleased then
      return TouchEditor.gamepadreleased(joystick, button)
    end
    return
  end
  if Studio then return Studio.gamepadreleased(joystick, button) end
  if Importer then return Importer:gamepadreleased(joystick, button) end
  if not Game then return end
  Game:gamepadreleased(joystick, button)
end

function love.gamepadaxis(joystick, axis, value)
  SwitchDiagnostics.onJoystickEvent("gamepadaxis", joystick, axis, { value = value })
  if editorMode then
    if EditorApp and EditorApp.gamepadaxis then
      return EditorApp.gamepadaxis(joystick, axis, value)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.gamepadaxis then
      return TouchEditor.gamepadaxis(joystick, axis, value)
    end
    return
  end
  if Studio then return Studio.gamepadaxis(joystick, axis, value) end
  if Importer then return Importer:gamepadaxis(joystick, axis, value) end
  if not Game then return end
  Game:gamepadaxis(joystick, axis, value)
end

function love.joystickpressed(joystick, button)
  SwitchDiagnostics.onJoystickEvent("joystickpressed", joystick, button)
  if editorMode then
    if EditorApp and EditorApp.joystickpressed then
      return EditorApp.joystickpressed(joystick, button)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.joystickpressed then
      return TouchEditor.joystickpressed(joystick, button)
    end
    return
  end
  if Studio then return Studio.joystickpressed(joystick, button) end
  if Importer then return Importer:joystickpressed(joystick, button) end
  if not Game then return end
  Game:joystickpressed(joystick, button)
end

function love.joystickreleased(joystick, button)
  SwitchDiagnostics.onJoystickEvent("joystickreleased", joystick, button)
  if editorMode then
    if EditorApp and EditorApp.joystickreleased then
      return EditorApp.joystickreleased(joystick, button)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.joystickreleased then
      return TouchEditor.joystickreleased(joystick, button)
    end
    return
  end
  if Studio then return Studio.joystickreleased(joystick, button) end
  if Importer then return Importer:joystickreleased(joystick, button) end
  if not Game then return end
  Game:joystickreleased(joystick, button)
end

function love.joystickaxis(joystick, axis, value)
  SwitchDiagnostics.onJoystickEvent("joystickaxis", joystick, axis, { value = value })
  if editorMode then
    if EditorApp and EditorApp.joystickaxis then
      return EditorApp.joystickaxis(joystick, axis, value)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.joystickaxis then
      return TouchEditor.joystickaxis(joystick, axis, value)
    end
    return
  end
  if Studio then return Studio.joystickaxis(joystick, axis, value) end
  if Importer then return Importer:joystickaxis(joystick, axis, value) end
  if not Game then return end
  Game:joystickaxis(joystick, axis, value)
end

function love.joystickhat(joystick, hat, direction)
  SwitchDiagnostics.onJoystickEvent("joystickhat", joystick, hat, { direction = direction })
  if editorMode then
    if EditorApp and EditorApp.joystickhat then
      return EditorApp.joystickhat(joystick, hat, direction)
    end
    return
  end
  if TouchEditor then
    if TouchEditor.joystickhat then
      return TouchEditor.joystickhat(joystick, hat, direction)
    end
    return
  end
  if Studio then return Studio.joystickhat(joystick, hat, direction) end
  if Importer then return Importer:joystickhat(joystick, hat, direction) end
  if not Game then return end
  Game:joystickhat(joystick, hat, direction)
end

function love.joystickadded(joystick)
  SwitchDiagnostics.onJoystickEvent("joystickadded", joystick)
  if editorMode or TouchEditor or Studio then return end
  if Importer then return end
  if not Game then return end
  Game:joystickadded(joystick)
end

function love.joystickremoved(joystick)
  SwitchDiagnostics.onJoystickEvent("joystickremoved", joystick)
  if editorMode or TouchEditor or Studio then return end
  if Importer then return end
  if not Game then return end
  Game:joystickremoved(joystick)
end

-- f is true on focus gained, false on focus lost (e.g. alt-tab). A held
-- direction's key-up can be delivered to the OS instead of the game while
-- unfocused, so reset input on either transition rather than trust it.
function love.focus(f)
  if editorMode or TouchEditor then return end
  if Studio then
    if Studio.focus then Studio.focus(f) end
    return
  end
  if Importer then
    require("src.core.Input"):reset()
    if Importer.focus then Importer:focus(f) end
    return
  end
  if not Game then return end
  Game:focus(f)
end

-- v is true when the window becomes visible again, false on minimize.
function love.visible(v)
  if editorMode or TouchEditor then return end
  if Studio then
    if Studio.visible then Studio.visible(v) end
    return
  end
  if Importer then
    require("src.core.Input"):reset()
    return
  end
  if not Game then return end
  Game:visible(v)
end

function love.lowmemory()
  if editorMode or TouchEditor or Studio or Importer then return end
  if Game then Game:onResume() end
end

love.handlers = love.handlers or {}

function love.handlers.audiosuspend()
  local ChipAudio = package.loaded["src.core.ChipAudio"]
  if ChipAudio then pcall(ChipAudio.setSuspended, true) end
  local Sound = package.loaded["src.core.Sound"]
  if Sound then pcall(Sound.onDeviceReset) end
end

function love.handlers.audioreset()
  local ChipAudio = package.loaded["src.core.ChipAudio"]
  if ChipAudio then
    pcall(ChipAudio.setSuspended, false)
    pcall(ChipAudio.rebuildPlayback)
  end
  local Music = package.loaded["src.core.Music"]
  if Music then pcall(Music.onDeviceReset) end
  local Sound = package.loaded["src.core.Sound"]
  if Sound then pcall(Sound.onDeviceReset) end
end

function love.handlers.intent_game(version)
  if type(version) ~= "string" or version == "" then return end
  version = version:lower():gsub("^%s+", ""):gsub("%s+$", "")
  local GameVersion = require("src.core.GameVersion")
  if GameVersion.VERSIONS and not GameVersion.VERSIONS[version] then return end

  local RomImporter = require("src.import.RomImporter")
  if not RomImporter.isReady(version) then return end

  local currentVersion = GameVersion.get()
  if Game and currentVersion == version then
    return
  end

  if Game then
    returnToLauncher()
  end
  Importer = nil
  bootGame(version)
end

function love.touchpressed(id, x, y, dx, dy, pressure)
  if editorMode then
    -- iOS synthesizes mousepressed for the primary touch; forwarding here
    -- would double-fire.  Android / NX need the explicit touch → click path
    -- (love-nx does not synthesize mouse for the editor the way desktop does).
    if love.system.getOS() == "iOS" then return end
    if EditorApp and EditorApp.mousepressed then
      return EditorApp.mousepressed(x, y, 1)
    end
    return
  end
  if TouchEditor then
    -- iOS synthesizes mousepressed for the primary touch (same as the
    -- launcher); Android drives the editor through love.touch directly.
    if love.system.getOS() == "iOS" then return end
    return TouchEditor.touchpressed(id, x, y)
  end
  if Studio then return Studio.touchpressed(id, x, y) end
  if Importer then
    -- Both mobiles: FlexLove scroll needs the real touch stream. Clicks are
    -- polled inside the view; the istouch filter on mousepressed still drops
    -- Android's synthesized mouse twin so Import cannot double-fire (#553).
    return Importer:touchpressed(id, x, y, dx, dy, pressure)
  end
  if not Game then return end
  Game:touchpressed(id, x, y, dx, dy, pressure)
end

function love.touchmoved(id, x, y, dx, dy, pressure)
  if editorMode then return end
  if TouchEditor then
    if love.system.getOS() == "iOS" then return end
    return TouchEditor.touchmoved(id, x, y)
  end
  if Studio then return Studio.touchmoved(id, x, y) end
  if Importer then
    return Importer:touchmoved(id, x, y, dx, dy, pressure)
  end
  if not Game then return end
  Game:touchmoved(id, x, y, dx, dy, pressure)
end

function love.touchreleased(id, x, y, dx, dy, pressure)
  if editorMode then return end
  if TouchEditor then
    if love.system.getOS() == "iOS" then return end
    return TouchEditor.touchreleased(id, x, y)
  end
  if Studio then return Studio.touchreleased(id, x, y) end
  if Importer then
    return Importer:touchreleased(id, x, y, dx, dy, pressure)
  end
  if not Game then return end
  Game:touchreleased(id, x, y, dx, dy, pressure)
end

function love.wheelmoved(x, y)
  if editorMode then
    if EditorApp.wheelmoved then return EditorApp.wheelmoved(x, y) end
    return
  end
  if TouchEditor then return end
  if Studio then return Studio.wheelmoved(x, y) end
  if Importer then return end
  if not Game then return end
  Game:wheelmoved(x, y)
end

-- #781: Linux X11 multi-monitor with the primary display away from desktop
-- (0,0): SDL's polled mouse state can come back in desktop-virtual
-- coordinates while the event stream stays window-relative, which strands
-- every polled consumer (launcher Kit rising-edge clicks, the pad-cursor
-- motion yield, PadCursor) on coordinates no hit test can match.  Sanitize
-- the poll once here: remember the last window-relative event coordinates
-- and substitute them whenever the polled value falls outside the window.
-- Linux only -- macOS / Windows / mobile keep the stock function, and the
-- NX launcher shim still composes because it captures whatever
-- love.mouse.getPosition is at bridge time (_ensureNxPointerBridge).
local eventMouseX, eventMouseY
if love.system and love.system.getOS() == "Linux"
    and love.mouse and love.mouse.getPosition then
  local polledGetPosition = love.mouse.getPosition
  love.mouse.getPosition = function()
    local x, y = polledGetPosition()
    local w, h = love.graphics.getDimensions()
    if x < 0 or y < 0 or x > w or y > h then
      if eventMouseX then return eventMouseX, eventMouseY end
      return math.max(0, math.min(x, w)), math.max(0, math.min(y, h))
    end
    return x, y
  end
end

function love.mousepressed(x, y, button, istouch)
  if not istouch then eventMouseX, eventMouseY = x, y end
  if TouchEditor then
    -- Android primary touch already arrived via love.touchpressed; a second
    -- mouse path would double-fire Done / begin a second drag.
    if love.system.getOS() == "Android" then return end
    return TouchEditor.mousepressed(x, y, button)
  end
  if Studio then
    -- Mobile LÖVE sends both a touch event and an `istouch` mouse twin.
    -- Studio consumes the real finger stream above, so discard the twin.
    if istouch and (love.system.getOS() == "Android" or love.system.getOS() == "iOS") then return end
    return Studio.mousepressed(x, y, button)
  end
  if Importer then
    -- love.touchpressed already forwards the primary touch into FlexLove for
    -- scroll. LÖVE ALSO synthesizes a mouse press for that same touch; if both
    -- reached a press handler, one tap ran every launcher button twice and
    -- stacked two SAF pickers (#553). Clicks are polled inside FlexLove from
    -- love.touch / mouse.isDown, so dropping the synthesized istouch press is
    -- safe. A real mouse (DeX, Chromebook, USB) still reaches mousepressed.
    if istouch and (love.system.getOS() == "Android"
        or love.system.getOS() == "iOS") then return end
    return Importer:mousepressed(x, y, button)
  end
  if editorMode and EditorApp.mousepressed then
    -- Same Android double-fire guard: touchpressed already clicked for the
    -- save editor; a synthesized mouse press must not fire again.
    if istouch and love.system.getOS() == "Android" then return end
    return EditorApp.mousepressed(x, y, button)
  end
  if mouseTouch then
    -- the mouse is standing in for a finger: the touch path owns it, and
    -- feeding the same press back in as a mouse pointer would double it
    if Game and button == 1 then Game:touchpressed("mouse", x, y) end
    return
  end
  -- #807: a real mouse reaches gameplay as a pointer event for mods; Game
  -- drops synthesized istouch twins so a mobile touch that already arrived
  -- through love.touchpressed cannot fire twice
  if Game then Game:mousepressed(x, y, button, istouch) end
end

function love.mousereleased(x, y, button, istouch)
  if TouchEditor then
    if love.system.getOS() == "Android" then return end
    return TouchEditor.mousereleased(x, y, button)
  end
  if Studio then
    if istouch and (love.system.getOS() == "Android" or love.system.getOS() == "iOS") then return end
    return Studio.mousereleased(x, y, button)
  end
  if Importer then return end
  if editorMode and EditorApp.mousereleased then
    return EditorApp.mousereleased(x, y, button)
  end
  if mouseTouch then
    if Game and button == 1 then Game:touchreleased("mouse", x, y) end
    return
  end
  if Game then Game:mousereleased(x, y, button, istouch) end
end

function love.mousemoved(x, y, dx, dy, istouch)
  if not istouch then eventMouseX, eventMouseY = x, y end
  if TouchEditor then
    if love.system.getOS() == "Android" then return end
    return TouchEditor.mousemoved(x, y)
  end
  if Studio then
    if istouch and (love.system.getOS() == "Android" or love.system.getOS() == "iOS") then return end
    return Studio.mousemoved(x, y)
  end
  if editorMode or Importer then return end
  if mouseTouch then
    if Game and love.mouse.isDown(1) then Game:touchmoved("mouse", x, y) end
    return
  end
  if Game then Game:mousemoved(x, y, dx, dy, istouch) end
end

function love.textinput(text)
  if TouchEditor then return end
  if Studio then return Studio.textinput(text) end
  if Importer then return Importer:textinput(text) end
  if editorMode and EditorApp.textinput then
    return EditorApp.textinput(text)
  end
end

-- #785: set once love.quit has routed a window close into HostShell.restart,
-- so the follow-up quit event the restart itself raises (quit("restart") on
-- desktop; AppImage and Android relaunch the process instead, #575) falls
-- through to the normal shutdown below instead of restarting forever.
local quitToLauncher = false

-- Every background worker LOVE would wait for on the way out. LOVE waits for
-- every live love.thread before the process exits, and those workers idle in
-- a loop only a "quit" command breaks, so without this the process outlived
-- the window and the next launch re-entered the dead one (#339).
--
-- PHOSPHOR: this used to carry its own hand-written list of the three worker
-- modules. As of 0.2.24 upstream registers each on SessionLifecycle at module
-- load (ChipAudio, src.net.Fetch, src.update.Check), so this delegates rather
-- than restating them -- a hand list is exactly what would rot the next time
-- upstream adds a fourth worker, and this teardown is load-bearing twice over
-- (see the restart path below). endProcess only runs hooks whose module was
-- actually loaded, which is what the package.loaded guards used to buy.
-- Idempotent (endProcess pcalls each hook), so calling it on the restart path
-- and again on a later real quit is safe.
local function shutdownWorkers()
  pcall(function()
    require("src.core.DiscordPresence").shutdown()
  end)
  SessionLifecycle.endProcess()
end

function love.quit()
  if editorMode and EditorApp.quit then
    -- true blocks the quit (unsaved-changes prompt).  A quit that proceeds
    -- must fall through to the worker shutdowns below instead of returning:
    -- the bundled editor opens from a live launcher whose update-check and
    -- fetch-pool workers are still parked in Channel:demand(), and returning
    -- here skipped their "quit" push, so the process outlived the closed
    -- window and kept the install folder locked on Windows (#727).
    if EditorApp.quit() then return true end
  end
  -- Closing the window of a running game returns to the launcher instead of
  -- exiting the app, so testing a mod does not need a relaunch every time
  -- (#785).  Game is only non-nil once bootGame ran; Importer non-nil means
  -- the launcher (or its import) owns the window and its close still quits.
  -- Scripted and headless runs (autopilot, frame driver, import-only, ROM
  -- path import) keep the plain exit so they terminate as before.  Nothing
  -- is saved here on purpose: a window close never wrote the save, and the
  -- restart path must be no worse than that, not quietly better.
  local scripted = os.getenv("POKEPORT_AUTOPILOT") or os.getenv("POKEPORT_DRIVER")
    or os.getenv("POKEPORT_IMPORT_ONLY") == "1" or os.getenv("POKEPORT_IMPORT_ROM")
  -- #887: a shortcut session (--game / POKEPORT_GAME) has no launcher to go
  -- back to and the restart would re-read the shortcut, so it exits instead.
  --
  -- A platform launcher that owns "return to launcher" itself (see
  -- docs/modding.md's core.quit_to_launcher entry) may veto returning to
  -- this Lua launcher via that hook. Vanilla behavior (used when no mod
  -- claims the hook) is exactly the condition below.
  --
  -- Android and iOS both tear down LOVE in-process rather than
  -- love.event.quit("restart"): Android's vendored love.cpp PHYSFS-crashes
  -- on a second init (#575), and iOS's love.cpp forces DONE_RESTART for
  -- every quit while warning that leftover threads make that unreliable.
  -- SessionLifecycle workers (ChipAudio / Fetch / Check) make that warning
  -- real -- endProcess joins them, then the native restart still blows up.
  local osName = love.system and love.system.getOS and love.system.getOS()
  local inProcessReturn = (osName == "Android" or osName == "iOS")
  local wouldReturnToLauncher = PlatformHooks.quitToLauncher(function()
    return Game and not Importer and not quitToLauncher and not scripted
      -- PHOSPHOR: NOT upstream's `(inProcessReturn or not launchedIntoGame)`.
      -- The inner branch below takes their widened condition and should; this
      -- outer one must not. `isAndroid` was FALSE here, which is what kept a
      -- host-launched session out of the launcher-return path altogether and
      -- let it fall through to a normal quit, where Phosphor's library takes
      -- over. `inProcessReturn` is TRUE on iOS, so taking it here sends the
      -- player to gen1recomp's own Lua launcher on exit and leaves them
      -- sitting on it. Reported on device the same afternoon 0.2.27 was
      -- ported: "i exited my game and the gen1recomp native screen was just
      -- sitting there showing".
      --
      -- The platform term is dropped rather than translated. This overlay only
      -- ever runs on Phosphor's host, so the term could only ever be wrong: as
      -- `isAndroid` it was inert, as `inProcessReturn` it is harmful. What is
      -- left is the fact `bootFromHost` sets the flag to mean.
      and not launchedIntoGame
  end)
  if wouldReturnToLauncher then
    -- #339's shutdowns, before the restart and not only after it. A live
    -- love.thread holds the filesystem module open, and a restart that
    -- leaves the workers parked in Channel:demand() carries that module
    -- into the fresh boot -- fatal when LOVE is embedded rather than the
    -- process (see bootFromHost above). Standalone it only ever helped.
    --
    -- 0.2.27 widened this branch's own condition from isAndroid to
    -- inProcessReturn, which now names iOS too. That is the case Phosphor IS,
    -- so the overlay takes upstream's condition rather than keeping its own.
    shutdownWorkers()
    if inProcessReturn then
      returnToLauncher()
      return true -- abort this quit; stay in the same LOVE run
    end
    quitToLauncher = true
    -- Tell the fresh boot to ignore any boot-straight-into-a-game option this
    -- once, so the restart really does land in the launcher (#887).  A failed
    -- write only costs that suppression, so it must never block the restart.
    pcall(love.filesystem.write, RELAUNCH_MARKER, "1")
    require("src.core.HostShell").restart()
    return true -- abort this quit; the restart lands back in the launcher
  end
  shutdownWorkers()
end

function love.filedropped(file)
  if editorMode and EditorApp and EditorApp.filedropped then
    return EditorApp.filedropped(file)
  end
  if Studio then return Studio.filedropped(file) end
  if Importer then Importer:filedropped(file) end
end

local function pacingEnabled()
  if os.getenv("POKEPORT_AUTOPILOT") then return false end
  if os.getenv("POKEPORT_DRIVER") then return false end
  if os.getenv("POKEPORT_IMPORT_ONLY") == "1" then return false end
  return true
end

function love.run()
  if love.load then love.load(love.arg.parseGameArguments(arg), arg) end

  -- don't let love.load's cost land in the first frame's dt
  if love.timer then love.timer.step() end

  local FrameCap = require("src.core.FrameCap")
  local paced = pacingEnabled()
  -- The deadline the next present() should not beat.  Carried forward one
  -- budget per frame so pacing stays even instead of drifting with the
  -- per-frame sleep-granularity jitter.
  local nextFrame = love.timer and love.timer.getTime() or 0
  local dt = 0
  local idleFor = 0
  local SLEEP_FLOOR = 0.001
  local WAKE = {
    keypressed = true, keyreleased = true, textinput = true,
    mousepressed = true, mousereleased = true, mousemoved = true,
    wheelmoved = true, touchpressed = true, touchreleased = true,
    touchmoved = true, joystickpressed = true, joystickreleased = true,
    joystickhat = true, gamepadpressed = true, gamepadreleased = true,
    joystickadded = true, joystickremoved = true, filedropped = true,
    directorydropped = true, focus = true, visible = true, resize = true,
  }

  return function()
    -- process events
    if love.event then
      love.event.pump()
      for name, a, b, c, d, e, f in love.event.poll() do
        if name == "quit" then
          if not love.quit or not love.quit() then
            -- Android keeps the process and its task alive after LOVE's own
            -- teardown, so the relaunched task re-enters an activity whose
            -- native main already returned; end the process outright once the
            -- love.quit hook has run (#339)
            if love.system and love.system.getOS() == "Android" then
              os.exit(a or 0)
            end
            return a or 0
          end
        end
        if WAKE[name] then
          idleFor = 0
        elseif name == "joystickaxis" and type(c) == "number" and math.abs(c) > 0.5 then
          idleFor = 0
        end
        love.handlers[name](a, b, c, d, e, f)
      end
    end

    -- update dt
    if love.timer then dt = love.timer.step() end
    idleFor = idleFor + dt

    checkEmergencyQuit(dt)

    -- call update and draw
    if love.update then love.update(dt) end

    local visible = not (love.window and love.window.isVisible)
      or love.window.isVisible()
    local focused = not (love.window and love.window.hasFocus)
      or love.window.hasFocus()
    local cap = FrameCap.current
    if not visible then
      cap = 10
    elseif Importer and (not focused or idleFor > 30) then
      cap = 15
    end

    if visible and love.graphics and love.graphics.isActive() then
      love.graphics.origin()
      love.graphics.clear(love.graphics.getBackgroundColor())
      if love.draw then love.draw() end
      love.graphics.present()
    end

    if love.timer then
      if paced then
        -- Sleep out the remainder of the frame budget, measured from the
        -- carried deadline, in small chunks so the OS timer stays
        -- responsive.  The pacer yields to vsync inside a 1ms dead band, so
        -- when the panel already paces at or below the cap it is a no-op.
        local budget = 1 / cap
        nextFrame = nextFrame + budget
        local now = love.timer.getTime()
        -- A stall (alt-tab, a GC pause, a blocked import) can leave the
        -- deadline more than a full budget in the past; re-anchor to now so
        -- we pace the next frame rather than burst uncapped to catch up.
        if now - nextFrame > budget then
          nextFrame = now
        end
        while true do
          local remaining = nextFrame - love.timer.getTime()
          if remaining <= SLEEP_FLOOR then break end
          love.timer.sleep(0.001)
        end
      else
        love.timer.sleep(0.001)
      end
    end
  end
end
