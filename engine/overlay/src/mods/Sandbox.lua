-- The environment a mod's own code runs in.  Every chunk a mod authors -- the
-- entry file, an options_schema, anything it hands to load() -- runs against
-- this table instead of _G, so the only paths it can name are the ones the
-- engine hands it (mod:read, mod.storage, mod.assets).
--
-- What this is and is not: raw io/os/ffi are the only way to name a file
-- outside the game tree at all, and they are absent here, so the reported
-- "any mod can rewrite anything in your home directory" hole closes by
-- construction.  Inside the LÖVE tree this is defense in depth, not a security
-- boundary: an engine module reached through require, or ImageData:encode,
-- still writes in the save directory.
--
-- Lua 5.1/LuaJIT is the target, so setfenv is the mechanism; the 5.2+ arm
-- exists because AssetTransform's sandbox needed it and getting this wrong
-- silently hands the chunk the real globals.
--
-- ===================================================================
-- PHOSPHOR OVERLAY.  This is UPSTREAM's file plus a thin patch.  Phosphor
-- used to ship a whitelist sandbox of its own here, written when upstream
-- had none; upstream added this one at pin 797a6bebfe and it is stricter on
-- every item that was actually exploitable, so the overlay now ADOPTS it and
-- keeps only the places Phosphor has to be tighter.  Every divergence is
-- marked `PHOSPHOR:` below so a pin bump is a re-read of eight comments
-- rather than a re-derivation.  They are:
--
--   1. no outbound network, permission or not (an App Store build does not
--      hand downloaded Lua a socket because a JSON file asked)
--   2. `jit` is not requirable -- jit.util leaks code addresses and
--      jit.dump.on(mode, outfile) writes an arbitrary host path
--   3. `require("love")` is refused, not just `require("love.*")`
--   4. bind()/available() fail CLOSED: a host that cannot confine mod code
--      refuses to run it (Loader:_loadMod), it never runs it unconfined
--   5. no collectgarbage
--   6. print() goes to the mod's own attributed log, not stdout
--   7. `require("mods.<id>.<file>")` never reaches the REAL require -- PhysFS's
--      searcher covers the save directory, so that would load a mod's own file
--      against the REAL globals and walk straight around this file.  A mod's
--      OWN submodules are instead loaded HERE, through Sandbox.loadFile, so
--      they get this environment like the entry chunk does.  Another mod's
--      files, and the bare `mods` root, stay refused outright.
--   8. `src.link.*` still follows the manifest's `network` permission
--
-- Note the shape of 1-3 and 7: this file's deny lists are a BLACKLIST, which
-- is the one thing Phosphor's old sandbox deliberately was not.  That trade
-- was taken on purpose (upstream's love facade and SafePath grammar are
-- better than what they replace, and a shared file is a file upstream also
-- maintains), but it is the thing a pin bump has to read for: a new module
-- upstream starts shipping is REACHABLE by every mod until somebody adds it
-- below.  tests/mod_sandbox_tests.lua pins what is known.
-- ===================================================================

local Logger = require("src.core.Logger")
local Runtime = require("src.mods.Runtime")
local SafePath = require("src.mods.SafePath")

local Sandbox = {}

-- Modules that hand a mod the disk, a raw socket or a fresh Lua state no
-- matter what this file removes from the environment.  package.loaded.io is
-- the one call that would undo every other rule here.
local DENIED = {
  io = "the filesystem", os = "the filesystem", debug = "the debug library",
  package = "the module loader", ffi = "arbitrary C calls",
  -- PHOSPHOR (2): jit.util hands out the address of every compiled function
  -- and jit.dump.on(mode, outfile) is an arbitrary host-path write, neither
  -- of which is reachable through the `jit` GLOBAL -- they are submodules, so
  -- only the require path can be closed.  env.jit stays as upstream has it.
  jit = "the JIT compiler internals",
  -- PHOSPHOR (7): LÖVE's PhysFS searcher has the save directory on its path,
  -- so require("mods.<id>.payload") resolves a mod's OWN Lua file through the
  -- real require -- which binds it to the REAL globals, because nothing in
  -- this file is involved in loading it.  That is a complete bypass of the
  -- sandbox using nothing but a second file in the mod's own folder.
  --
  -- Denying the root outright also broke every multi-file mod, which is most
  -- of the real ones: Crystal 251 is ~40 files under battle/ and lib/ and
  -- could not load its own extractor.  So `mods.<SELF>.*` is intercepted by
  -- sandboxedRequire BEFORE this table is consulted, and loaded through
  -- Sandbox.loadFile, which is the confined path.  Everything that reaches
  -- here -- the bare root, and any OTHER mod's files -- is still refused.
  mods = "unsandboxed access to a mod's own files",
}

