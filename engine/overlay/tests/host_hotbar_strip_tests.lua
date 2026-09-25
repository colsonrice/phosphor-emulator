-- The engine's hotbar, opened by the HOST: Phosphor's MENU button under its
-- own control overlay, where the engine's pad (and so its "..." toggle) is
-- switched off. HostSeam.pollHotbarRequest, HostSeam.hotbarLayout and the
-- draw / touch / reset wrappers HostSeam.installHotbarMenu puts on
-- TouchControls; why the bar is opened this way is written over them.
--
-- Stand-ins for the touch modules and love.graphics, with the pad switched
-- off exactly as Phosphor's Overlay style boots it (enabled = false).
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host hotbar strip")
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

local function decoded(fs, name)
  local raw = fs._files["host/" .. name]
  if type(raw) ~= "string" then return nil end
  local ok, t = pcall(Json.decode, raw)
  return ok and type(t) == "table" and t or nil
end

local function request(fs, tbl)
  fs._files["host/hotbar_request.json"] = Json.encode(tbl)
end

local function fakeGraphics()
  local g = { calls = 0, printed = {} }
  local function rec() g.calls = g.calls + 1 end
  g.push, g.pop, g.origin, g.setFont, g.setColor, g.rectangle = rec, rec, rec, rec, rec, rec
  g.print = function(text) g.printed[#g.printed + 1] = text end
  return g
end

local FONT = {
  getWidth = function(_, s) return #tostring(s) * 6 end,
  getHeight = function() return 10 end,
}

local function fakeModules()
  local TouchSkin = {
    HOTKEYS = {},
    newControl = function(spec)
      local key = tostring(spec):match("^key:(.+)$")
      if key then return { spec = spec, keys = { key }, hotkeys = {}, buttons = {} } end
      return { spec = spec, keys = {}, hotkeys = { spec }, buttons = {} }
    end,
  }
  local TC = { active = true, enabled = false, hotbarEnabled = true, labelFont = FONT,
               log = {}, hotbarOpen = false }
  function TC:visible() return self.active == true and self.enabled ~= false end
  function TC:hotbarShown() return self.hotbarEnabled ~= false end
  function TC:layout() return { hotbar = { w = 40 } } end
  function TC:hotbarItems()
    if self.hotbarControls then return self.hotbarControls end
    self.hotbarControls = {}
    for _, e in ipairs({ { "key:f1", "SAVE" }, { "key:f2", "LOAD" }, { "key:3", "TILT" } }) do
      local ctl = TouchSkin.newControl(e[1])
      ctl.label = e[2]
      self.hotbarControls[#self.hotbarControls + 1] = ctl
    end
    return self.hotbarControls
  end
  function TC:setHotkeyHandler(fn) self.hotkeyHandler = fn end
  function TC:draw() self.log[#self.log + 1] = "draw" end
  function TC:touchpressed(id) self.log[#self.log + 1] = "pressed:" .. tostring(id) end
  function TC:touchmoved(id) self.log[#self.log + 1] = "moved:" .. tostring(id) end
  function TC:touchreleased(id) self.log[#self.log + 1] = "released:" .. tostring(id) end
  function TC:reset() self.log[#self.log + 1] = "reset"; self.hotbarOpen = false end
  function TC:init() self.log[#self.log + 1] = "init"; self.hotbarControls = nil end
  TC.buzz = function() TC.buzzed = (TC.buzzed or 0) + 1 end
  return TC, TouchSkin
end

local function logged(tc, entry)
  for _, e in ipairs(tc.log) do if e == entry then return true end end
  return false
end

-- A window 400 x 800, safe rect 400 x 760 from y = 40.
local keys = {}
local function deps(g)
  return {
    graphics = g,
    windowRect = function() return 0, 40, 400, 760 end,
    fullDimensions = function() return 400, 800 end,
    key = function(key, down) keys[#keys + 1] = key .. (down and "+" or "-") end,
  }
end

local function cellNamed(tc, label)
  for _, cell in ipairs(HostSeam.hotbarCells(tc) or {}) do
    if cell.label == label then return cell end
  end
  return nil
end

local function centre(cell) return cell.x + cell.w / 2, cell.y + cell.h / 2 end

-- ------- the request file

local fs = fakeFs()
local TC, TS = fakeModules()
local g = fakeGraphics()
request(fs, { op = "toggle" })
HostSeam.installHotbarMenu(TC, TS, fs, deps(g))
check(fs._files["host/hotbar_request.json"] == nil,
      "install forgets a request a previous session left behind")

check(HostSeam.pollHotbarRequest(TC, fs) == nil, "no request, nothing happens")
check(HostSeam.hotbarOpenedByHost(TC) == false, "and the bar starts closed")
request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
check(HostSeam.pollHotbarRequest(TC, fs) == true, "a toggle opens the bar")
check(fs._files["host/hotbar_request.json"] == nil, "consumed on read, so one tap is one toggle")
check(HostSeam.hotbarOpenedByHost(TC) == true, "and it reads open")
request(fs, { op = "toggle" })
check(HostSeam.pollHotbarRequest(TC, fs) == false, "a second toggle closes it: the same button opens and closes")
request(fs, { op = "close" })
check(HostSeam.pollHotbarRequest(TC, fs) == false, "close on a closed bar leaves it closed")
request(fs, { op = "toggle" })
HostSeam.pollHotbarRequest(TC, fs)
request(fs, { op = "close" })
check(HostSeam.pollHotbarRequest(TC, fs) == false, "close closes an open bar")
fs._files["host/hotbar_request.json"] = "not json"
check(HostSeam.pollHotbarRequest(TC, fs) == nil, "garbage changes nothing")
check(fs._files["host/hotbar_request.json"] == nil, "but is consumed, so it cannot wedge the channel")
local bare = fakeFs()
request(bare, { op = "toggle" })
check(HostSeam.pollHotbarRequest(fakeModules(), bare) == nil,
      "a pad the seam never installed on is left alone")
check(bare._files["host/hotbar_request.json"] ~= nil,
      "and the request is left for the host to take back")

-- ------- where the cells go (pure)

local function width(s) return #s * 6 end
local safe = { x = 0, y = 40, w = 400, h = 760 }
local items = { { label = "SAVE" }, { label = "LOAD" }, { label = "SPEED" },
                { label = "EXIT" }, { label = "MORE" } }
local H = 38
local pad = H * 0.14
local cells = HostSeam.hotbarLayout(items, H, width, safe, 200, 120)
check(#cells == 5, "one cell per item")
check(cells[1].label == "SAVE" and cells[5].label == "MORE", "in the pad's order")
check(cells[1].ctl == items[1], "each cell carries its control, so a press fires what the pad would")
local left, right = cells[1].x, cells[5].x + cells[5].w
check(math.abs((left + right) / 2 - 200) <= pad, "centred under the host's button")
check(cells[1].y == 120 and cells[5].y == 120, "hung from the host's anchor")
check(cells[1].h == H, "at the pad's own cell height")
check(cells[1].w == cells[5].w, "cells share one width, as the pad's own strip does")

cells = HostSeam.hotbarLayout(items, H, width, safe, 395, 120)
check(cells[5].x + cells[5].w <= safe.x + safe.w - pad + 1e-9,
      "an anchor in the corner keeps the bar on screen")
cells = HostSeam.hotbarLayout(items, H, width, safe, 5, 120)
check(cells[1].x >= safe.x + pad - 1e-9, "on either side")
local many = {}
for i = 1, 30 do many[i] = { label = "CELL" .. i } end
cells = HostSeam.hotbarLayout(many, H, width, safe, 200, 120)
check(cells[1].x >= safe.x + pad - 1e-9 and cells[30].x + cells[30].w <= safe.x + safe.w + 1e-9,
      "more cells than fit share the safe width instead of running off it")
cells = HostSeam.hotbarLayout(items, H, width, safe, 200, 5000)
check(cells[1].y + H <= safe.y + safe.h + 1e-9, "an anchor below the screen keeps the bar on it")
cells = HostSeam.hotbarLayout(items, H, width, safe, 200, -50)
check(cells[1].y >= safe.y, "and so does one above it")
check(#HostSeam.hotbarLayout({}, H, width, safe, 200, 120) == 0, "no items, no cells")
local wide = HostSeam.hotbarLayout({ { label = "A" }, { label = "AVERYLONGLABEL" } },
                                   H, width, safe, 200, 120)
check(wide[1].w == wide[2].w and wide[2].w >= #"AVERYLONGLABEL" * 6,
      "one long label widens every cell, as the pad's own strip does")

-- ------- drawing

fs = fakeFs()
TC, TS = fakeModules()
g = fakeGraphics()
HostSeam.installHotbarMenu(TC, TS, fs, deps(g))
TC:draw()
check(#g.printed == 0, "a closed bar draws nothing")
check(TC.log[#TC.log] == "draw", "and the pad's own draw still runs")
request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
TC:draw()
local drawn = table.concat(g.printed, " ")
check(drawn:find("SAVE", 1, true) and drawn:find("TILT", 1, true),
      "an open bar draws the pad's own cells, with the pad switched off")
check(drawn:find("EXIT", 1, true) and drawn:find("MORE", 1, true), "and the host's two")
local save = cellNamed(TC, "SAVE")
check(save ~= nil and save.y == 0.2 * 800, "hung where the host asked, in window units")
check(save ~= nil and save.h == 40 * 0.95, "at the pad's cell height, from the pad's own layout")
local more = cellNamed(TC, "MORE")
check(more ~= nil and math.abs((save.x + more.x + more.w) / 2 - 200) <= save.h * 0.14,
      "centred on the anchor")

-- The phone turned under an open bar: MENU moved, and the engine never resets
-- the pad on a rotation, so the host re-hangs the bar without toggling it.
request(fs, { op = "anchor", anchor = { x = 0.9, y = 0.1 } })
check(HostSeam.pollHotbarRequest(TC, fs) == true, "an anchor update leaves an open bar open")
TC:draw()
local moved = cellNamed(TC, "SAVE")
check(moved ~= nil and moved.y == 0.1 * 800, "and hangs it where MENU is now")
request(fs, { op = "toggle" })
HostSeam.pollHotbarRequest(TC, fs)
request(fs, { op = "anchor", anchor = { x = 0.5, y = 0.2 } })
check(HostSeam.pollHotbarRequest(TC, fs) == false, "and leaves a closed bar closed")
request(fs, { op = "toggle" })
HostSeam.pollHotbarRequest(TC, fs)
TC:draw()
check(cellNamed(TC, "SAVE").y == 0.2 * 800, "for the next time it opens")

TC.enabled = true   -- the style switched to the engine's pad under an open bar
g.printed = {}
TC:draw()
check(#g.printed == 0, "with the engine's own pad on screen, its own bar wins")
check(HostSeam.hotbarOpenedByHost(TC) == false, "and the host's is closed, not merely hidden")
TC.enabled = false

-- ------- touches

request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
TC:draw()
save = cellNamed(TC, "SAVE")
local sx, sy = centre(save)
keys = {}
TC.log = {}
check(TC:touchpressed(7, sx, sy) == true, "a press on a cell is the bar's")
check(keys[1] == "f1+", "and presses that cell's key, exactly as the pad's own bar does")
check(TC.buzzed == 1, "with the pad's own buzz")
check(not logged(TC, "pressed:7"), "the pad never sees it")
TC:touchmoved(7, sx + 60, sy)
check(not logged(TC, "moved:7"), "its finger is not the game's to track")
TC:touchreleased(7, sx, sy)
check(keys[2] == "f1-", "release lets the key go")
check(not logged(TC, "released:7"), "and the pad never sees that finger at all")

check(TC:touchpressed(8, 5, 790) == nil, "a press off the bar is not the bar's")
check(logged(TC, "pressed:8"), "it goes to the pad, and on to the game, as before")
TC:touchreleased(8, 5, 790)
check(logged(TC, "released:8"), "and so does its release")

local seen = {}
TC:setHotkeyHandler(function(action, pressed) seen[#seen + 1] = action end)
more = cellNamed(TC, "MORE")
TC:touchpressed(9, centre(more))
local req = decoded(fs, "menu_request.json")
check(req ~= nil and req.action == "menu", "MORE on the host's bar asks for the host's menu")
check(HostSeam.hotbarOpenedByHost(TC) == false, "and folds the bar away")
check(#seen == 0, "the game's handler never sees MORE")
local okRelease = pcall(TC.touchreleased, TC, 9, centre(more))
check(okRelease, "lifting the finger from a bar that closed under it is harmless")

request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
TC:draw()
fs._files["host/menu_request.json"] = nil
TC:touchpressed(10, centre(cellNamed(TC, "EXIT")))
req = decoded(fs, "menu_request.json")
check(req ~= nil and req.action == "exit", "EXIT on the host's bar asks the host to exit")
TC:touchreleased(10, 0, 0)

TC.log = {}
check(HostSeam.hotbarOpenedByHost(TC) == false, "(closed again)")
check(TC:touchpressed(11, sx, sy) == nil and logged(TC, "pressed:11"),
      "a closed bar claims nothing, even where its cells were")

-- ------- reset and init

request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
TC:draw()
keys = {}
TC:touchpressed(12, centre(cellNamed(TC, "TILT")))
check(keys[1] == "3+", "TILT held")
TC:reset()
check(keys[2] == "3-", "reset lets go of a held cell: LOVE has no touchcancelled")
check(HostSeam.hotbarOpenedByHost(TC) == false, "and closes the bar, as it closes the pad's own")
check(TC.log[#TC.log] == "reset", "the pad's own reset still runs")

request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
TC:init()
check(HostSeam.hotbarOpenedByHost(TC) == false, "a new game starts with the bar closed")
check(TC.log[#TC.log] == "init", "and the pad's own init still runs")

-- ------- a bar that cannot draw withdraws itself

fs = fakeFs()
TC, TS = fakeModules()
g = fakeGraphics()
g.rectangle = function() error("boom") end
HostSeam.installHotbarMenu(TC, TS, fs, deps(g))
TC:draw()
check(decoded(fs, "hotbar.json").hostStrip == true, "offered while it works")
request(fs, { op = "toggle", anchor = { x = 0.5, y = 0.2 } })
HostSeam.pollHotbarRequest(TC, fs)
local okDraw = pcall(TC.draw, TC)
check(okDraw, "a bar that fails to draw never takes the frame down with it")
check(HostSeam.hotbarOpenedByHost(TC) == false, "it closes")
TC:draw()
check(decoded(fs, "hotbar.json").hostStrip == false,
      "and the report withdraws it, so the host's MENU goes back to opening its own sheet")
request(fs, { op = "toggle" })
HostSeam.pollHotbarRequest(TC, fs)
check(HostSeam.hotbarOpenedByHost(TC) == false, "a withdrawn bar refuses to open again")

-- ------- wiring in main.lua

local f = io.open("main.lua")
if f then
  local src = f:read("*a"); f:close()
  local fnAt = src:find("local function pollHostCommands(dt)", 1, true)
  local cmdAt = src:find("local cmd = HostSeam.pollCommand()", 1, true)
  check(fnAt ~= nil and cmdAt ~= nil, "main.lua still has its host command poll")
  local body = (fnAt and cmdAt) and src:sub(fnAt, cmdAt) or ""
  local pollAt = body:find("pollHotbarRequest(", 1, true)
  check(pollAt ~= nil, "the host's bar requests are polled in the same place as its commands")
  local lead = pollAt and body:sub(math.max(1, pollAt - 160), pollAt) or ""
  check(lead:find("if Game then", 1, true) ~= nil,
        "only while a game is running, so a request made before one exists is left for the host")
  check(lead:find("pcall(", 1, true) ~= nil,
        "under pcall: a Lua error here would strand the host on the error screen")
  local throttleAt = body:find("if hostCommandTimer < 0.25 then return end", 1, true)
  check(pollAt ~= nil and throttleAt ~= nil and pollAt < throttleAt,
        "ahead of the command throttle, so it runs faster than the quarter second commands wait")
else
  check(false, "could not open main.lua to scan it")
end

S.finish()
