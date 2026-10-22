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
local check, eq = S.check, S.eq

local f = assert(io.open("main.lua", "r"))
local src = f:read("*a")
f:close()

-- ---- 1. the host directive marks the session as having no launcher behind it

local bootFromHost = src:match("local function bootFromHost%(version%)(.-)\n    end")
check(bootFromHost ~= nil, "bootFromHost is still there to assert about")
check(bootFromHost and bootFromHost:find("launchedIntoGame = true", 1, true) ~= nil,
      "bootFromHost sets launchedIntoGame: Phosphor's library IS the launcher, "
      .. "so a close must exit rather than restart into the Lua one")

-- Upstream 0.3.85 owns restart teardown through endProcessOnce. Embedded
-- sessions must exit before reaching either native restart or Lua launcher.
local returnBody = src:match("local function returnToLauncher%(opts%)(.-)\nend\n")
check(returnBody and returnBody:find("if love._phosphorEmbedded then return love.event.quit() end", 1, true),
      "embedded return exits to Phosphor before restart")
check(src:find("and (mobile or not launchedIntoGame)", 1, true) == nil,
      "mobile must not force host sessions into the launcher")
check(src:find("and not launchedIntoGame", 1, true) ~= nil,
      "host-launched session bypasses the launcher")
local quit = src:match("\nfunction love%.quit%(%)(.-)\nend\n")
check(quit and quit:find("endProcessOnce()", 1, true), "actual quit shuts workers down")
check(returnBody and returnBody:find("endProcessOnce()", 1, true), "standalone restart shuts workers down")
local body = src:match("local function endProcessOnce%(%)(.-)\nend\n")
check(body and body:find('require("src.core.SessionLifecycle").endProcess()', 1, true),
      "shutdown still reaches SessionLifecycle")
-- Execute the actual helper to prove repeated quit paths do not repeat teardown.
local calls = 0
local shutdown = assert(loadstring("local processEnded = false; return function()" .. body .. "\nend"))
setfenv(shutdown, setmetatable({ require = function(name)
  if name == "src.core.SessionLifecycle" then return { endProcess = function() calls = calls + 1 end } end
  return { shutdown = function() end }
end }, { __index = _G }))
local once = shutdown()
once(); once()
eq(calls, 1, "process teardown runs once")
for _, worker in ipairs({
  { file = "src/update/Check.lua", name = "Check" },
  { file = "src/net/Fetch.lua", name = "Fetch" },
}) do
  local wf = assert(io.open(worker.file, "r"))
  local wsrc = wf:read("*a")
  wf:close()
  check(wsrc:find("registerProcessShutdown(" .. worker.name .. ".shutdown)", 1, true) ~= nil,
        worker.file .. " still registers its shutdown with SessionLifecycle")
end

-- Since 0.3.38 ChipAudio is shut down through package.loaded, so it need
-- not import SessionLifecycle on the audio hot path. Exercise the actual
-- endProcess entry point, including an absent audio module.
do
  local lifecycle = require("src.core.SessionLifecycle")
  local original = package.loaded["src.core.ChipAudio"]
  local calls = 0
  package.loaded["src.core.ChipAudio"] = { shutdown = function() calls = calls + 1 end }
  lifecycle.endProcess()
  eq(calls, 1, "endProcess shuts down a loaded ChipAudio worker exactly once")
  package.loaded["src.core.ChipAudio"] = nil
  check(pcall(lifecycle.endProcess), "endProcess also works before audio was loaded")
  package.loaded["src.core.ChipAudio"] = original
end

S.finish()
