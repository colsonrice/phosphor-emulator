-- The host's `speed` command (HostSeam.hostOptions, applyHostSpeed,
-- persistHostOptions, setHostSpeed, hostSpeedLevel).
--
-- It used to write `options.speed` on `Game.save.options` and nothing else,
-- and then save that table flat. Three things were wrong with that, one per
-- generation, seen from Phosphor as a Game Speed picker that did nothing on
-- Yellow or FireRed (Oct 5 2026):
--
--   Gen 1  reads a key per activity (speedOverworld, speedBattle, speedMenu;
--          RFC 0007), and `speed` is dropped when options load.
--   Gen 3  keeps its options on `Game.options`, with no `save.options` at
--          all, so it was never found.
--   Gen 2  reads `speed`, so it answered, but its options are Gold's own
--          block and only its own writer puts them back under `gold`. Saved
--          flat, the block on disk never changed and Gold's values landed in
--          the keys the other generations read.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host speed")
local check = S.check

local HostSeam = require("src.core.HostSeam")

-- ------- where the running game keeps its options

do
  local gen1 = { save = { options = { speedOverworld = 1 } } }
  check(HostSeam.hostOptions(gen1) == gen1.save.options,
        "Gen 1 and Gen 2: the options inside the save table")

  local gen3 = { options = { speedOverworld = 1 } }
  check(HostSeam.hostOptions(gen3) == gen3.options,
        "Gen 3: the shared options on the game, which has no save.options")

  local both = { save = { options = { tag = "save" } }, options = { tag = "game" } }
  check(HostSeam.hostOptions(both).tag == "save",
        "the save's options win when a game carries both")

  check(HostSeam.hostOptions({}) == nil, "a game with neither has none")
  check(HostSeam.hostOptions({ save = {} }) == nil, "a save with no options has none")
  check(HostSeam.hostOptions(nil) == nil, "no game, no options")
end

-- ------- each generation gets the keys it reads, and no others

do
  -- Gen 1 and Gen 3: a key per activity.
  for _, generation in ipairs({ 1, 3 }) do
    local opts = { speedOverworld = 1, speedBattle = 1, speedMenu = 1 }
    local set = HostSeam.applyHostSpeed(opts, 3, generation)
    check(set == 3, "Gen " .. generation .. ": returns the level it set")
    check(opts.speedOverworld == 3 and opts.speedBattle == 3 and opts.speedMenu == 3,
          "Gen " .. generation .. ": all three activity keys are set")
    check(opts.speed == nil,
          "Gen " .. generation .. ": `speed`, which it does not read, is not invented")
    HostSeam.applyHostSpeed(opts, 1, generation)
    check(opts.speedOverworld == 1 and opts.speedBattle == 1 and opts.speedMenu == 1,
          "Gen " .. generation .. ": normal speed is a level like any other")
  end

  -- Gen 2: `speed` alone.
  local gold = { speed = 1 }
  check(HostSeam.applyHostSpeed(gold, 2, 2) == 2, "Gen 2: returns the level it set")
  check(gold.speed == 2, "Gen 2: its own key is set")
  check(gold.speedOverworld == nil and gold.speedBattle == nil and gold.speedMenu == nil,
        "Gen 2: no activity keys are left in Gold's block to go stale")
end

-- ------- a value that is not one of the engine's levels

do
  -- The engine's ladder starts 1, 2, 3, 4, 10. Phosphor's own picker once
  -- offered 5 and 15, which are not on it.
  local opts = {}
  check(HostSeam.applyHostSpeed(opts, 5, 1) == 4, "5 is not a level: the nearest is 4")
  check(opts.speedOverworld == 4, "and that is what is stored")
  check(HostSeam.applyHostSpeed(opts, 2.4, 1) == 2, "a fraction goes to the nearest level")
  check(HostSeam.applyHostSpeed(opts, 0, 1) == 1, "nothing below normal speed")
  check(HostSeam.applyHostSpeed(opts, -3, 1) == 1, "a negative number is normal speed")
  check(HostSeam.applyHostSpeed(opts, 10, 1) == 10, "10 is a level")
end

-- ------- the game writes its own options

-- Three stand-ins shaped like the three game classes, each counting how
-- often its own writer ran, and a SaveData that counts the flat write the
-- command used to make.
local function standIns()
  local flat = { calls = 0 }
  local SaveData = { saveOptions = function(o) flat.calls = flat.calls + 1; flat.last = o end }

  local function game(build)
    local g = build()
    g.writes = 0
    g.writeOptions = function(self) self.writes = self.writes + 1 end
    return g
  end
  local gen1 = game(function()
    return { save = { options = { speedOverworld = 1, speedBattle = 1, speedMenu = 1 } } }
  end)
  -- Game2 holds one table twice: `options`, and the save's reference to it.
  local gen2 = game(function()
    local options = { speed = 1, textSpeed = "MID" }
    return { options = options, save = { options = options } }
  end)
  local gen3 = game(function()
    return { options = { speedOverworld = 1, speedBattle = 1, speedMenu = 1 } }
  end)
  return gen1, gen2, gen3, flat, SaveData
