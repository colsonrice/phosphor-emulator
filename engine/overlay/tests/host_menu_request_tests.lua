-- The host's session menu in the engine's own hotbar (HostSeam.requestMenu,
-- HostSeam.installHotbarMenu; why it exists is written over them). Drives
-- the installer with stand-ins for the two touch modules, then through the
-- real TouchSkin parser, so the cell it adds is one the engine would fire.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host menu")
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

-- What the installer touches: TouchSkin's hotkey names and control
-- constructor, TouchControls' cached item list and handler setter.
local function fakeModules()
  local TouchSkin = {
    HOTKEYS = { menu_toggle = "menu" },
    newControl = function(spec) return { spec = spec, hotkeys = { spec } } end,
  }
  local TouchControls = { handler = nil }
  function TouchControls:hotbarItems()
    if self.hotbarControls then return self.hotbarControls end
    self.hotbarControls = {
      { spec = "key:f1", label = "SAVE" },
      { spec = "key:f2", label = "LOAD" },
    }
    return self.hotbarControls
  end
  function TouchControls:setHotkeyHandler(fn) self.handler = fn end
  return TouchControls, TouchSkin
end

-- ------- the request file

local fs = fakeFs()
check(HostSeam.requestMenu(fs) == true, "a request writes host/menu_request.json")
local first = Json.decode(fs._files["host/menu_request.json"])
check(type(first) == "table" and type(first.seq) == "number", "the request carries a seq")
HostSeam.requestMenu(fs)
local second = Json.decode(fs._files["host/menu_request.json"])
check(second.seq == first.seq + 1, "seq is monotonic, so one press is one request")

-- ------- the installer, on stand-ins

local TC, TS = fakeModules()
fs = fakeFs()
check(HostSeam.installHotbarMenu(TC, TS, fs) == true, "installs once")
check(HostSeam.installHotbarMenu(TC, TS, fs) == false, "a second install is a no-op")
check(TS.HOTKEYS.phosphor_menu == "phosphor_menu", "the hotkey name is registered")
check(TS.HOTKEYS.menu_toggle == "menu", "the engine's own names are untouched")

local items = TC:hotbarItems()
check(#items == 3, "one cell is added after the engine's own")
check(items[3].label == "MENU" and items[3].spec == "phosphor_menu",
      "and it is the MENU cell, the word Phosphor's own deck uses")
check(#TC:hotbarItems() == 3, "asked again, still one MENU cell")
TC.hotbarControls = nil   -- what TouchControls:init() does per game
check(#TC:hotbarItems() == 3, "a fresh list after init() gets its cell again")

local seen = {}
TC:setHotkeyHandler(function(action, pressed)
  seen[#seen + 1] = tostring(action) .. ":" .. tostring(pressed)
end)
TC.handler("phosphor_menu", true)
check(fs._files["host/menu_request.json"] ~= nil, "a press writes the request")
check(#seen == 0, "and the game's handler never sees it")
fs._files["host/menu_request.json"] = nil
TC.handler("phosphor_menu", false)
check(fs._files["host/menu_request.json"] == nil, "a release writes nothing")
TC.handler("fast_forward_toggle", true)
check(seen[1] == "fast_forward_toggle:true", "every other action reaches the game as before")
TC:setHotkeyHandler(nil)
local okNil = pcall(TC.handler, "soft_reset", true)
check(okNil and #seen == 1, "a nil handler is tolerated, as the engine's setter tolerates it")

check(HostSeam.installHotbarMenu(nil, TS, fs) == false, "no modules, no install")

-- ------- the real parser

local okSkin, RealSkin = pcall(require, "src.core.TouchSkin")
if okSkin then
  local TC2 = fakeModules()
  HostSeam.installHotbarMenu(TC2, RealSkin, fs)
  local ctl = RealSkin.newControl(HostSeam.MENU_HOTKEY, 0, 0, 0, 0, "rect")
  check(ctl.hotkeys[1] == HostSeam.MENU_HOTKEY and ctl.decorative == false,
        "TouchSkin.newControl parses the cell as a live hotkey, not decoration")
else
  check(false, "the real TouchSkin could not load: " .. tostring(RealSkin))
end

-- ------- wiring in main.lua

local f = io.open("main.lua")
if f then
  local src = f:read("*a"); f:close()
  local at = src:find("HostSeam.installHotbarMenu(", 1, true)
  check(at ~= nil, "main.lua installs the hotbar menu")
  local before = src:sub(math.max(1, (at or 1) - 400), at or 1)
  check(before:find("if love._phosphorEmbedded then", 1, true) ~= nil,
        "gated on the embedded host: standalone keeps the hotbar it shipped")
  check(src:find("(Game.save and Game.save.options) or Game.options", 1, true) ~= nil,
        "the touchcontrols command reads Game3's options, which live off the save table")
else
  check(false, "could not open main.lua to scan it")
end

S.finish()
