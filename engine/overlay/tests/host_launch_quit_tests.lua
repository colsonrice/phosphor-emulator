-- The host-launched session must never restart the process.
--
-- Phosphor embeds LOVE: the app IS the process, so `love.event.quit("restart")`
-- does not start a fresh one. It re-enters boot.lua, which re-inits a
-- filesystem that was never torn down, and dies with
--   [love "boot.lua"]:65: Failed to initialize filesystem: already initialized
-- at frame 0. Worse, the restart branch used to return before #339's worker
-- shutdowns, so the parked love.threads held the filesystem module open for
-- the life of the app: from then on EVERY 3D launch in that process died the
-- same way, and only force quitting the app cleared it. Reported on device
-- Aug 22 2026 -- "no matter what mod i try to start the game with it just
-- starts to launch and then closes".
--
-- These are source assertions rather than behaviour, on purpose: main.lua is
-- a script, not a module, and the realistic way this regresses is a pin bump
-- re-porting the overlay by hand and dropping one of the two lines.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("host launch quit")
local check = S.check

local f = assert(io.open("main.lua", "r"))
local src = f:read("*a")
f:close()

-- ---- 1. the host directive marks the session as having no launcher behind it

local bootFromHost = src:match("local function bootFromHost%(version%)(.-)\n    end")
check(bootFromHost ~= nil, "bootFromHost is still there to assert about")
check(bootFromHost and bootFromHost:find("launchedIntoGame = true", 1, true) ~= nil,
      "bootFromHost sets launchedIntoGame: Phosphor's library IS the launcher, "
      .. "so a close must exit rather than restart into the Lua one")

-- The vanilla condition it feeds is the thing that must stay wired to it.
check(src:find("isAndroid or not launchedIntoGame", 1, true) ~= nil,
      "the quit condition still reads launchedIntoGame")

-- ---- 2. the worker shutdowns run on EVERY quit path

local quit = src:match("\nfunction love%.quit%(%)(.-)\nend\n")
check(quit ~= nil, "love.quit is still there to assert about")
local restartBranch = quit and quit:match("if wouldReturnToLauncher then(.-)\n  end")
check(restartBranch ~= nil, "the restart branch is still there to assert about")
check(restartBranch and restartBranch:find("shutdownWorkers()", 1, true) ~= nil,
      "the restart branch shuts the workers down before restarting: a parked "
      .. "love.thread holds the filesystem module open across the restart")

local _, shutdownCalls = quit:gsub("shutdownWorkers%(%)", "")
check(shutdownCalls >= 2, "both quit paths shut the workers down (found "
      .. shutdownCalls .. ")")

-- One definition, so the two call sites cannot drift apart.
local _, defs = src:gsub("local function shutdownWorkers%(%)", "")
check(defs == 1, "exactly one shutdownWorkers definition (found " .. defs .. ")")

-- The shutdowns themselves are still the #339 set.
local body = src:match("local function shutdownWorkers%(%)(.-)\nend\n")
for _, mod in ipairs({ "src.core.ChipAudio", "src.update.Check", "src.net.Fetch" }) do
  check(body and body:find(mod, 1, true) ~= nil, mod .. " is still shut down")
end

S.finish()