end

do
  local gen1, gen2, gen3, flat, SaveData = standIns()

  check(HostSeam.setHostSpeed(gen1, 3, { SaveData = SaveData, generation = 1 }) == 3,
        "Gen 1: the command returns the level")
  check(gen1.save.options.speedOverworld == 3, "Gen 1: the speed is set")
  check(gen1.writes == 1, "Gen 1: the game wrote its own options, once")

  check(HostSeam.setHostSpeed(gen2, 3, { SaveData = SaveData, generation = 2 }) == 3,
        "Gen 2: the command returns the level")
  check(gen2.options.speed == 3, "Gen 2: Gold's speed is set")
  check(gen2.writes == 1,
        "Gen 2: Gold's own writer ran, the only one that puts its block back under `gold`")

  check(HostSeam.setHostSpeed(gen3, 4, { SaveData = SaveData, generation = 3 }) == 4,
        "Gen 3: the command returns the level")
  check(gen3.options.speedBattle == 4, "Gen 3: the speed is set")
  check(gen3.writes == 1, "Gen 3: the game wrote its own options, once")

  check(flat.calls == 0,
        "nothing was saved flat: on Gold that put its values in the other generations' keys")
end

do
  -- A game object from before `writeOptions` existed still gets saved.
  local _, _, _, flat, SaveData = standIns()
  local old = { save = { options = { speedOverworld = 1 } } }
  HostSeam.setHostSpeed(old, 2, { SaveData = SaveData, generation = 1 })
  check(flat.calls == 1 and flat.last == old.save.options,
        "without a writer of its own, the options are saved the way they always were")
end

do
  -- A game with no options yet refuses, and says why.
  local ok, err = pcall(HostSeam.setHostSpeed, {}, 3, { generation = 1 })
  check(not ok and tostring(err):find("options not loaded yet", 1, true) ~= nil,
        "a game whose options have not loaded is an error the command can report")
end

do
  -- The same writer serves the touchcontrols command.
  local gen1, gen2, gen3, flat, SaveData = standIns()
  for _, g in ipairs({ gen1, gen2, gen3 }) do
    HostSeam.persistHostOptions(g, HostSeam.hostOptions(g), { SaveData = SaveData })
  end
  check(gen1.writes == 1 and gen2.writes == 1 and gen3.writes == 1 and flat.calls == 0,
        "persistHostOptions asks each game to write its own")
end

-- ------- the speed a game booted at

do
  check(HostSeam.hostSpeedLevel({ save = { options = { speedOverworld = 4, speedBattle = 1 } } }, 1) == 4,
        "Gen 1: the overworld's speed is the speed")
  check(HostSeam.hostSpeedLevel({ options = { speedOverworld = 2 } }, 3) == 2, "Gen 3: the same key")
  local gold = { speed = 3, speedOverworld = 10 }
  check(HostSeam.hostSpeedLevel({ options = gold, save = { options = gold } }, 2) == 3,
        "Gen 2: `speed`, even beside a key it does not read")
  check(HostSeam.hostSpeedLevel({}, 1) == nil, "no options, nothing to say")
  check(HostSeam.hostSpeedLevel({ options = { speedOverworld = "fast" } }, 3) == nil,
        "a value that is not a number is not a level")
  check(HostSeam.hostSpeedLevel({ options = { speedOverworld = 0 } }, 3) == nil,
        "nor is one below normal speed")
end

-- ------- the host is told when the speed changes
--
-- The host's control is not the only thing that sets the speed: the engine's
-- own bar has a SPEED cell, a gamepad's shoulders step it on a Game Boy game,
-- and the options menu sets it per activity. host/speed.json is how the
-- host's dial follows them.