-- Same idea one level up: love.filesystem is reachable by name, and
-- love.thread starts a Lua state this sandbox has no say over.  jit.util
-- is the LuaJIT-specific equal of the debug library above -- funcbc,
-- funck and friends read the bytecode and constants of any function a
-- chunk can reach, which is enough to walk back to upvalues (the real
-- _G, love, io) the rest of this file exists to keep out of reach.  The
-- bare `jit` table stays -- env.jit above hands it over directly for
-- jit.on/off/flush -- so only the submodule require is denied.
local DENIED_PREFIX = { ["love"] = true, ["ffi"] = true, ["jit"] = true }

-- The wire.
--
-- PHOSPHOR (1): upstream gates these on a manifest `"permissions":
-- ["network"]` declaration.  Phosphor does not offer that trade.  A mod is a
-- folder the player downloaded from the internet; the difference between it
-- and malware is not a line of JSON the same folder supplied, and an App
-- Store build that lets user content open sockets is not describable as a
-- game engine any more.  Denied unconditionally, permission or not.  The
-- message still names "network" so the reason a mod author sees is the real
-- one.
local NETWORK = { socket = true, enet = true, http = true, https = true,
                  ssl = true, mime = true, ltn12 = true,
                  ["lua-https"] = true }

-- PHOSPHOR (9): LÖVE's require loader (wrap_Filesystem.cpp) rewrites `.` to
-- `/` and resolves the same file either way, so `mods/<id>/x` reaches exactly
-- what `mods.<id>.x` does.  A root split only on `.` therefore sees
-- "mods/<id>/x" as one long root that matches nothing, and the slash spelling
-- walks straight past this deny list -- the same hole gen2's deniedModule
-- closes by splitting on both.  sandboxedRequire canonicalises the name it
-- holds, but moduleDenial is also called directly by Loader's _G.require
-- backstop, so the root has to be taken in both spellings here too.
local function head(name)
  return (name:match("^([^%.%/]+)")) or name
end

-- nil when the require is allowed, else the message to fail it with.
-- permissionSet is still accepted (Loader's dev-mode backstop passes it, and
-- src.link.* below reads it) even though the network arm no longer consults
-- it.
function Sandbox.moduleDenial(name, permissionSet)
  if type(name) ~= "string" then return nil end
  local root = head(name)
  local reason = DENIED[root]
  if reason then
    return ("%s is not available to mods (it grants %s); use mod.storage, "
      .. "mod:read, mod:list and the engine API instead"):format(name, reason)
  end
  -- PHOSPHOR (3): upstream reads `DENIED_PREFIX[root] and name ~= root`, so
  -- the bare name "love" fell through and require("love") handed back the
  -- REAL love table -- love.filesystem.write, love.thread.newThread and
  -- love.system.openURL included, every one of them a thing the facade below
  -- exists to take away.  The root is denied with its children.
  if DENIED_PREFIX[root] then
    return ("%s is not available to mods; use mod.storage, mod:read, mod:list "
      .. "and the engine API instead"):format(name)
  end
  if NETWORK[root] then
    return ("%s is not available to mods: this build gives mod code no "
      .. "outbound network access"):format(name)
  end
  return nil
end

