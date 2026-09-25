-- The host's two cells in the engine's own hotbar, EXIT and MORE
-- (HostSeam.requestMenu, HostSeam.installHotbarMenu; why they exist is
-- written over them). Drives the installer with stand-ins for the two touch
-- modules, then through the real TouchSkin parser, so the cells it adds are
-- ones the engine would fire. The host opening the bar itself is
-- host_hotbar_strip_tests.lua.
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

-- Json.encode walks keys in pairs() order, so a file with two keys has no one
-- spelling to compare against: read it back instead.
local function decoded(fs, name)
  local raw = fs._files["host/" .. name]
  if type(raw) ~= "string" then return nil end
  local ok, t = pcall(Json.decode, raw)
  return ok and type(t) == "table" and t or nil
end

-- What the installer touches: TouchSkin's hotkey names and control
-- constructor, TouchControls' cached item list, handler setter and draw.
local function fakeModules()
  local TouchSkin = {
    HOTKEYS = { menu_toggle = "menu" },
    newControl = function(spec) return { spec = spec, hotkeys = { spec }, keys = {}, buttons = {} } end,
  }
  local TouchControls = { handler = nil, active = true, hotbarEnabled = true, drawn = 0 }
  function TouchControls:visible() return self.active == true and self.enabled ~= false end
  function TouchControls:hotbarShown() return self.hotbarEnabled ~= false end
  function TouchControls:draw() self.drawn = self.drawn + 1 end
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
local first = decoded(fs, "menu_request.json")
check(type(first) == "table" and type(first.seq) == "number", "the request carries a seq")
check(first and first.action == "menu", "and names what it asks for: the host's menu, unless told otherwise")
HostSeam.requestMenu(fs)
local second = decoded(fs, "menu_request.json")
check(second and second.seq == first.seq + 1, "seq is monotonic, so one press is one request")
HostSeam.requestMenu(fs, "exit")
local third = decoded(fs, "menu_request.json")
check(third and third.action == "exit", "EXIT asks for the host's exit instead")
check(third and third.seq == second.seq + 1, "on the same sequence, so a host reading late still sees one press")

-- ------- the installer, on stand-ins

local TC, TS = fakeModules()
fs = fakeFs()
check(HostSeam.installHotbarMenu(TC, TS, fs) == true, "installs once")
check(HostSeam.installHotbarMenu(TC, TS, fs) == false, "a second install is a no-op")
check(TS.HOTKEYS.phosphor_menu == "phosphor_menu", "MORE's hotkey name is registered")
check(TS.HOTKEYS.phosphor_exit == "phosphor_exit", "EXIT's hotkey name is registered")
check(TS.HOTKEYS.menu_toggle == "menu", "the engine's own names are untouched")

local items = TC:hotbarItems()
check(#items == 4, "two cells are added after the engine's own")
check(items[3] and items[3].label == "EXIT" and items[3].spec == "phosphor_exit",
      "EXIT comes first")
check(items[4] and items[4].label == "MORE" and items[4].spec == "phosphor_menu",
      "then MORE, last, under the pad's own toggle: a tap that lands a little low opens a menu instead of leaving the game")
local labels = {}
for _, ctl in ipairs(items) do labels[#labels + 1] = ctl.label end
check(not table.concat(labels, " "):find("MENU", 1, true),
      "no cell is called MENU: that word is the host's own button, the one that opens this bar")
check(#TC:hotbarItems() == 4, "asked again, still two cells")
TC.hotbarControls = nil   -- what TouchControls:init() does per game
check(#TC:hotbarItems() == 4, "a fresh list after init() gets its cells again")

local seen = {}
TC:setHotkeyHandler(function(action, pressed)
  seen[#seen + 1] = tostring(action) .. ":" .. tostring(pressed)
end)

TC.hotbarOpen = true
TC.handler("phosphor_menu", true)
local req = decoded(fs, "menu_request.json")
check(req ~= nil and req.action == "menu", "MORE writes a menu request")
check(TC.hotbarOpen == false, "and folds the bar away, so the game is what the sheet closes onto")
check(#seen == 0, "and the game's handler never sees it")
fs._files["host/menu_request.json"] = nil
TC.handler("phosphor_menu", false)
check(fs._files["host/menu_request.json"] == nil, "a release writes nothing")

TC.hotbarOpen = true
TC.handler("phosphor_exit", true)
req = decoded(fs, "menu_request.json")
check(req ~= nil and req.action == "exit", "EXIT writes an exit request")
check(TC.hotbarOpen == false, "and folds the bar away too")
fs._files["host/menu_request.json"] = nil
TC.handler("phosphor_exit", false)
check(fs._files["host/menu_request.json"] == nil, "EXIT's release writes nothing either")
check(#seen == 0, "and the game never sees EXIT")

TC.handler("fast_forward_toggle", true)
check(seen[1] == "fast_forward_toggle:true", "every other action reaches the game as before")
TC:setHotkeyHandler(nil)
local okNil = pcall(TC.handler, "soft_reset", true)
check(okNil and #seen == 1, "a nil handler is tolerated, as the engine's setter tolerates it")

check(HostSeam.installHotbarMenu(nil, TS, fs) == false, "no modules, no install")

-- ------- the hotbar report, so the host knows what it can reach

local TC3, TS3 = fakeModules()
fs = fakeFs()
fs._files["host/hotbar.json"] = '{"shown":false}'
HostSeam.installHotbarMenu(TC3, TS3, fs)
check(fs._files["host/hotbar.json"] == nil, "install forgets a previous session's report")
TC3:draw()
check(TC3.drawn == 1, "the engine's own draw still runs")
local report = decoded(fs, "hotbar.json")
check(report and report.shown == true, "the first draw reports the hotbar shown")
check(report and report.hostStrip == true,
      "and that the host may open the bar itself, so its MENU knows it can")
fs._files["host/hotbar.json"] = "sentinel"
TC3:draw(); TC3:draw()
check(fs._files["host/hotbar.json"] == "sentinel", "an unchanged state is not rewritten per frame")
TC3.hotbarEnabled = false
TC3:draw()
report = decoded(fs, "hotbar.json")
check(report and report.shown == false, "the hotbar switched off is reported once")
check(report and report.hostStrip == true, "and the host can still open the bar: its own button is not that option")
TC3.hotbarEnabled = true
TC3.enabled = false
TC3:draw()
fs._files["host/hotbar.json"] = "sentinel2"
TC3:draw()
check(fs._files["host/hotbar.json"] == "sentinel2", "touch controls off: still off, so nothing new is written")
TC3.enabled = nil
TC3:draw()
report = decoded(fs, "hotbar.json")
check(report and report.shown == true, "back on is reported again")

-- ------- the real parser

local okSkin, RealSkin = pcall(require, "src.core.TouchSkin")
if okSkin then
  local TC2 = fakeModules()
  HostSeam.installHotbarMenu(TC2, RealSkin, fs)
  for _, name in ipairs({ HostSeam.MENU_HOTKEY, HostSeam.EXIT_HOTKEY }) do
    local ctl = RealSkin.newControl(name, 0, 0, 0, 0, "rect")
    check(ctl.hotkeys[1] == name and ctl.decorative == false,
          "TouchSkin.newControl parses " .. tostring(name) .. " as a live hotkey, not decoration")
  end
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