local function fakeFs()
  local files, writes = {}, {}
  return {
    read = function(name) return files[name] end,
    write = function(name, contents)
      files[name] = contents
      writes[#writes + 1] = name
      return true
    end,
    remove = function(name) files[name] = nil; return true end,
    getInfo = function(name) return files[name] and { type = "file" } or nil end,
    createDirectory = function() return true end,
    _files = files,
    _writes = writes,
  }
end

local function speedFile(fs)
  local raw = fs._files["host/speed.json"]
  if not raw then return nil end
  return tonumber(raw:match('"level"%s*:%s*(%d+)'))
end

local function writesOf(fs, name)
  local n = 0
  for _, written in ipairs(fs._writes) do
    if written == name then n = n + 1 end
  end
  return n
end

do
  local fs = fakeFs()
  -- A boot: the report carries the speed the game booted at, and whatever
  -- the last session left in speed.json is not this session's.
  fs._files["host/speed.json"] = '{"level":10}'
  local game = { save = { options = { speedOverworld = 2, speedBattle = 2, speedMenu = 2 } } }
  HostSeam.writeModState(nil, fs, nil, game)
  check(fs._files["host/state.json"]:find('"speedLevel":2', 1, true) ~= nil,
        "the boot report says the speed the game booted at")
  check(fs._files["host/speed.json"] == nil, "a boot clears the last session's speed.json")

  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == false,
        "nothing changed since the boot report: nothing is written")
  check(fs._files["host/speed.json"] == nil, "and there is no file")

  -- The engine's own SPEED cell, or a gamepad's shoulder.
  game.save.options.speedOverworld = 3
  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == true, "a changed speed is reported")
  check(speedFile(fs) == 3, "with the new level")

  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == false, "and reported once")
  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == false, "not on every poll")
  check(writesOf(fs, "host/speed.json") == 1, "one write for one change")

  -- The host's own command is a change like any other.
  HostSeam.setHostSpeed({ save = game.save, writeOptions = function() end }, 10,
                        { generation = 1 })
  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == true, "the host's own command is reported back")
  check(speedFile(fs) == 10, "so a level the engine rounded is the level the dial shows")

  -- Back to what it was: still a change from the last thing said.
  game.save.options.speedOverworld = 3
  check(HostSeam.reportSpeedIfChanged(game, fs, 1) == true and speedFile(fs) == 3,
        "a change back is a change")
end

do
  -- Gen 2 reads `speed`, and its other keys are not its speed.
  local fs = fakeFs()
  local gold = { speed = 1, speedOverworld = 4 }
  local game = { options = gold, save = { options = gold } }
  HostSeam.writeModState(nil, fs, nil, nil)
  check(HostSeam.reportSpeedIfChanged(game, fs, 2) == true and speedFile(fs) == 1,
        "Gen 2: a game whose options loaded after the boot report says its speed then")
  gold.speedOverworld = 10
  check(HostSeam.reportSpeedIfChanged(game, fs, 2) == false,
        "Gen 2: a key it does not read is not a change of speed")
  gold.speed = 2
  check(HostSeam.reportSpeedIfChanged(game, fs, 2) == true and speedFile(fs) == 2,
        "Gen 2: its own key is")
end

do
  -- A game with nothing to say says nothing, and does not raise.
  local fs = fakeFs()
  HostSeam.writeModState(nil, fs, nil, nil)
  check(HostSeam.reportSpeedIfChanged(nil, fs, 1) == false, "no game: nothing written")
  check(HostSeam.reportSpeedIfChanged({}, fs, 1) == false, "no options: nothing written")
  check(HostSeam.reportSpeedIfChanged({ options = { speedOverworld = "fast" } }, fs, 3) == false,
        "a speed that is not a number: nothing written")
  check(fs._files["host/speed.json"] == nil, "and no file appears")

  -- A write that fails is not remembered as told, so the next poll tries again.
  local failing = fakeFs()
  failing.write = function() error("disk full") end
  local game = { options = { speedOverworld = 4 } }
  check(HostSeam.reportSpeedIfChanged(game, failing, 3) == false, "a failed write reports false")
  check(HostSeam.reportSpeedIfChanged(game, fs, 3) == true and speedFile(fs) == 4,
        "and the level is still owed to the host")
end

-- ------- main.lua is what calls it
--
-- A function nothing calls fixes nothing, and the command dispatch needs a
-- live Game to run. So the two branches are read: each from its own `elseif`
-- to the next.

local function branchOf(src, command)
  local from = src:find('elseif cmd.cmd == "' .. command .. '"', 1, true)
  if not from then return nil end
  local to = src:find("elseif cmd.cmd ==", from + 10, true)
  return src:sub(from, (to or #src) - 1)
end

do
  local f = io.open("main.lua", "r")
  if f then
    local src = f:read("*a")
    f:close()

    local speed = branchOf(src, "speed")
    check(speed ~= nil, "main.lua handles the speed command")
    speed = speed or ""
    check(speed:find("HostSeam.setHostSpeed(Game, cmd.value)", 1, true) ~= nil,
          "the speed command goes through setHostSpeed")
    check(speed:find("report(ok, err)", 1, true) ~= nil, "and reports the outcome")
    check(speed:find("saveOptions(", 1, true) == nil,
          "nothing in it saves the options flat any more")

    local touch = src:match('elseif cmd.cmd == "touchcontrols".-\n  end\nend') or ""
    check(touch ~= "", "main.lua handles the touchcontrols command")
    check(touch:find("HostSeam.persistHostOptions(Game, opts)", 1, true) ~= nil,
          "the touchcontrols command has the game write its own options")
    check(touch:find('require("src.core.SaveData").saveOptions(opts)', 1, true) == nil,
          "and no longer saves them flat")

    check(src:find("writeModState(Game.mods, nil, Game.data, Game)", 1, true) ~= nil,
          "the boot report is handed the game, for the speed it booted at")
    check(src:find("pcall(HostSeam.reportSpeedIfChanged, Game)", 1, true) ~= nil,
          "the command poll tells the host when the speed changes")
  else
    check(false, "could not open main.lua to scan it")
  end
end

S.finish()
