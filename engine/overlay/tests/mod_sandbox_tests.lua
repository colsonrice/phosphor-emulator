-- The mod sandbox: what a mod can and cannot reach.
--
-- These are the checks that make "an installed mod cannot call native code,
-- open a socket, or read a file outside its own folder" a claim rather than a
-- hope, so they assert on ABSENCE and on REFUSAL, which are the properties
-- that actually matter.
--
-- Run it on its own from the repo root:
--   luajit tests/mod_sandbox_tests.lua
-- (tests/run_tests.lua dofiles it too, via the tests/mod_*.lua glob, so
-- everything this file touches globally gets put back before it finishes.
-- Note that scripts/test.sh only reaches run_tests.lua in the T3 content
-- tier, which needs data/generated/ -- on a ROM-free checkout this file runs
-- only when you run it.)
--
-- WHAT IS PHOSPHOR'S AND WHAT IS UPSTREAM'S.  src/mods/Sandbox.lua is now
-- upstream's file with a thin Phosphor patch on top (see its header), and
-- upstream ships tests/modkit/cases/sandbox.lua covering the parts we did not
-- change.  This suite is deliberately NOT a copy of that: it pins the eight
-- places Phosphor is tighter, plus the options_schema tripwire, which is the
-- only thing in either tree that notices a FOURTH surface compiling mod code
-- appearing in a pin bump.  Everything here should fail loudly if a future
-- pin quietly relaxes it.
--
-- AND ONE PLACE PHOSPHOR IS DELIBERATELY LOOSER, at the bottom: the pointer
-- bridge (src/mods/PointerBridge.lua), which turns a legacy
-- `love.mousemoved` assignment into an `input.pointer` subscription rather
-- than refusing it.  It is here rather than hidden because it is the single
-- relaxation in the file and the next person should meet it beside the
-- tightenings.  It grants no new capability -- `Hooks:wrap` has no name
-- allow-list, so a mod can already subscribe to `input.pointer` itself -- and
-- the checks below pin the two properties that make that true: nothing ever
-- reaches `_G.love`, and the link always calls `next` so it can never
-- suppress the engine's own handling.
package.path = "./?.lua;./?/init.lua;" .. package.path
-- The end-to-end section at the bottom drives the real Loader, which wants the
-- ordinary LOVE stub every modkit case uses.
love = love or require("tests.love_stub")

local S = require("tests.harness").suite("mod sandbox")
local check, eq = S.check, S.eq

local Logger = require("src.core.Logger")
local Sandbox = require("src.mods.Sandbox")
local SafePath = require("src.mods.SafePath")

-- ------- the environment: what is simply not there

local env = Sandbox.envFor({ modId = "TEST_MOD" })

check(Sandbox.available(), "this host can confine mods (setfenv present)")
check(env.ffi == nil, "no ffi: a mod cannot call arbitrary C")
check(env.package == nil, "no package: no loadlib, no preload tampering")
check(env.io == nil, "no io: no popen, no host filesystem")
-- PHOSPHOR: `debug` is a one-member table now, not nil. Ten published mods
-- hand debug.traceback to xpcall, and an index of nil was what they got for
-- trying to report an error. The property was never "no table called debug",
-- it is "no introspection", and that is what is pinned.
check(type(env.debug) == "table" and type(env.debug.traceback) == "function",
  "debug.traceback exists: it returns a string, and mods pass it to xpcall")
do
  local members = 0
  for _ in pairs(env.debug) do members = members + 1 end
  eq(members, 1, "and traceback is the ONLY member of debug")
end
check(env.debug.getinfo == nil and env.debug.sethook == nil
        and env.debug.getupvalue == nil and env.debug.setupvalue == nil
        and env.debug.getregistry == nil and env.debug.getfenv == nil
        and env.debug.setfenv == nil and env.debug.getmetatable == nil,
  "no debug introspection: upvalues and the registry are where the real "
  .. "globals live")
check(env.debug ~= debug, "and it is not the real debug table")
check(env.dofile == nil and env.loadfile == nil, "no dofile/loadfile")
check(env.setfenv == nil and env.getfenv == nil,
  "no setfenv/getfenv: a mod cannot swap its own environment back out")
-- PHOSPHOR (5). Upstream leaves collectgarbage in; it is not a compute
-- primitive, it retunes the ENGINE's collector ("setpause"/"setstepmul") and
-- a "step" from a frame handler is a hitch the player reads as the emulator
-- being slow.
--
-- Narrowed, not removed, as of September 2026: three published mods call it
-- and "absent" reached them as `attempt to call a nil value`. What the rule
-- above was protecting is the TUNING half, and that is what is pinned.
check(type(env.collectgarbage) == "function" and env.collectgarbage ~= collectgarbage,
  "collectgarbage exists, and is not the real one")
check(type(env.collectgarbage("count")) == "number", "count answers")
do
  local pause = collectgarbage("setpause", 200)
  collectgarbage("setpause", pause)
  eq(env.collectgarbage("setpause", 1), 0, "setpause answers 0 ...")
  local after = collectgarbage("setpause", pause)
  eq(after, pause, "... and did NOT retune the engine's collector")
  eq(env.collectgarbage("stop"), 0, "stop does nothing")
  eq(env.collectgarbage("setstepmul", 1), 0, "setstepmul does nothing")
  collectgarbage("restart")
end
check(type(env.require) == "function",
  "require EXISTS: real mods build on the engine (103 such calls in the "
  .. "bundled voxel mod), so removing it breaks the ecosystem it protects")

-- ------- the legitimate things ARE there

check(type(env.pairs) == "function" and type(env.pcall) == "function",
  "base library present")
check(type(env.string.format) == "function", "string present")
check(type(env.math.floor) == "function", "math present")
check(type(env.table.concat) == "function", "table present")
check(type(env.coroutine.create) == "function", "coroutine present")
check(type(env.os.time) == "function", "os.time present")
check(env.os.execute == nil and env.os.remove == nil and env.os.getenv == nil,
  "os is clock-only: no execute, no remove, no getenv")
check(env._G == env, "_G is the sandbox itself, not an escape hatch")

-- library copies are per-mod
env.string.format = function() return "hijacked" end
check(string.format("%d", 1) == "1",
  "a mod monkey-patching string breaks only itself")

-- ------- the deny list, asserted through moduleDenial AND through require
--
-- moduleDenial is the shared decision (Loader's dev-mode backstop calls it
-- too), env.require is the path a mod actually takes.  Both, because a patch
-- that fixes one and not the other looks green from either side alone.

local function denied(name, permissions, why)
  local perms = permissions or {}
  local reason = Sandbox.moduleDenial(name, perms)
  check(type(reason) == "string",
    ("moduleDenial refuses %q -- %s"):format(name, why))
  local probe = Sandbox.envFor({ modId = "DENY_MOD", permissions = perms })
  local ok, err = pcall(probe.require, name)
  check(not ok, ("require(%q) is refused -- %s"):format(name, why))
  return tostring(reason) .. "|" .. tostring(err)
end

denied("ffi", nil, "the native-code hatch stays shut")
denied("ffi.load", nil, "and so does every child of it")
denied("io", nil, "no host filesystem")
denied("os", nil, "no process control")
denied("package", nil, "package.loaded.io would undo everything else")
denied("debug", nil, "no upvalue rewriting")