-- PHOSPHOR (8): the engine's own link stack is the one place a mod could
-- reach a peer without naming a socket library, so it follows the manifest's
-- `network` permission rather than the blanket allowance the rest of src.*
-- gets.  Only these three: src/link/Net.lua is the enet/socket transport, and
-- LinkState and Tournament require it.  Fingerprint, Json, Handshake,
-- Protocol, CodeEntry, Session and LinkBattle are computation over data that
-- never opens anything, and a mod reading the link fingerprint is a
-- compatibility check, not a connection.
--
-- Deliberately NOT in moduleDenial.  Upstream's dev-mode backstop
-- (Loader.lua's _G.require shim) calls moduleDenial for any require whose
-- caller is outside src/, which includes every tests/ file -- so a rule
-- living there refuses tests/engine/link_session.lua and 16 other engine
-- tests that legitimately require src.link.Net at file scope, and does it
-- only when a loader happened to run earlier in the same process.  This gate
-- is about mod code, so it lives on the require mod code actually holds.
local LINK_NETWORK = {
  ["src.link.Net"] = true, ["src.link.LinkState"] = true,
  ["src.link.Tournament"] = true,
}

local function linkDenial(name, permissionSet)
  if type(name) ~= "string" or not LINK_NETWORK[name] then return nil end
  if (permissionSet or {}).network then return nil end
  return ("%s needs the \"network\" permission in manifest.json"):format(name)
end

-- PHOSPHOR (10): gen1recomp 0.2.5 added CacheFs.loadActive(rel), which reads
-- bytes and compiles them with `loadstring or load` and, failing that,
-- love.filesystem.load -- in both arms with NO environment argument, so the
-- chunk it runs is bound to the REAL globals.  CacheFs is engine code reached
-- through the real require, so those globals are the real io, os and
-- love.filesystem, not the facade below.
--
-- PhysFS puts the save directory on love.filesystem's path, so the argument a
-- mod passes can name the mod's OWN second file:
--
--     local CacheFs = require("src.import.CacheFs")
--     CacheFs.loadActive("mods/<own-id>/payload.lua")
--
-- That is the same complete bypass PHOSPHOR (7) closed on require, arriving
-- through a door that never touches require, so the `mods` root denial above
-- never sees it.  This is exactly the blacklist cost the header warns about:
-- src.* is allowed wholesale, so a new upstream loader is reachable by every
-- mod until it is named here.
--
-- Denied by exact name and NOT in moduleDenial, for the same reason
-- LINK_NETWORK is not: Loader's dev-mode backstop calls moduleDenial for any
-- require from outside src/, which is every tests/ file, and 0.2.5 ships
-- three engine tests (cache_fs_blue_mount, cache_fs_gold_nx_load,
-- cache_fs_headless) that require this module at file scope.  This gate is
-- about mod code, so it lives on the require mod code actually holds.
local HOST_LOADER = {
  ["src.import.CacheFs"] = "a Lua loader that runs files against the real globals",
}

local function hostLoaderDenial(name)
  if type(name) ~= "string" then return nil end
  local reason = HOST_LOADER[name]
  if not reason then return nil end
  return ("%s is not available to mods (it exposes %s); use mod.storage, "
    .. "mod:read and mod:list instead"):format(name, reason)
end

-- PHOSPHOR (11): the same blacklist cost as (10), arriving through two more
-- doors.  src.* is allowed wholesale, and the engine ships a host shell and an
-- HTTP stack as ordinary modules -- so a mod could ask for them by name and
-- get back, unfiltered, the two capabilities every rule above exists to
-- remove:
--
--     require("src.core.HostShell").popen(cmd)          -- io.popen, verbatim
--     require("src.net.Fetch").download(url, saveRel)   -- the wire, plus a
--                                                       -- write into saves
--
-- `io` is denied outright and `src.link.Net` needs a permission this build
-- never grants, so the boundary is not ambiguous: these two walked through it.
-- 0.2.9 widened the seam again with src/sync/* (a client taking an arbitrary
-- baseUrl) and src/core/IssueReport.lua (io.popen plus openURL).
--
-- Denied by SUBTREE where the whole directory is the capability, because a
-- name list is what missed these in the first place: a new file under src/net
-- on the next pin is reachable the day it lands.  On iOS none of it resolves
-- to anything -- no curl, no io.popen -- but the Mac app ships the same
-- payload, and a capability that is absent by accident is not confined.
--
-- Placed here and NOT in moduleDenial for the reason (8) and (10) give: ten
-- engine tests require src.core.HostShell at file scope from outside src/, and
-- moduleDenial answers for those callers too.
local HOST_ESCAPE = {
  ["src.core.HostShell"] = "io.popen, os.execute and the curl transport",
  ["src.core.IssueReport"] = "io.popen and love.system.openURL",
}

-- Ordered, not a hash: the message a mod author reads must not depend on
-- `pairs` order.
local HOST_ESCAPE_TREES = {
  { "src.net", "the launcher's HTTP stack" },
  { "src.sync", "the save-sync client, which takes an arbitrary base URL" },
}

local function hostEscapeDenial(name)
  if type(name) ~= "string" then return nil end
  local reason = HOST_ESCAPE[name]
  if not reason then
    for _, entry in ipairs(HOST_ESCAPE_TREES) do
      local prefix = entry[1]
      if name == prefix or name:sub(1, #prefix + 1) == prefix .. "." then
        reason = entry[2]
        break
      end
    end
  end
  if not reason then return nil end
  return ("%s is not available to mods (it exposes %s); mods do not reach the "
    .. "host or the network in this build"):format(name, reason)
end

-- ------- the love facade

-- Dropped, not narrowed: filesystem writes anywhere in the save directory
-- (including another mod's storage), thread opens a Lua state with a full
-- standard library, system.openURL launches whatever it is handed, and event
-- lets a mod quit the game out from under the player.  Everything else LÖVE
-- exposes passes through, so a new module in a future LÖVE is available
-- without an edit here.
-- value is the replacement to name in the error, or true when there is none
local BLOCKED_LOVE = {
  filesystem = "mod.storage, mod:read and mod:list",
  -- newThread's state has a full standard library and none of this file's
  -- rules, so it stays blocked -- but the reason mods reached for it was
  -- background work, and mod.fetch is that without the escape.
  thread = 'mod.fetch for background HTTP (needs the "network" permission)',
  system = "mod.device:powerInfo() for battery information, mod.steps for "
    .. "the step bridge", event = true,
}

-- Per-mod, because the compat overrides (src/mods/LegacyCompat.lua) are backed
-- by that mod's own overlay and must not be shared.
local function loveFacade(compat, permissions)
  if not _G.love then return nil end
  local overrides = compat and compat.love
  return setmetatable({}, {
    __index = function(_, key)
      local override = overrides and overrides[key]
      if override ~= nil then return override end
      if key == "thread" then
        -- Threads open a fresh Lua state with a full standard library, so
        -- they stay blocked unless the mod declares the `compute`
        -- permission (the mod's own source runs in the worker, and the
        -- worker ships source-only like every other mod file). The mod
        -- must never receive arbitrary code from elsewhere: channels
        -- carry data only.
        if not (permissions or {}).compute then
          error('love.thread needs the "compute" permission in manifest.json', 2)
        end
        return _G.love.thread
      end
      local hint = BLOCKED_LOVE[key]
      if hint then
        error(("love.%s is not available to mods%s"):format(key,
          type(hint) == "string" and (", use " .. hint) or ""), 2)
      end
      return _G.love[key]
    end,
    -- a callback chain lands on the real table (compat.assign decides which
    -- names qualify); a module table never does
    __newindex = function(_, key, value)
      if compat then
        local allowed, reason = compat.assign(key, value)
        -- PHOSPHOR: a third outcome upstream does not have. "handled" means
        -- the compat took the assignment somewhere of its own and nothing
        -- should reach the real love table -- which is what
        -- src/mods/PointerBridge.lua does, routing it to an input.pointer
        -- subscription instead.
        --
        -- This distinction is load-bearing, not tidiness. `true` here means
        -- "write it to _G.love", and on iOS the overlay's OWN
        -- love.mousemoved (main.lua) is what dispatches the touch overlay --
        -- so letting a mod's handler land there would clobber the virtual
        -- pad, which on a phone is the only input there is. A bridge that
        -- answered plain `true` would defeat its own reason for existing.
        if allowed == "handled" then return end
        if allowed then
          _G.love[key] = value
          return
        end
        if reason then error(reason, 2) end
      end
      error(("mods cannot assign love.%s"):format(tostring(key)), 2)
    end,
  })
end

-- ------- the environment

-- Absent on purpose: io, package, dofile, loadfile, getfenv, setfenv, debug,
-- newproxy, module.  os keeps only the clock -- getenv is how the reported
-- exploit found the user's home directory.
local SAFE_OS = { time = true, date = true, clock = true, difftime = true }

-- Per-mod copies, not the shared tables: a mod that assigns string.trim or
-- replaces table.insert changes its own view and nobody else's.  The functions
-- are the same objects, so state behind them (math.randomseed's RNG) is
-- unaffected -- only the namespace is private.
local function copy(source)
  if type(source) ~= "table" then return source end
  local out = {}
  for key, value in pairs(source) do out[key] = value end
  return out
end

local function baseGlobals()
  local safeOs = {}
  for key in pairs(SAFE_OS) do safeOs[key] = os[key] end
  return {
    assert = assert, error = error, ipairs = ipairs, next = next,
    pairs = pairs, pcall = pcall, xpcall = xpcall, select = select,
    tonumber = tonumber, tostring = tostring, type = type, unpack = unpack,
    rawequal = rawequal, rawget = rawget, rawset = rawset, rawlen = rawlen,
    setmetatable = setmetatable, getmetatable = getmetatable,
    -- PHOSPHOR (5): collectgarbage is upstream's, and it is not a compute
    -- primitive -- collectgarbage("setpause"/"setstepmul") retunes the
    -- ENGINE's collector from inside a mod, and "count"/"step" from a frame
    -- handler is a hitch a player reads as the emulator being slow.  Nothing
    -- a mod legitimately does needs it.
    _VERSION = _VERSION,
    coroutine = copy(coroutine), math = copy(math), string = copy(string),
    table = copy(table), bit = copy(bit), jit = jit, os = safeOs,
  }
end

-- PHOSPHOR (6): print() is a mod talking.  On a phone nobody reads stdout, so
-- an unattributed line there is the same as no line at all; routed through the
-- mod's own logger it lands in the feed the mod manager shows and it says
-- WHICH mod said it.  opts.log is the mod's log facade (Loader:_api's shape,
-- `log:info(fmt, ...)`); without one the line still gets attributed through
-- the engine logger rather than falling back to a bare stdout write.
local function sandboxedPrint(modId, log)
  return function(...)
    local parts = {}
    for i = 1, select("#", ...) do
      parts[#parts + 1] = tostring((select(i, ...)))
    end
    local line = table.concat(parts, "\t")
    if log and log.info then
      log:info("%s", line)
    else
      Logger.info("[%s] %s", tostring(modId or "mod"), line)
    end
  end
end

-- setfenv on 5.1/LuaJIT; on 5.2+ the env has to be handed to load itself, so
-- a caller there compiles through Sandbox.compile instead.  A chunk that
-- already exists is rebound through its _ENV upvalue.
--
-- PHOSPHOR (4): upstream's body is `if setfenv then setfenv(chunk, env) end;
-- return chunk`, so on a Lua without setfenv it returns the chunk UNBOUND and
-- every caller reads that as success -- "we could not confine it, so we ran it
-- anyway", which is the one outcome nobody would choose on purpose.  Returns
-- nil + a reason instead, and Loader:_loadMod refuses the mod outright when
-- Sandbox.available() is false.
function Sandbox.bind(chunk, env)
  if type(chunk) ~= "function" then return chunk end

  if type(setfenv) == "function" then
    setfenv(chunk, env)
    return chunk
  end

  local dbg = _G.debug
  if type(dbg) == "table" and dbg.getupvalue and dbg.setupvalue then
    local index = 1
    while true do
      local name = dbg.getupvalue(chunk, index)
      if not name then break end
      if name == "_ENV" then
        dbg.setupvalue(chunk, index, env)
        return chunk
      end
      index = index + 1
    end
    -- A chunk that touches no global has no _ENV upvalue at all. It cannot
    -- reach anything, so it is already confined.
    return chunk
  end

  return nil, "this Lua cannot confine mod code (no setfenv, no debug.setupvalue)"
end

-- PHOSPHOR (4): true when this build can actually confine a mod.  A host that
-- can do neither must not quietly run mods unconfined; the caller refuses.
function Sandbox.available()
  if type(setfenv) == "function" then return true end
  local dbg = _G.debug
  return type(dbg) == "table"
     and type(dbg.getupvalue) == "function"
     and type(dbg.setupvalue) == "function"
end

-- Bytecode is unreviewable and, on LuaJIT, a way out of any sandbox built out
-- of environments.  Mods ship source.
local function rejectBytecode(source, what)
  if type(source) == "string" and source:sub(1, 1) == "\27" then
    return nil, (what or "chunk") .. ": mods must ship Lua source, not bytecode"
  end
  return true
end

function Sandbox.compile(source, chunkname, env)
  local ok, err = rejectBytecode(source, chunkname)
  if not ok then return nil, err end
  if setfenv then
    local chunk, compileErr = loadstring(source, chunkname)
    if not chunk then return nil, compileErr end
    return setfenv(chunk, env)
  end
  return load(source, chunkname, "t", env)
end

-- The load() a mod sees.  Lua 5.1 gives a loaded chunk the GLOBAL environment
-- rather than the caller's, so without this every sandboxed mod is one
-- load(mod:read(...)) away from the real _G -- which is exactly how the
-- multi-file mods in mods/ are written.
local function sandboxedLoad(env)
  return function(chunk, chunkname)
    if type(chunk) == "function" then
      local parts = {}
      while true do
        local piece = chunk()
        if piece == nil or piece == "" then break end
        parts[#parts + 1] = piece
      end
      chunk = table.concat(parts)
    end
    if type(chunk) ~= "string" then return nil, "load expects a string or reader" end
    return Sandbox.compile(chunk, chunkname or "=(load)", env)
  end
end

-- The require a mod sees: the deny list lives here rather than on a stack
-- walk, because pcall(require, "io") puts a C frame where the walk would look.
-- Runtime.modRequire is how the loader's gate identifies the caller for the
-- Gen 2 facade once Runtime.currentMod has gone back to nil (a mod requiring
-- lazily from an event handler).
--
-- A mod's OWN submodule, as a path relative to its folder, or nil when `name`
-- is not one.  Only this mod's id matches, so another mod's files fall through
-- to the deny list; segments are plain identifiers, so nothing can spell a
-- traversal even before SafePath sees it.
local function selfModuleRelative(name, modId)
  if type(name) ~= "string" or type(modId) ~= "string" or modId == "" then
    return nil
  end
  local prefix = "mods." .. modId .. "."
  if name:sub(1, #prefix) ~= prefix then return nil end
  local rest = name:sub(#prefix + 1)
  if rest == "" then return nil end
  local parts = {}
  for segment in rest:gmatch("[^%.]+") do
    if not segment:match("^[%w_%-]+$") then return nil end
    parts[#parts + 1] = segment
  end
  if #parts == 0 then return nil end
  return table.concat(parts, "/") .. ".lua"
end

local function sandboxedRequire(modId, permissionSet, selfModules, env, compat)
  -- require's own contract: one instance per module per environment, so two
  -- of a mod's files requiring the same helper share it.
  local loaded, loading = {}, {}
  return function(name, ...)
    -- PHOSPHOR (9): every check below -- the self-module prefix, moduleDenial's
    -- root, linkDenial's exact names -- is written in the dotted spelling, but
    -- LÖVE resolves the slash spelling to the same file (see head()).  So a mod
    -- that spells `require("mods/<id>/payload")` or `require("src/link/Net")`
    -- would slip the deny list and the network gate and reach _G.require bound
    -- to the REAL globals.  Canonicalise to dots once, here, before anything
    -- reads the name; the real require resolves the dotted form identically.
    if type(name) == "string" then name = (name:gsub("/", ".")) end
    local relative = selfModules and selfModuleRelative(name, modId)
    if relative then
      if loaded[relative] ~= nil then return loaded[relative] end
      if loading[relative] then
        error(("[%s] circular require of %s"):format(modId, name), 2)
      end
      local path = SafePath.join(selfModules.path, relative, "mod module")
      -- Sandbox.loadFile is the whole point: it rejects bytecode and binds
      -- THIS environment, so a submodule is exactly as confined as the entry
      -- chunk.  The real require is never involved.
      local chunk, err = Sandbox.loadFile(selfModules.fs, path, env)
      if not chunk then
        error(("[%s] cannot load %s: %s"):format(modId, name, tostring(err)), 2)
      end
      loading[relative] = true
      local ok, result = pcall(chunk, name)
      loading[relative] = nil
      if not ok then error(result, 0) end
      if result == nil then result = true end
      loaded[relative] = result
      return result
    end
    -- The compat stand-in answers next, so a legacy require("io") gets the
    -- rerouted table instead of the denial below (src/mods/LegacyCompat.lua).
    --
    -- PHOSPHOR: `compat` is nil in this build -- Loader does not construct one
    -- yet -- so this is inert. It is kept here, in upstream's position
    -- relative to the denial checks, so wiring compat later is a change in
    -- Loader rather than another re-port of this function.
    --
    -- It sits BELOW the canonicalisation above on purpose. A substitute chosen
    -- from an un-canonicalised name would hand back a rerouted module for a
    -- spelling PHOSPHOR (9) exists to normalise first.
    local substitute = compat and compat.module(name)
    if substitute ~= nil then return substitute end
    local denial = Sandbox.moduleDenial(name, permissionSet)
      or linkDenial(name, permissionSet)
      or hostLoaderDenial(name)
      or hostEscapeDenial(name)
    if denial then error(("[%s] %s"):format(modId or "mod", denial), 2) end
    local previous = Runtime.modRequire
    Runtime.modRequire = modId or true
    local ok, result = pcall(_G.require, name, ...)
    Runtime.modRequire = previous
    if not ok then error(result, 0) end
    return result
  end
end

function Sandbox.envFor(opts)
  opts = opts or {}
  local compat = opts.compat
  local env = baseGlobals()
  -- `permissions` reaches the facade now: upstream gates love.thread on the
  -- `compute` permission rather than denying it outright, and the facade is
  -- per-mod for that reason (it used to be one shared proxy).
  env.love = loveFacade(compat, opts.permissions)
  -- `selfModules` is what lets a mod require its own files; without it (a
  -- caller with no mod folder, like the tests' bare envFor) those requires
  -- fall through to the deny list exactly as before.
  env.require = sandboxedRequire(opts.modId, opts.permissions,
                                 opts.selfModules, env, compat)
  env.print = sandboxedPrint(opts.modId, opts.log)
  local loader = sandboxedLoad(env)
  env.load = loader
  env.loadstring = loader
  -- a mod's globals are its own: two mods no longer share a namespace, and
  -- neither can reach the engine's
  env._G = env
  if compat then
    for key, value in pairs(compat.globals) do env[key] = value end
    for key, value in pairs(compat.os) do env.os[key] = value end
    compat.bind(env, function(source, chunkname)
      return Sandbox.compile(source, chunkname, env)
    end)
  end
  return env
end

-- fs.load keeps the real filesystem's handling of the file; the environment is
-- swapped after the fact.  The 5.2+ arm has to go back to source, which is the
-- only reason fs.read is touched here.
function Sandbox.loadFile(fs, path, env)
  if fs.read then
    local ok, err = rejectBytecode(fs.read(path), path)
    if not ok then return nil, err end
  end
  if setfenv then
    local chunk, err = fs.load(path)
    if not chunk then return nil, err end
    return setfenv(chunk, env)
  end
  local source = fs.read and fs.read(path)
  if not source then return nil, "unable to read " .. path end
  return Sandbox.compile(source, "@" .. path, env)
end

Sandbox.safePath = SafePath.safe
Sandbox.requirePath = SafePath.require

return Sandbox
