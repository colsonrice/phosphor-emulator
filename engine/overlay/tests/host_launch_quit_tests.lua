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

-- The condition it feeds is the thing that must stay wired to it, and the
-- WAY it is wired is the overlay's own divergence: upstream ORs a platform
-- term in (`isAndroid`, widened to `inProcessReturn` at 0.2.27), and on
-- Phosphor's host that term is at best inert and at worst sends every exit
-- to gen1recomp's Lua launcher with the quit aborted and onExit never
-- firing (the two-minute-exit device report of Aug 27 2026). The overlay
-- drops the platform term from the OUTER condition and keeps upstream's
-- widened INNER branch. Both halves are pinned, because both halves have
-- regressed for real: the 0.2.32 take re-ported main.lua from a base that
-- predated the term-drop, and this suite was itself pinned to a stale
-- spelling and running red where nobody looked.
-- The `and (` prefix distinguishes the code from the comment that names the
-- rejected spelling right above it.
check(src:find("and (inProcessReturn or not launchedIntoGame)", 1, true) == nil,
      "the outer quit condition must NOT take upstream's platform term")
check(src:find("and not launchedIntoGame", 1, true) ~= nil,
      "the quit condition still reads launchedIntoGame")
check(src:find("if inProcessReturn then", 1, true) ~= nil,
      "the inner branch keeps upstream's widened in-process return")

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

-- The shutdowns themselves are still the #339 set. Since the 0.2.32 port
-- they run through upstream's SessionLifecycle: each worker registers its
-- own shutdown at module load, and endProcess runs the registered set. So
-- the pin moves with them: shutdownWorkers must still reach endProcess,
-- and each worker file must still register — a worker that quietly drops
-- its registration is exactly the #339 regression, and main.lua can no
-- longer see it.
local body = src:match("local function shutdownWorkers%(%)(.-)\nend\n")
check(body and body:find("SessionLifecycle.endProcess()", 1, true) ~= nil,
      "shutdownWorkers still reaches SessionLifecycle.endProcess")
for _, worker in ipairs({
  { file = "src/core/ChipAudio.lua", name = "ChipAudio" },
  { file = "src/update/Check.lua", name = "Check" },
  { file = "src/net/Fetch.lua", name = "Fetch" },
}) do
  local wf = assert(io.open(worker.file, "r"))
  local wsrc = wf:read("*a")
  wf:close()
  check(wsrc:find("registerProcessShutdown(" .. worker.name .. ".shutdown)", 1, true) ~= nil,
        worker.file .. " still registers its shutdown with SessionLifecycle")
end

S.finish()