-- PHOSPHOR (3). Upstream's DENIED_PREFIX test reads `DENIED_PREFIX[root] and
-- name ~= root`, so the BARE name slipped through: require("love") handed
-- back the real love table, which is love.filesystem.write,
-- love.thread.newThread and love.system.openURL in one object -- every single
-- thing the love facade exists to take away.
denied("love", nil, "the bare root is denied with its children")
denied("love.filesystem", nil, "writing anywhere in the save directory")
denied("love.thread", nil, "a new Lua state would not carry this sandbox")
denied("love.system", nil, "openURL launches whatever it is handed")

-- PHOSPHOR (2). jit.util and jit.dump are not fields of the `jit` global --
-- they are separate modules -- so the require path is the only place they can
-- be closed.  jit.util.funcinfo hands out the address of every compiled
-- function (an ASLR leak), and jit.dump.on(mode, outfile) writes an arbitrary
-- host path.  env.jit itself stays as upstream has it.
denied("jit", nil, "the JIT internals are not a mod-facing API")
denied("jit.util", nil, "funcinfo leaks code addresses")
denied("jit.dump", nil, "dump.on(mode, outfile) is an arbitrary host write")
check(env.jit == nil or type(env.jit) == "table",
  "the jit GLOBAL is left exactly as upstream has it -- only require is closed")

-- PHOSPHOR (7). LOVE's PhysFS searcher has the save directory on package.path,
-- so require("mods.<id>.<file>") resolves a mod's OWN second Lua file through
-- the REAL require -- which binds it to the REAL globals, because nothing in
-- Sandbox.lua is involved in loading it.  Two files in a mod folder and the
-- whole sandbox is bypassed.  Neither implementation's deny list mentioned it.
--
-- Denying the root outright is NOT the fix: it broke every multi-file mod
-- (Crystal 251 is ~40 files and could not load its own extractor).  The
-- property that matters is that mod code never reaches the REAL require, so a
-- mod's own submodules are loaded by sandboxedRequire through
-- Sandbox.loadFile instead.  What stays denied:
denied("mods.evil.payload", nil,
  "ANOTHER mod's file cannot be loaded through the real require")
denied("mods", nil, "nor the root that reaches it")
denied("mods.TEST_MOD", nil, "nor this mod's own root, which names no file")
denied("mods.TEST_MOD.helper", nil,
  "without selfModules there is no confined path, so it stays refused")

-- PHOSPHOR (9). LÖVE's require loader turns `.` into `/` and resolves the same
-- file either way, so the deny list has to catch the slash spelling too -- or
-- require("mods/evil/payload") walks straight past a root split only on dots.
-- This is the direct-moduleDenial path (Loader's _G.require backstop); the
-- confined-require path is covered below with the SELF_MOD fixture.
denied("mods/evil/payload", nil,
  "the slash spelling of another mod's file is denied, not just the dotted one")
denied("mods/TEST_MOD/helper", nil,
  "and the slash spelling of this mod's own file, with no confined path")
denied("io/", nil, "a trailing slash cannot dodge the io root either")

-- ...and what now works, confined.
local selfFs = {}
function selfFs.read(path)
  if path == "mods/SELF_MOD/lib/helper.lua" then
    return "local n = ... ; return { name = n, leaked = rawget(_G, 'io') }"
  end
  if path == "mods/SELF_MOD/loop.lua" then
    return "return require('mods.SELF_MOD.loop')"
  end
  return nil, "no such file"
end
function selfFs.load(path)
  local source = selfFs.read(path)
  if not source then return nil, "no such file" end
  local compile = loadstring or load
  return compile(source, "@" .. path)
end

local selfEnv = Sandbox.envFor({
  modId = "SELF_MOD",
  selfModules = { fs = selfFs, path = "mods/SELF_MOD" },
})

local okSelf, helper = pcall(selfEnv.require, "mods.SELF_MOD.lib.helper")
check(okSelf and type(helper) == "table",
  "a mod CAN require its own submodule: " .. tostring(helper))
check(okSelf and helper.name == "mods.SELF_MOD.lib.helper",
  "and receives its module name, like require does")
-- The whole point: loaded INTO the sandbox, not against the real globals.
check(okSelf and helper.leaked == nil,
  "a required submodule sees the SANDBOX globals, not the real io")
local okAgain, second = pcall(selfEnv.require, "mods.SELF_MOD.lib.helper")
check(okAgain and second == helper,
  "require's one-instance contract holds for a mod's own modules")
check(not pcall(selfEnv.require, "mods.OTHER_MOD.payload"),
  "the confined path is scoped to the mod's OWN id")
check(not pcall(selfEnv.require, "mods.SELF_MOD./../evil"),
  "a traversal spelled through the module name is refused")
check(not pcall(selfEnv.require, "mods.SELF_MOD.loop"),
  "a circular require fails loudly rather than hanging")
-- PHOSPHOR (9), the escape itself: LÖVE resolves mods/OTHER_MOD/payload to the
-- same file as the dotted name, so the slash spelling must not reach the real
-- require either.  This is the live-loader path (env.require), not just
-- moduleDenial -- the canonicalisation in sandboxedRequire is what closes it.
check(not pcall(selfEnv.require, "mods/OTHER_MOD/payload"),
  "the slash spelling of another mod's file cannot reach the real require")
-- And a mod's OWN file spelled with slashes still lands on the CONFINED path
-- (canonicalised to dots), so it loads sandboxed rather than being refused --
-- proving the fix normalises rather than merely blanket-denying any slash.
local okSlash, slashHelper = pcall(selfEnv.require, "mods/SELF_MOD/lib/helper")
check(okSlash and type(slashHelper) == "table" and slashHelper.leaked == nil,
  "a mod's own file by slash name loads confined, seeing the sandbox globals")

-- PHOSPHOR (1). Upstream gates the wire on a manifest "permissions":
-- ["network"] declaration.  A manifest is supplied by the same folder as the
-- code, so it is not a grant, it is a request the attacker writes for himself.
-- Denied with the permission, without it, and every way round.
local NETWORK_MODULES = { "socket", "socket.core", "socket.http", "socket.url",
                          "enet", "http", "https", "ssl", "mime", "ltn12",
                          "lua-https" }
for _, name in ipairs(NETWORK_MODULES) do
  local messages = denied(name, nil, "no outbound network")
  denied(name, { network = true },
    "STILL no outbound network with the manifest permission declared")
  if name == "socket" then
    check(messages:find("network", 1, true) ~= nil,
      "the refusal names the network so a mod author reads the real reason")
  end
end

-- PHOSPHOR (8). The engine's own link stack is the one place a mod could
-- reach a peer without naming a socket library, and it is mediated by the
-- engine rather than a raw socket, so it keeps the manifest gate rather than
-- the blanket allowance the rest of src.* gets.
do
  local quiet = Sandbox.envFor({ modId = "QUIET_MOD", permissions = {} })
  local ok, err = pcall(quiet.require, "src.link.Net")
  check(not ok and tostring(err):find("network", 1, true),
    "src.link.Net -- the enet/socket transport -- needs the network "
    .. "permission: " .. tostring(err))
  check(not pcall(quiet.require, "src.link.LinkState"),
    "...and so does src.link.LinkState, which requires it")
  check(not pcall(quiet.require, "src.link.Tournament"),
    "...and src.link.Tournament, which requires it")
  check(pcall(quiet.require, "src.link.Fingerprint"),
    "src.link.Fingerprint is computation over merged data -- always allowed, "
    .. "because a mod reading the link fingerprint is a compatibility check")
  check(pcall(quiet.require, "src.link.Json"),
    "src.link.Json is parsing, not networking -- always allowed")
  -- The gate lives on the require a MOD holds, never in the shared
  -- moduleDenial: upstream's dev-mode backstop applies moduleDenial to every
  -- require whose caller sits outside src/, which is every tests/ file, and
  -- 17 engine tests require src.link.Net at file scope.  Putting it there
  -- failed tests/modkit/cases/link_desync.lua -- and only when a loader had
  -- run earlier in the same process, which is the worst shape a rule can have.
  eq(Sandbox.moduleDenial("src.link.Net", {}), nil,
    "...and moduleDenial stays out of it, so an engine caller requiring the "
    .. "transport is never mistaken for a mod")
end

-- PHOSPHOR (10). gen1recomp 0.2.5 added CacheFs.loadActive(rel), which
-- compiles bytes with `loadstring or load` and then with love.filesystem.load,
-- both with NO environment argument, so what it runs is bound to the REAL
-- globals.  PhysFS has the save directory on its path, so the path a mod hands
-- it can name the mod's own second file:
--
--     require("src.import.CacheFs").loadActive("mods/<own-id>/payload.lua")
--
-- which is PHOSPHOR (7)'s bypass arriving without touching require.  The
-- blanket src.* allowance made it reachable the moment the pin moved.
do
  local quiet = Sandbox.envFor({ modId = "QUIET_MOD", permissions = {} })
  local ok, err = pcall(quiet.require, "src.import.CacheFs")
  check(not ok, "src.import.CacheFs is refused to mods: it exposes "
    .. "loadActive(), which runs a file against the real globals")
  check(ok or tostring(err):find("mod.storage", 1, true) ~= nil,
    "...and the refusal points at the confined API instead: " .. tostring(err))
  -- Same placement rule as PHOSPHOR (8) above, and for the same reason: 0.2.5
  -- ships cache_fs_blue_mount, cache_fs_gold_nx_load and cache_fs_headless,
  -- which require this module at file scope from outside src/.
  eq(Sandbox.moduleDenial("src.import.CacheFs", {}), nil,
    "...and moduleDenial stays out of it, so the engine and its own tests can "
    .. "still require the cache filesystem")
  -- The property, not just the name: if a future pin moves the loader onto
  -- another module, this is the assertion that should start failing.
  local CacheFs = require("src.import.CacheFs")
  check(type(CacheFs.loadActive) == "function",
    "loadActive still exists at this pin -- if it is gone, re-read whether "
    .. "the denial above is still the right shape")
end

-- PHOSPHOR (11).  The host shell and the launcher's HTTP stack are engine
-- modules, so the blanket src.* allowance handed both to every mod -- and they
-- hand back, in full, the two capabilities every other rule in this file
-- exists to take away:
--
--     require("src.core.HostShell").popen("...")        -- io.popen, verbatim
--     require("src.net.Fetch").download(url, saveRel)   -- the wire, and a
--                                                       -- write into saves
--
-- `io` and `src.link.Net` are refused three checks above, which is what makes
-- this a hole rather than a policy: the boundary is stated absolutely and
-- these two walk straight through it.  0.2.9 widened the same seam again with
-- src/sync/* (an HTTP client taking an arbitrary baseUrl) and IssueReport
-- (io.popen plus love.system.openURL).
--
-- On iOS neither reaches anything -- there is no curl and io.popen is not
-- there -- but the Mac app ships the same payload with both, and "the
-- platform happens to be missing the tool" is not a sandbox.
do
  local quiet = Sandbox.envFor({ modId = "QUIET_MOD", permissions = {} })
  for _, name in ipairs({ "src.core.HostShell", "src.ui.kit.FileBrowser", "src.net.Fetch",
                          "src.net.fetch_worker", "src.sync.SyncClient",
                          "src.sync.SyncTransport", "src.sync.SyncEngine",
                          "src.core.IssueReport" }) do
    check(not pcall(quiet.require, name),
      name .. " is refused to mods: it reaches the host shell or the wire")
  end
  -- Same placement rule as PHOSPHOR (8) and (10): ten engine tests require
  -- HostShell at file scope from outside src/, so a rule in moduleDenial
  -- would refuse the engine's own suite.
  eq(Sandbox.moduleDenial("src.core.HostShell", {}), nil,
    "...and moduleDenial stays out of it, so engine code and its tests can "
    .. "still reach the shell")
  -- The properties, not the names: if a pin moves these capabilities onto
  -- other modules, these are the assertions that should start failing.
  local HostShell = require("src.core.HostShell")
  check(type(HostShell.popen) == "function",
    "HostShell.popen still exists at this pin -- if it is gone, re-read "
    .. "whether the denial above is still the right shape")
  local Fetch = require("src.net.Fetch")
  check(type(Fetch.download) == "function" and type(Fetch.request) == "function",
    "Fetch still fetches at this pin -- same re-read if it stops")
end

-- the engine's own code stays reachable: a sandbox that breaks every mod
-- protects nobody, and `engine_internals` exists for exactly this
eq(Sandbox.moduleDenial("src.mods.Semver", {}), nil,
  "require('src.mods.Semver') is allowed -- mods build on the engine")
check(pcall(env.require, "src.mods.Semver"),
  "...and it really resolves through the sandboxed require")

-- ------- the love facade

check(type(env.love.graphics) == "table",
  "love.graphics passes through -- drawing is the point of a render mod")
for _, blocked in ipairs({ "filesystem", "thread", "event" }) do
  check(not pcall(function() return env.love[blocked] end),
    "love." .. blocked .. " is refused by the facade")
end
check(not pcall(function() env.love.filesystem = {} end),
  "a mod cannot assign into the love facade")

-- ------- love.system is NARROWED, not dropped
--
-- It was dropped, for openURL alone, and that cost every mod the ability to
-- ask what device it is on. `getOS() == "iOS"` is how a mod picks a touch
-- control scheme, so denying it did not make these mods safe -- it made them
-- run their DESKTOP scheme on a phone. See the note in src/mods/Sandbox.lua.

-- The exact defensive idiom the voxel mods write. It matters that this is
-- one expression: the facade RAISES on a blocked module, so `love.system and`
-- used to throw on the first term rather than short-circuiting, and the mod
-- failed to load outright instead of degrading.
local okIdiom, ranIdiom = pcall(function()
  return env.love.system and env.love.system.getOS and env.love.system.getOS()
end)
check(okIdiom, "the `love.system and love.system.getOS and ...` idiom survives")
check(type(ranIdiom) == "string" and #ranIdiom > 0,
  "and answers a real OS name, so a mod can detect iOS")

for _, open in ipairs({ "getOS", "getPowerInfo", "getProcessorCount", "vibrate" }) do
  check(pcall(function() return env.love.system[open] end),
    "love.system." .. open .. " is open: read-only device facts")
end

-- The member the module was dropped for, and the two that are the player's.
for _, shut in ipairs({ "openURL", "getClipboardText", "setClipboardText" }) do
  local ok, err = pcall(function() return env.love.system[shut] end)
  check(not ok, "love.system." .. shut .. " stays refused")
  check(type(err) == "string" and err:find("love.system." .. shut, 1, true),
    "...and the error names the member, not just the module")
end

-- Default-DENY inside a narrowed module, unlike the module-level rule: we
-- narrowed this one because it held an escape, so an unknown future member is
-- unknown risk rather than a convenience.
check(not pcall(function() return env.love.system.someFutureEscape end),
  "a member LOVE adds later is denied until it is listed by hand")
check(not pcall(function() env.love.system.openURL = function() end end),
  "and a mod cannot write its way past the narrowing")

-- ------- load(): compiles INTO the sandbox, and never from bytecode

local compiled = env.load("return ffi, io, require and 'has-require', _G")
check(type(compiled) == "function", "load() compiles for mods")
local cf, ci, cr, cg = compiled()
check(cf == nil and ci == nil, "code a mod compiles is confined too")
check(cr == "has-require", "...and still has the sandbox's own require")
check(cg == env, "...and shares the mod's own globals table")

local BYTECODE = string.dump(function() return "escaped" end)
eq(BYTECODE:byte(1), 27, "string.dump really produces a 0x1B binary chunk")
local bad, bytecodeErr = env.load(BYTECODE)
check(bad == nil and tostring(bytecodeErr):find("bytecode", 1, true),
  "precompiled bytecode is refused: " .. tostring(bytecodeErr))

-- ------- bind()/available() fail CLOSED  (PHOSPHOR 4)
--
-- Upstream's exported bind is `if setfenv then setfenv(chunk, env) end;
-- return chunk` -- on a Lua with neither setfenv nor a usable debug library
-- it hands back an UNBOUND chunk and reports success.  Every caller then runs
-- mod code against the real globals believing it confined it.

local rawCompile = load or loadstring
local spy = rawCompile("return ffi, io, package")
check(Sandbox.bind(spy, env) == spy, "bind returns the chunk it confined")
local a, b, c = spy()
check(a == nil and b == nil and c == nil,
  "a bound chunk sees the sandbox, not the real globals")

do
  local realSetfenv, realDebug = _G.setfenv, _G.debug
  _G.setfenv, _G.debug = nil, nil
  check(Sandbox.available() == false,
    "available() is false on a Lua that can confine nothing")
  local chunk, reason = Sandbox.bind(rawCompile("return io"), {})
  check(chunk == nil and type(reason) == "string",
    "...and bind returns nil + a reason there rather than an unbound chunk")
  _G.setfenv, _G.debug = realSetfenv, realDebug
end

-- Loader:_loadMod turns that false into a refusal rather than a plain load.
do
  local src = io.open("src/mods/Loader.lua", "r")
  local body = src and src:read("*a")
  if src then src:close() end
  check(body and body:find("Sandbox.available", 1, true)
          and body:find("refusing to load", 1, true),
    "Loader:_loadMod refuses a mod outright when the host cannot confine it")
end

-- ------- print is attributed to the mod  (PHOSPHOR 6)

local logLines = {}
local logged = Sandbox.envFor({ modId = "LOUD_MOD",
  log = { info = function(_, fmt, ...) logLines[#logLines + 1] = fmt:format(...) end } })
logged.print("hello", 42)
eq(logLines[1], "hello\t42", "print routes to the mod's own logger")

local before = #Logger.history
env.print("unattributed")
check(#Logger.history > before
        and tostring(Logger.history[#Logger.history]):find("TEST_MOD", 1, true),
  "...and without a logger it still lands attributed in the engine log, "
  .. "never a bare stdout line nobody reads on a phone")

-- ------- the path grammar (upstream's SafePath, which the overlay ships as-is)

for _, badPath in ipairs({ "../x", "a/../../x", "/etc/hosts", "C:/Windows/x",
                           "..\\x", "a\\b", "..", ".", "" }) do
  eq(SafePath.safe(badPath), nil, ("SafePath rejects %q"):format(badPath))
end
eq(SafePath.safe("data/note.txt"), "data/note.txt", "an ordinary relative path passes")
eq(SafePath.safe("./main.lua"), "main.lua", "a leading ./ is normalized, not rejected")

-- ------- every options_schema load site compiles through the sandbox
--
-- THIS IS THE TRIPWIRE, and it is the one check here nothing else in either
-- tree performs.  An options_schema is mod-authored Lua that the ENGINE loads
-- directly -- Loader:_loadMod never sees it -- so every surface that reads one
-- is its own chance to run a downloaded mod's code against the real globals.
-- Upstream has grown three such sites and sandboxes two of them; the launcher
-- gear is still unguarded upstream at this pin, which is why
-- src/import/LauncherSettings.lua is in the overlay at all.  A FOURTH
-- appearing in a pin bump has to fail here rather than ship.

local SCHEMA_SITES = {
  "src/mods/Loader.lua",
  "src/mods/ManagerState.lua",
  "src/import/LauncherSettings.lua",
}
local function readFile(p)
  local f = io.open(p, "r")
  if not f then return nil end
  local s = f:read("*a")
  f:close()
  return s
end
local known = {}
for _, rel in ipairs(SCHEMA_SITES) do
  known[rel] = true
  local src = readFile(rel)
  check(src ~= nil, "options_schema site is readable: " .. rel)
  if src then
    check(src:find("Sandbox.loadFile", 1, true) ~= nil,
      rel .. " compiles the options_schema through Sandbox.loadFile")
  end
end

-- Any file that both NAMES options_schema and compiles something near it is a
-- schema site whether it meant to be or not.  Matched on the compile
-- primitive rather than one call shape, because the call shape is exactly
-- what a refactor changes: upstream's sites went from
-- `fs.load(path .. "/" .. m.options_schema)` to a SafePath.join two lines
-- above a Sandbox.loadFile in these very 32 commits.
local COMPILERS = { "%f[%w]load%s*%(", "%f[%w]loadstring%s*%(", "%f[%w]dofile%s*%(" }
local pipe = io.popen([[grep -rl 'options_schema' src/ 2>/dev/null]])
if pipe then
  for line in pipe:lines() do
    local rel = line:gsub("^%./", "")
    local src = readFile(rel)
    if src then
      -- Comment lines are blanked, not read: src/mods/Sandbox.lua's own
      -- header names an options_schema as an example of what it confines,
      -- and prose about a hazard is not the hazard.
      local lines = {}
      for one in (src .. "\n"):gmatch("([^\n]*)\n") do
        lines[#lines + 1] = one:match("^%s*%-%-") and "" or one
      end
      local compilesNearby = false
      for i, text in ipairs(lines) do
        if text:find("options_schema", 1, true) then
          for j = math.max(1, i - 8), math.min(#lines, i + 8) do
            for _, pattern in ipairs(COMPILERS) do
              if lines[j]:find(pattern) then compilesNearby = true end
            end
          end
        end
      end
      if compilesNearby then
        check(known[rel] == true,
          "a surface that compiles an options_schema is a known, sandboxed "
          .. "one: " .. rel)
      end
    end
  end
  pipe:close()
end

-- ------- end to end, through the real Loader
--
-- The checks above are about the environment in isolation.  These drive
-- Loader:load the way a boot does, because the two escapes that were open
-- against the OLD overlay were both reachable only through the loader: a
-- bytecode entry chunk executed, and mod:read walked out of the mod folder.

local Loader = require("src.mods.Loader")
local Runtime = require("src.mods.Runtime")
local savedEvents, savedHooks = Runtime.events, Runtime.hooks

-- Normalizing, the way a real filesystem is.  PhysFS refuses ".." on its own,
-- but loader.fs is injectable and has no such floor -- which is the entire
-- reason the rule lives in SafePath.  A memfs that treats "a/../b" as a
-- literal key would pass this test by accident.
local function normalize(path)
  local parts = {}
  for segment in tostring(path):gmatch("[^/]+") do
    if segment == ".." then
      if #parts > 0 then parts[#parts] = nil end
    elseif segment ~= "." then
      parts[#parts + 1] = segment
    end
  end
  return table.concat(parts, "/")
end

local function memfs(files)
  local fs
  fs = {
    read = function(path) return files[normalize(path)] end,
    write = function(path, body) files[normalize(path)] = body return true end,
    remove = function(path) files[normalize(path)] = nil return true end,
    createDirectory = function() return true end,
    getInfo = function(path)
      path = normalize(path)
      if files[path] then return { type = "file" } end
      local prefix = path .. "/"
      for key in pairs(files) do
        if key:sub(1, #prefix) == prefix then return { type = "directory" } end
      end
      return nil
    end,
    load = function(path)
      local body = files[normalize(path)]
      if not body then return nil, "no file: " .. tostring(path) end
      return (load or loadstring)(body, "@" .. tostring(path))
    end,
    getDirectoryItems = function(path)
      local prefix, seen, out = normalize(path) .. "/", {}, {}
      for key in pairs(files) do
        if key:sub(1, #prefix) == prefix then
          local child = key:sub(#prefix + 1):match("^[^/]+")
          if child and not seen[child] then
            seen[child] = true
            out[#out + 1] = child
          end
        end
      end
      table.sort(out)
      return out
    end,
  }
  return fs
end

local function manifest(id)
  return ('{"id":"%s","name":"%s","version":"1.0.0",'):format(id, id)
    .. '"entry":"main.lua","api":2,"profile":"content"}'
end

-- ESCAPE 1: a mod's entry file that is a precompiled binary chunk.  Against
-- the old overlay this LOADED and RAN: Loader:_loadMod handed the path to
-- fs.load, which compiles bytecode happily, and only the load() a mod calls
-- itself checked the 0x1B header.
do
  -- Observed through mod.exports, NOT through _G.  A sandboxed entry chunk's
  -- `_G.X = true` lands in its own globals table, so a _G probe reports "it
  -- never ran" for a chunk that ran perfectly well -- which is how this
  -- escape stayed invisible.
  local files = {
    ["mods/bytecode_mod/manifest.json"] = manifest("bytecode_mod"),
    ["mods/bytecode_mod/main.lua"] = string.dump(function(mod)
      mod.exports.ran = true
    end),
  }
  eq(files["mods/bytecode_mod/main.lua"]:byte(1), 27,
    "the fixture entry chunk really is a binary chunk")
  local loader = Loader.new({ fs = memfs(files), generation = 1 })
  check(loader:load({}) == false, "a mod whose entry file is bytecode fails to load")
  check(tostring(loader.errors[1] or ""):find("bytecode", 1, true) ~= nil,
    "...and says why: " .. tostring(loader.errors[1]))
  eq(((loader.exports or {}).bytecode_mod or {}).ran, nil,
    "...and the binary chunk never executed")
end

-- ESCAPE 2: mod:read walking out of the mod directory.  Against the old
-- overlay `mod.path .. "/" .. relative` was handed straight to the injected
-- fs, so "../../secret.txt" read whatever was there.
local PROBE_MOD = [[
return function(mod)
  local function attempt(fn, ...)
    local ok, err = pcall(fn, ...)
    if ok then return { escaped = true, value = err } end
    return { escaped = false, message = tostring(err) }
  end
  mod.exports.readEscape = attempt(function() return mod:read("../../secret.txt") end)
  mod.exports.readAbsolute = attempt(function() return mod:read("/secret.txt") end)
  mod.exports.readBackslash = attempt(function() return mod:read("..\\secret.txt") end)
  mod.exports.assetsEscape = attempt(function() return mod.assets:path("../../x.png") end)
  mod.exports.readOwn = mod:read("data/note.txt")
  mod.exports.confined = {
    ffiAbsent = (ffi == nil),
    -- io and package are LegacyCompat's stand-ins now, so the property is
    -- no longer "nil", it is "not the real one and cannot reach out"
    ioHasNoRealOpen = (io ~= nil and io.popen() == nil),
    packageIsInert = (package ~= nil and package.loadlib == nil
                        and next(package.loaded) == nil),
  }
  -- every spelling of "read the player's save" through the legacy surface
  local function readVia(fn) local ok, v = pcall(fn) return ok and v or nil end
  mod.exports.legacyReads = {
    lfsPlain = readVia(function() return (love.filesystem.read("secret.txt")) end),
    lfsClimb = readVia(function() return (love.filesystem.read("../../secret.txt")) end),
    lfsAbsolute = readVia(function() return (love.filesystem.read("/secret.txt")) end),
    lfsOtherMod = readVia(function() return (love.filesystem.read("mods/other/private.txt")) end),
    lfsViaOwnPrefix = readVia(function()
      return (love.filesystem.read("mods/probe/../../secret.txt")) end),
    ioPlain = readVia(function() local f = io.open("secret.txt", "r") return f and f:read("*a") end),
    ioClimb = readVia(function() local f = io.open("../../secret.txt", "r") return f and f:read("*a") end),
    requiredLfs = readVia(function() return (require("love.filesystem").read("secret.txt")) end),
    loadfileClimb = readVia(function() return (loadfile("../../secret.txt")) end),
    listRoot = readVia(function() return #love.filesystem.getDirectoryItems("") end),
  }
  mod.exports.legacyOwnRead = love.filesystem.read("mods/probe/data/note.txt")
  mod.exports.legacyOwnReadRelative = love.filesystem.read("data/note.txt")
  -- ...and every spelling of "overwrite it"
  love.filesystem.write("secret.txt", "OVERWRITTEN")
  love.filesystem.write("../../secret.txt", "OVERWRITTEN")
  love.filesystem.write("mods/other/private.txt", "OVERWRITTEN")
  do local f = io.open("/secret.txt", "w") if f then f:write("OVERWRITTEN") f:close() end end
  mod.exports.legacyReadBack = love.filesystem.read("secret.txt")
  os.remove("secret.txt")
  os.rename("../../secret.txt", "gone.txt")
  -- bytecode through the legacy loaders
  love.filesystem.write("evil.luac", string.dump(function() return "ran" end))
  mod.exports.legacyBytecode = {
    viaLoad = attempt(function() return assert(love.filesystem.load("evil.luac"))() end),
    viaLoadfile = attempt(function() return assert(loadfile("evil.luac"))() end),
    viaDofile = attempt(function() return dofile("evil.luac") end),
  }
  -- a chunk loaded the legacy way is born in THIS environment
  love.filesystem.write("plain.lua", "return { io = io, ffi = ffi, real = (getfenv ~= nil) }")
  mod.exports.legacyChunk = love.filesystem.load("plain.lua")()
  mod.exports.legacyRefusals = {
    execute = os.execute("true"), exit = os.exit(0),
    popen = io.popen("true"), quit = love.event.quit(),
    pushQuit = love.event.push("quit"),
    pushIntent = love.event.push("intent_uri", "gen1recomp://launch?game=gold"),
    openURL = love.system.openURL("https://example.test"),
    clipboard = love.system.getClipboardText(),
    tls = love.system.tlsOpen,
    mount = love.filesystem.mount("/", "everything"),
    saveDir = love.filesystem.getSaveDirectory(),
    home = os.getenv("HOME"), path = os.getenv("PATH"),
  }
  -- callbacks: an ordinary one lands, the engine's own two do not, and a
  -- pointer name goes to the bridge rather than the real table
  love.keypressed = function() return "mod" end
  mod.exports.legacyAssign = {
    run = attempt(function() love.run = function() end end),
    errorhandler = attempt(function() love.errorhandler = function() end end),
    module = attempt(function() love.graphics = {} end),
    pointer = attempt(function() love.mousemoved = function() end end),
  }
  mod.exports.requireLove = attempt(function() return require("love") end)
  mod.exports.requireSocket = attempt(function() return require("socket") end)
  mod.exports.requireJitUtil = attempt(function() return require("jit.util") end)
  mod.exports.requireOwnFile = attempt(function() return require("mods.probe.payload") end)
  _G.PHOSPHOR_SANDBOX_ESCAPE = "escaped"
end
]]

do
  local files = {
    ["secret.txt"] = "THE PLAYER'S SAVE",
    ["mods/other/private.txt"] = "ANOTHER MOD'S FILE",
    ["mods/probe/manifest.json"] = manifest("probe"),
    ["mods/probe/main.lua"] = PROBE_MOD,
    ["mods/probe/payload.lua"] =
      "return { io = io, package = package, ffi = ffi, name = ... }",
    ["mods/probe/data/note.txt"] = "own file",
  }
  local fs = memfs(files)
  eq(fs.read("mods/probe/../../secret.txt"), "THE PLAYER'S SAVE",
    "the fixture filesystem really does resolve '..', so a refusal below is "
    .. "SafePath's doing and not the harness getting lucky")

  -- The stub has neither of these, and "nil because the stub never had it"
  -- would pass with the hardening deleted. Give the host both, the way
  -- upstream's native build has them, so the checks below can fail.
  local pushed = {}
  local hadSystem, hadEvent = _G.love.system, _G.love.event
  _G.love.system = setmetatable({ tlsOpen = function() return "A SOCKET" end },
    { __index = hadSystem })
  _G.love.event = setmetatable({
    push = function(name) pushed[#pushed + 1] = name return true end,
  }, { __index = hadEvent })

  local loader = Loader.new({ fs = fs, generation = 1 })
  check(loader:load({}) == true,
    "the probe mod loads: " .. tostring(loader.errors[1]))
  _G.love.system, _G.love.event = hadSystem, hadEvent
  local out = loader.exports.probe or {}
  eq(table.concat(pushed, ","), "",
    "neither quit nor the host's launch intent reached the real love.event")

  check(out.readEscape and out.readEscape.escaped == false
          and out.readEscape.message:find("must stay inside", 1, true),
    "mod:read cannot climb out of the mod directory: "
    .. tostring(out.readEscape and (out.readEscape.value or out.readEscape.message)))
  check(out.readAbsolute and out.readAbsolute.escaped == false,
    "mod:read refuses an absolute path")
  check(out.readBackslash and out.readBackslash.escaped == false,
    "mod:read refuses a backslash climb")
  check(out.assetsEscape and out.assetsEscape.escaped == false,
    "mod.assets:path refuses a climb")
  eq(out.readOwn, "own file", "and the mod's own files still read")

  check(out.confined and out.confined.ffiAbsent and out.confined.ioHasNoRealOpen
          and out.confined.packageIsInert,
    "the entry chunk that published these exports really was confined")

  -- ------- PHOSPHOR: the legacy surface (upstream's LegacyCompat), driven
  -- from inside a real mod through the real Loader. It exists so mods written
  -- before the sandbox keep working; these are the things it must not become.
  local reads = out.legacyReads or {}
  for _, spelling in ipairs({ "lfsPlain", "lfsClimb", "lfsAbsolute", "lfsOtherMod",
                              "lfsViaOwnPrefix", "ioPlain", "ioClimb",
                              "requiredLfs", "loadfileClimb" }) do
    check(reads[spelling] == nil,
      "the legacy filesystem cannot read outside the mod (" .. spelling .. "): "
      .. tostring(reads[spelling]))
  end
  eq(out.legacyOwnRead, "own file", "it DOES read the mod's own files, by full path")
  eq(out.legacyOwnReadRelative, "own file", "and relative to the mod, as mods spell it")
  eq(files["secret.txt"], "THE PLAYER'S SAVE",
    "no legacy write, remove or rename touched the player's file")
  eq(files["mods/other/private.txt"], "ANOTHER MOD'S FILE",
    "nor another mod's")
  eq(out.legacyReadBack, "OVERWRITTEN",
    "the mod reads back what it wrote: its writes landed in its own overlay")
  do
    local outside = {}
    for path in pairs(files) do
      if path ~= "secret.txt" and path:sub(1, 5) ~= "mods/"
          and path:sub(1, #"mod_compat/probe/") ~= "mod_compat/probe/"
          and not path:find("options", 1, true) and not path:find("mod_state", 1, true) then
        outside[#outside + 1] = path
      end
    end
    table.sort(outside)
    eq(table.concat(outside, ", "), "",
      "every legacy write landed under mod_compat/probe/ and nowhere else")
  end
  for how, result in pairs(out.legacyBytecode or {}) do
    check(result.escaped == false, "bytecode is refused through the legacy loader " .. how)
  end
  check(next(out.legacyBytecode or {}) ~= nil, "the bytecode probes ran")
  local chunk = out.legacyChunk or {}
  check(chunk.ffi == nil and chunk.real == false and chunk.io ~= io,
    "a chunk loaded through love.filesystem.load is born inside the sandbox")
  local refused = out.legacyRefusals or {}
  check(not refused.execute and not refused.exit and refused.popen == nil,
    "os.execute, os.exit and io.popen do nothing")
  check(not refused.quit and not refused.pushQuit,
    "a mod cannot quit the game, by either spelling")
  check(refused.pushIntent == false,
    "nor push the host's launch intent and switch games on the player")
  check(not refused.openURL and refused.clipboard == "",
    "openURL and the clipboard are stubs")
  check(refused.tls == nil, "upstream's TLS forward is removed: no network by another name")
  check(refused.mount == false, "mount is refused")
  eq(refused.saveDir, "/pokeport/probe", "the save directory is a virtual path")
  eq(refused.home, "/pokeport/probe", "HOME is the same virtual path")
  eq(refused.path, nil, "and the real environment is hidden")
  local assign = out.legacyAssign or {}
  check(type(rawget(_G.love, "keypressed")) == "function"
          and _G.love.keypressed() == "mod",
    "an ordinary callback assignment lands, as it does on every other host")
  _G.love.keypressed = nil
  check(assign.run and assign.run.escaped == false
          and assign.errorhandler and assign.errorhandler.escaped == false,
    "love.run and love.errorhandler stay the engine's")
  check(assign.module and assign.module.escaped == false,
    "a module table cannot be replaced")
  check(assign.pointer and assign.pointer.escaped ~= false
          and rawget(_G.love, "mousemoved") == nil,
    "a pointer name is accepted and STILL never reaches the real love table")
  eq(_G.PHOSPHOR_SANDBOX_ESCAPE, nil,
    "a mod's `_G.X = ...` never reaches the engine's globals")

  check(out.requireLove and out.requireLove.escaped == false,
    "require('love') from inside a real mod is refused")
  check(out.requireSocket and out.requireSocket.escaped == false,
    "require('socket') from inside a real mod is refused")
  check(out.requireJitUtil and out.requireJitUtil.escaped == false,
    "require('jit.util') from inside a real mod is refused")
  -- A mod's own second file LOADS now (it is how every multi-file mod is
  -- written), but through Sandbox.loadFile, never the real require. The
  -- property under test is therefore not "refused" but "confined": the chunk
  -- must come up against the sandbox globals, exactly like the entry chunk.
  check(out.requireOwnFile and out.requireOwnFile.escaped ~= false,
    "a mod CAN require its own second file: "
    .. tostring(out.requireOwnFile and out.requireOwnFile.message))
  local payload = out.requireOwnFile and out.requireOwnFile.value
  -- io and package are the stand-ins now; "inside the sandbox" means it got
  -- THOSE, not the real tables, and still no ffi.
  check(type(payload) == "table" and payload.ffi == nil
          and payload.io ~= io and payload.package ~= package
          and type(payload.io) == "table" and payload.io.popen() == nil,
    "and that file is born INSIDE the sandbox, not against the real globals")
  eq(type(payload) == "table" and payload.name or nil, "mods.probe.payload",
    "and receives its module name, the way require does")
end


-- ------- the pointer bridge: a legacy pointer assignment is translated
--
-- The ONE place Phosphor is deliberately looser than the flat refusal it
-- shipped with.  It grants no new capability: Hooks:wrap has no name
-- allow-list, so a mod can already subscribe to input.pointer itself, and
-- nothing here ever writes _G.love.  See
-- docs/superpowers/specs/2026-08-25-mod-pointer-bridge-design.md.

local PointerBridge = require("src.mods.PointerBridge")

do
  PointerBridge.reset()
  local wrapped = {}
  local fakeHooks = {
    wrap = function(_, name, cb, priority, owner)
      wrapped[#wrapped + 1] = { name = name, cb = cb, owner = owner }
      return function() end
    end,
  }
  local bridge = PointerBridge.new({ modId = "PB_MOD", hooks = fakeHooks })

  check(type(bridge.assign) == "function", "bridge exposes assign")
  check(type(bridge.globals) == "table" and next(bridge.globals) == nil,
    "bridge.globals is empty: no dofile/loadfile reaches a mod")
  check(type(bridge.os) == "table" and next(bridge.os) == nil,
    "bridge.os is empty: os stays clock-only")
  -- Reads of a translated name answer with a no-op, so the pre-sandbox
  -- `local old = love.mousemoved ... return old(...)` convention terminates
  -- instead of re-entering the engine's own handler. Nil would fall through
  -- to _G.love in loveFacade.__index, which is the crash.
  eq(type(bridge.love.mousemoved), "function",
    "a translated name reads back as a no-op, not the engine's handler")
  check(bridge.love.mousemoved ~= rawget(_G.love, "mousemoved"),
    "and specifically NOT the engine's live love.mousemoved")
  check(bridge.love.draw == nil,
    "an untranslated name has no override: love.draw still reads normally")
  check(bridge.module("io") == nil,
    'bridge reroutes no modules: require("io") still refuses')

  local ok, reason = bridge.assign("draw", function() end)
  check(ok == false, "love.draw is still refused")
  check(type(reason) == "string" and reason:find("input.pointer", 1, true),
    "the refusal names input.pointer instead of a flat denial")

  check(bridge.assign("wheelmoved", function() end) == false,
    "wheelmoved is refused: there is no input.pointer phase for a wheel")

  -- The contract between this module and Sandbox's __newindex, pinned
  -- because it spans two files and getting it wrong is silent: `true` there
  -- means "write it to _G.love", which on iOS would clobber the overlay's
  -- own love.mousemoved and take the virtual pad with it.
  eq(bridge.assign("mousemoved", function() end), "handled",
    'a translated assignment answers "handled", never true')
end


do
  PointerBridge.reset()
  local chain = {}
  local fakeHooks = {
    wrap = function(_, name, cb, priority, owner)
      chain[#chain + 1] = { name = name, cb = cb, owner = owner }
      return function() end
    end,
  }
  local bridge = PointerBridge.new({ modId = "PB_MOD", hooks = fakeHooks })
  local seen = {}

  bridge.assign("mousemoved", function(x, y, dx, dy, istouch)
    seen[#seen + 1] = { "mousemoved", x, y, dx, dy, istouch }
  end)
  eq(#chain, 1, "the first pointer assignment opens one input.pointer wrap")
  eq(chain[1].name, "input.pointer", "it subscribes to input.pointer")
  eq(chain[1].owner, "PB_MOD", "owned by the mod, so removeOwner detaches it")

  bridge.assign("touchmoved", function(id, x, y, dx, dy)
    seen[#seen + 1] = { "touchmoved", id, x, y, dx, dy }
  end)
  eq(#chain, 1, "a second assignment reuses the one subscription")

  check(rawget(_G.love, "mousemoved") == nil,
    "nothing the mod assigned ever reached _G.love")

  local ranVanilla = false
  local function nextFn() ranVanilla = true return "downstream" end

  local out = chain[1].cb(nextFn, {}, {
    phase = "moved", source = "mouse", id = "mouse",
    x = 10, y = 20, dx = 1, dy = 2 })
  eq(seen[1][1], "mousemoved", "a mouse-sourced move calls the mouse handler")
  eq(seen[1][2], 10, "x is passed positionally")
  eq(seen[1][5], 2, "dy is passed positionally")
  eq(seen[1][6], false, "istouch is false on the mouse path")
  check(ranVanilla, "the link called next, so vanilla still ran")
  eq(out, "downstream", "the link returns what next returned")

  chain[1].cb(nextFn, {}, {
    phase = "moved", source = "touch", id = 7, x = 3, y = 4, dx = 0, dy = 0 })
  eq(seen[2][1], "touchmoved", "a touch-sourced move calls the touch handler")
  eq(seen[2][2], 7, "the touch id is passed first, as the legacy shape has it")

  -- "cancelled" must reach the mod as a release, or a camera keeps turning
  -- after the finger is gone
  bridge.assign("touchreleased", function(id)
    seen[#seen + 1] = { "touchreleased", id }
  end)
  chain[1].cb(nextFn, {}, {
    phase = "cancelled", source = "touch", id = 7, x = 3, y = 4, dx = 0, dy = 0 })
  eq(seen[3][1], "touchreleased", "a cancelled pointer arrives as a release")

  -- a handler that returns true must NOT be able to suppress the engine
  ranVanilla = false
  local greedy = PointerBridge.new({ modId = "GREEDY", hooks = fakeHooks })
  greedy.assign("mousemoved", function() return true end)
  chain[#chain].cb(nextFn, {}, { phase = "moved", source = "mouse",
    id = "mouse", x = 0, y = 0, dx = 0, dy = 0 })
  check(ranVanilla,
    "a legacy handler returning true is not a claim: vanilla still ran")

  -- an unmapped phase must still continue the chain
  ranVanilla = false
  chain[1].cb(nextFn, {}, { phase = "hovered", source = "mouse",
    id = "mouse", x = 0, y = 0, dx = 0, dy = 0 })
  check(ranVanilla, "an unknown phase still calls next")

  eq(PointerBridge.report("PB_MOD").mousemoved, true,
    "the report records which legacy names a mod used")
end


-- ...and through a REAL sandbox env, which is what Loader:_modEnv builds.
-- This is the regression guard for anyone who later edits Sandbox.lua's
-- __newindex: the facade must keep routing assignments through compat.assign
-- and keep propagating the reason it hands back.
do
  PointerBridge.reset()
  local env = Sandbox.envFor({
    modId = "PB_E2E",
    compat = PointerBridge.new({
      modId = "PB_E2E",
      hooks = { wrap = function() return function() end end },
    }),
  })

  local ok = pcall(function() env.love.mousemoved = function() end end)
  check(ok, "assigning love.mousemoved through a real sandbox env succeeds")
  check(rawget(_G.love, "mousemoved") == nil,
    "and STILL nothing reached _G.love, through the real facade")

  local ok2, err = pcall(function() env.love.draw = function() end end)
  check(not ok2, "love.draw still throws through the real facade")
  check(tostring(err):find("input.pointer", 1, true),
    "and the thrown message names input.pointer")

  check(env.io == nil and env.dofile == nil,
    "the bridge contributed no io and no dofile: this is not LegacyCompat")
  check(env.os.getenv == nil and env.os.execute == nil,
    "and os is still clock-only")
end


-- ------- the loop a device found and every test above missed
--
-- On iOS SDL synthesizes a mouse event from the primary touch, so the mod's
-- handler is invoked from INSIDE love.mousemoved -> Game:mousemoved ->
-- pointerEvent -> hooks.  The pre-sandbox convention is
--   local old = love.mousemoved
--   love.mousemoved = function(...) ...; return old(...) end
-- and upstream that is harmless, because the mod's function REPLACES the
-- engine's and `old` runs once.  Here it re-enters the same path, once per
-- finger movement, until the stack goes.
--
-- The checks below drive the REAL love.mousemoved rather than calling
-- dispatch directly, which is the only reason they can see it.
do
  PointerBridge.reset()
  local Hooks = require("src.mods.Hooks")
  local hooks = setmetatable({ chains = {} }, { __index = Hooks })

  local depth, maxDepth = 0, 0
  local savedMouseMoved = rawget(_G.love, "mousemoved")
  local function pointerUnclaimed() return false end
  _G.love.mousemoved = function(x, y, dx, dy)
    depth = depth + 1
    if depth > maxDepth then maxDepth = depth end
    if depth > 50 then depth = depth - 1; error("RUNAWAY RECURSION", 0) end
    local r = hooks:call("input.pointer", pointerUnclaimed, {}, {
      phase = "moved", source = "mouse", id = "mouse",
      x = x, y = y, dx = dx or 0, dy = dy or 0 })
    depth = depth - 1
    return r
  end

  local env = Sandbox.envFor({
    modId = "CAM",
    compat = PointerBridge.new({ modId = "CAM", hooks = hooks }),
  })

  -- the mod, written exactly the way a pre-sandbox mod is written
  local ran = 0
  local old = env.love.mousemoved
  env.love.mousemoved = function(x, y, dx, dy, istouch)
    ran = ran + 1
    if old then return old(x, y, dx, dy, istouch) end
  end

  _G.love.mousemoved(10, 20, 1, 2)
  eq(maxDepth, 1, "chaining to the captured handler does NOT re-enter the "
    .. "pointer path (a device crash: maxDepth ran to the stack limit)")
  eq(ran, 1, "and the mod's handler still ran, exactly once")

  _G.love.mousemoved = savedMouseMoved
end


-- The no-op above closes the route a real mod took. This pins the backstop
-- for every other one: a handler that re-enters the pointer path by any
-- means at all must not be re-entered itself. Without the depth guard this
-- recurses even though the no-op is in place, so it is a separate check
-- rather than a second assertion on the same behaviour.
do
  PointerBridge.reset()
  local Hooks = require("src.mods.Hooks")
  local hooks = setmetatable({ chains = {} }, { __index = Hooks })

  local depth, maxDepth = 0, 0
  local savedMouseMoved = rawget(_G.love, "mousemoved")
  local function pointerUnclaimed() return false end
  _G.love.mousemoved = function(x, y, dx, dy)
    depth = depth + 1
    if depth > maxDepth then maxDepth = depth end
    if depth > 50 then depth = depth - 1; error("RUNAWAY RECURSION", 0) end
    local r = hooks:call("input.pointer", pointerUnclaimed, {}, {
      phase = "moved", source = "mouse", id = "mouse",
      x = x, y = y, dx = dx or 0, dy = dy or 0 })
    depth = depth - 1
    return r
  end

  local bridge = PointerBridge.new({ modId = "PUMP", hooks = hooks })
  local ran = 0
  bridge.assign("mousemoved", function(x, y, dx, dy)
    ran = ran + 1
    -- not the captured `old` -- a handler reaching the engine any other way
    _G.love.mousemoved(x, y, dx, dy)
  end)

  _G.love.mousemoved(1, 2, 3, 4)
  eq(ran, 1, "a handler that re-enters the pointer path is not re-entered")
  check(maxDepth <= 2,
    "and the re-entry is contained rather than recursing (got depth "
    .. tostring(maxDepth) .. ")")

  -- and the counter survives a throwing handler, or the mod goes deaf
  PointerBridge.reset()
  local b2 = PointerBridge.new({ modId = "THROWS", hooks = hooks })
  local calls = 0
  b2.assign("mousemoved", function() calls = calls + 1; error("boom", 0) end)
  _G.love.mousemoved(1, 2, 3, 4)
  _G.love.mousemoved(1, 2, 3, 4)
  eq(calls, 2, "a handler that throws is still called on the NEXT event: "
    .. "the depth counter was restored, not stranded above zero")
  -- PUMP is still on this chain and re-enters on every event, so the two
  -- events above reach it too: 1 + 2 = 3, each delivered ONCE. Four would
  -- mean a mod was delivered twice for one finger movement, which is exactly
  -- what a per-bridge counter did before the guard moved to module level.
  eq(ran, 3, "the re-entering mod is delivered once per event, not twice: "
    .. "the guard is per EVENT, not per mod")

  _G.love.mousemoved = savedMouseMoved
end

-- run_tests.lua dofiles this suite into a shared process, so anything global
-- goes back the way it was found or the next suite pays for it.
Runtime.events, Runtime.hooks = savedEvents, savedHooks
Runtime.currentMod = nil
_G.PHOSPHOR_SANDBOX_ESCAPE = nil

S.finish()
