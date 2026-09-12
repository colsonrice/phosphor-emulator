-- "Try it anyway" for the ENGINE range a manifest declares.
--
-- `game_version` is the author's statement about which engines they tested,
-- not a capability the engine can verify, so a mod written before this engine
-- existed can never name it however well it would run. It used to be a hard
-- _fail with no override anywhere -- unlike the target claim, which has had
-- SaveData.modForced and a host seam for months. This is the parallel path.
--
-- Everything below drives the REAL Loader and the REAL HostSeam. The gate is
-- one `if` inside Loader:_validate, and a test that reimplemented the rule
-- would pass whether or not that `if` was ever reached.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("engine range override")
local check = S.check

local Loader = require("src.mods.Loader")
local HostSeam = require("src.core.HostSeam")
local Version = require("src.core.Version")

-- Loader:_validate skips the range check entirely when the engine reports a
-- dev version (devEngine(), "^0%.0%.0%-"), and the repo default IS 0.0.0-dev.
-- Left alone, every assertion in this file would pass for the wrong reason:
-- not because the override worked, but because the gate never ran. Stand a
-- real release version up for the duration.
local realEngine = "0.2.56"
local savedEngine = Version.engine
Version.engine = realEngine
check(Version.engine:match("^0%%.0%%.0%%-") == nil,
  "precondition: the gate is live, so these assertions can fail")

local function newFs()
  local written = {}
  return {
    -- every probed file exists: _validate checks the entry file FIRST, and a
    -- missing one would short-circuit before the range check this suite is about
    getInfo = function() return { type = "file", size = 1 } end,
    read = function() return "", 0 end,
    getDirectoryItems = function() return {} end,
    append = function() return true end,
    write = function(_, path, data) written[path] = data; return true end,
    written = written,
  }
end

-- A mod that is installed, enabled and fine in every way EXCEPT that its
-- declared engine range excludes the engine actually running.
local function loaderWithOutOfRangeMod(forced)
  local loader = Loader.new({ generation = 1, fs = newFs() })
  loader.engineForced = forced and { OLD_MOD = true } or {}
  loader.mods = {
    OLD_MOD = {
      enabled = true,
      path = "mods/OLD_MOD",
      manifest = {
        id = "OLD_MOD", version = "1.0.0", api = 2, entry = "main.lua",
        -- an engine long behind the one we run
        game_version = "<0.1.0",
        dependencySpecs = {}, conflictSpecs = {}, requiredImports = {},
      },
    },
  }
  return loader
end

-- ------- the gate itself

local refused = loaderWithOutOfRangeMod(false)
refused:_validate()
local m = refused.mods.OLD_MOD
check(m.failed == true or m.state == "invalid",
  "without the override an out-of-range mod still fails, as it always did")
check(type(m.failure) == "string" and m.failure:find("needs game version", 1, true),
  "and the reason still names the range, so the host can explain it")
check(m.forcedEngine ~= true, "and it is not marked forced")

local forced = loaderWithOutOfRangeMod(true)
forced:_validate()
local f = forced.mods.OLD_MOD
check(f.failed ~= true and f.state ~= "invalid",
  "with the override the very same mod LOADS: the whole point")
check(f.failure == nil, "and carries no failure for the host to draw")
check(f.forcedEngine == true, "it is marked forced, so the row can say so")
check(type(f.engineNote) == "string"
        and f.engineNote:find("not verified by its author", 1, true),
  "and the note says the deal the player made, in the loader's own words")

-- A mod whose range DOES cover the engine must be untouched by any of this.
local fine = Loader.new({ generation = 1, fs = newFs() })
fine.engineForced = {}
fine.mods = { OK_MOD = { enabled = true, path = "mods/OK_MOD", manifest = {
  id = "OK_MOD", version = "1.0.0", api = 2, entry = "main.lua",
  game_version = ">=0.0.1 <99.0.0",
  dependencySpecs = {}, conflictSpecs = {}, requiredImports = {} } } }
fine:_validate()
check(fine.mods.OK_MOD.failed ~= true, "an in-range mod loads with no override needed")
check(fine.mods.OK_MOD.forcedEngine ~= true,
  "and is NOT marked forced: the note must mean something when it appears")

-- The host seam that WRITES this override is tested beside the target override
-- it parallels, in tests/host_seam_tests.lua ("try it anyway: the ENGINE-RANGE
-- override"). The two belong together: their only real difference is that this
-- one carries no game token, and that is only visible side by side.

S.finish()

Version.engine = savedEngine
