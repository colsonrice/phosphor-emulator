-- Two rules the embedded engine lives by that upstream, which never runs
-- embedded, has no reason to keep. Both were re-ported by hand at v0.3.37 and
-- both fail silently when a later port drops them, so they are pinned here.
--
-- 1. No error SCREEN runs when LOVE is embedded. An error screen is a frame
--    loop, so the boot coroutine never finishes, LoveHost.isRunning never goes
--    false, and one crash refuses every later 3D launch until the app is
--    force quit (a real device report). v0.3.37 replaced the screen with
--    src/debug/CrashScreen, which can also call love.window.setMode itself.
--    The overlay returns to the host's handler before any of it.
--
-- 2. The pad gate never drops input when embedded. v0.3.37 drops gamepad and
--    joystick events while the window reads minimized; embedded, every press
--    (the controller deck and physical pads alike) arrives through an SDL
--    virtual gamepad, so a stale flag would leave a 3D session with no
--    controls at all.
--
-- Source assertions for main.lua, which is a script rather than a module, and
-- a behaviour check of the override against the real PadHints module.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host embedded guards")
local check = S.check

local f = assert(io.open("main.lua", "r"))
local src = f:read("*a")
f:close()

-- ---- 1. the error handler defers to the host before any screen

local handler = src:match("function love%.errorhandler%(msg%)(.-)\n  love%.errhand = love%.errorhandler")
check(handler ~= nil, "love.errorhandler is still there to assert about")
local guard = handler and handler:find("if love._phosphorEmbedded then\n      if defaultErrorHandler then\n        return defaultErrorHandler(nativeMsg)", 1, true)
local screen = handler and handler:find('pcall(require, "src.debug.CrashScreen")', 1, true)
check(guard ~= nil, "the embedded early return to the host's handler is there")
check(screen ~= nil, "upstream's CrashScreen block is still there to be guarded")
check(guard and screen and guard < screen,
      "the embedded return comes BEFORE the CrashScreen block, so no screen "
      .. "and no love.window.setMode ever runs embedded")
local _, handlers = src:gsub("function love%.errorhandler%(", "")
check(handlers == 1, "exactly one love.errorhandler (found " .. handlers .. ")")

-- ---- 2. the pad gate is off when embedded

local override = "if love._phosphorEmbedded then\n  PadHints.windowMinimized = function() return false end\nend"
local req = src:find('local PadHints = require("src.core.PadHints")', 1, true)
local at = src:find(override, 1, true)
check(req ~= nil, "main.lua still requires PadHints")
check(at ~= nil, "main.lua overrides PadHints.windowMinimized when embedded")
check(req and at and at > req and at - req < 1200,
      "the override sits right after the require, before any callback can ask")

-- And the override does what it says against the real module: a window that
-- reports minimized drops input standalone, never embedded.
local minimizedWindow = { isMinimized = function() return true end,
                          isVisible = function() return false end }
local function freshPadHints()
  package.loaded["src.core.PadHints"] = nil
  return require("src.core.PadHints")
end

love = { window = minimizedWindow }
local standalone = freshPadHints()
check(standalone.windowMinimized() == true,
      "standalone, a minimized window still gates pad input (upstream's rule)")

love = { window = minimizedWindow, _phosphorEmbedded = true }
local embedded = freshPadHints()
if love._phosphorEmbedded then
  embedded.windowMinimized = function() return false end
end
check(embedded.windowMinimized() == false,
      "embedded, the same window never gates pad input")
check(require("src.core.PadHints") == embedded,
      "one module table, so src/core/Input.lua's poll reads the override too")

love = nil
S.finish()
