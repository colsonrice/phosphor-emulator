-- Gen 2's OPTIONS screen and a mod's render pipeline.
--
-- The bug this guards is an ABSENCE -- src/ui/gen2/OptionsMenu.lua never asks
-- Pipelines for rows -- so the interesting checks are not "does splice work"
-- but "is the row reachable at all, and does reaching it turn the mode on".
-- The last two checks drive the REAL src/render/Pipelines.lua, because the
-- claim being made is about eligibility, not about list surgery.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("gen2 pipeline rows")
local check = S.check

local Rows = require("src.mods.Gen2PipelineRows")

-- ------- splice placement

local VANILLA = {
  { id = "textSpeed" }, { id = "zoom" }, { id = "tilt" }, { id = "color" },
}
local PIPES = { { id = "pipeline:voxel", label = "VOXEL" } }

local out = Rows.splice(VANILLA, PIPES)
check(#out == #VANILLA + 1, "the pipeline row is added, nothing dropped")
local function idAt(list, i)
  local row = list[i]
  return type(row) == "table" and row.id or nil
end
check(idAt(out, 3) == "tilt", "TILT keeps its place")
check(idAt(out, 4) == "pipeline:voxel", "and the mode lands directly after it")
check(idAt(out, 5) == "color", "the rest of the list follows unmoved")
check(#VANILLA == 4, "the screen's own descriptors are not edited in place")

-- Gen 1 appends when there is no TILT to anchor to rather than losing the mode.
local noTilt = Rows.splice({ { id = "color" } }, PIPES)
check(noTilt[2] and noTilt[2].id == "pipeline:voxel",
  "with no TILT row the mode is appended, never dropped")

-- Self-cancelling: the day upstream splices these itself, this must be inert.
local already = Rows.splice(out, PIPES)
check(#already == #out, "a list that already carries a pipeline row is untouched")

check(Rows.splice(VANILLA, {}) == VANILLA, "no pipelines registered, no change")

-- ------- the link hands the spliced list DOWNSTREAM
-- The screen takes what comes back out of the chain, so a link that splices
-- into a local and forgets to pass it on would satisfy every check above and
-- still ship nothing.

package.loaded["src.render.Pipelines"] = {
  rows = function() return { { id = "pipeline:voxel", label = "VOXEL" } } end,
}
local seen
local returned = Rows.link(function(_, rows) seen = rows; return rows end,
                           {}, VANILLA)
check(seen and #seen == 5, "the link passes the SPLICED list to the next link")
check(returned and idAt(returned, 4) == "pipeline:voxel",
  "and the screen receives it back")

-- A mod's own record supplies the label and the ladder, so Pipelines.rows can
-- throw on bad data. That must cost the row, never the OPTIONS screen.
package.loaded["src.render.Pipelines"] = {
  rows = function() error("a mod's pipeline record is malformed") end,
}
local kept = Rows.link(function(_, rows) return rows end, {}, VANILLA)
check(kept == VANILLA, "a throwing Pipelines.rows degrades to the vanilla rows")
package.loaded["src.render.Pipelines"] = nil

-- ------- installation is Gen 2 only

local function fakeLoader(generation)
  local wrapped = {}
  return {
    generation = generation,
    hooks = { wrap = function(_, name, fn, priority, owner)
      wrapped[#wrapped + 1] = { name = name, fn = fn,
                                priority = priority, owner = owner }
    end },
    wrapped = wrapped,
  }
end

local gen1 = fakeLoader(1)
check(Rows.install(gen1) == false, "Gen 1 is refused: its own menu already splices")
check(#gen1.wrapped == 0, "and nothing is wrapped there")

local gen2 = fakeLoader(2)
check(Rows.install(gen2) == true, "Gen 2 installs")
check(#gen2.wrapped == 1, "exactly one link")
check(gen2.wrapped[1].name == "ui.options.rows", "on the hook the screen calls")
check(gen2.wrapped[1].priority == Rows.PRIORITY,
  "at a priority that runs ahead of any mod link")
check(Rows.install(gen2) == false and #gen2.wrapped == 1,
  "installing twice wraps once")

-- Hooks:removeOwner(modId) drops a failing mod's wraps by owner; ours must not
-- be reachable that way, so the owner cannot be a legal mod id.
check(Rows.OWNER:match("^[%w_]+$") == nil,
  "the owner is not a shape a manifest id could take")

-- ------- the point of all of it, against the REAL Pipelines

love = love or { graphics = {}, getVersion = function() return 12, 0, 0 end }
package.loaded["src.core.Data"] = package.loaded["src.core.Data"] or {}
package.loaded["src.core.Logger"] = package.loaded["src.core.Logger"]
  or { warn = function() end, error = function() end }
package.loaded["src.mods.Runtime"] = package.loaded["src.mods.Runtime"] or {}
package.loaded["src.render.Zoom"] = package.loaded["src.render.Zoom"]
  or { gateOK = function() return true end }
package.loaded["src.render.Tilt"] = package.loaded["src.render.Tilt"]
  or { level = 0, setLevel = function() end }

local Pipelines = require("src.render.Pipelines")
local save = { options = {} }
Pipelines.install({ render_pipelines = {
  voxel = { label = "VOXEL", levels = { "OFF", "15", "35", "50" },
            priority = 20, hotkey = "f6",
            drawWorld = function() return "canvas" end },
  _owners = { voxel = "STADIUM2_OVERWORLD_MODELS" },
} })
Pipelines.applyOptions(save.options)

check(Pipelines.worldPipeline() == nil,
  "a freshly installed voxel mod draws nothing: the ladder starts at OFF")

-- Exactly what the player now does on Gold: find the row and press right.
local real = Rows.splice({ { id = "tilt" } }, Pipelines.rows({ save = save }))
local row = real[2]
check(row and row.id == "pipeline:voxel", "the row is on the Gen 2 screen")
row.step({ save = save }, 1)

check(Pipelines.level("voxel") == 1, "one press steps the ladder up")
check(Pipelines.worldPipeline() == "voxel",
  "and the world pass is now the mod's -- the whole point of this file")
check(save.options.pipelines and save.options.pipelines.voxel == 1,
  "the level is written where Game2:showOptions will persist it")

-- ------- the WIRING, not just the module
-- src/mods/Gen2TouchUIShim.lua is the cautionary tale sitting in this same
-- directory: a complete, documented, tested shim that ships as dead code
-- because the two lines that called it are not in Loader.lua. A module nothing
-- installs is not a shipped behaviour, so assert the call site by source.
local loaderSrc = assert(io.open("src/mods/Loader.lua")):read("*a")
check(loaderSrc:find('require("src.mods.Gen2PipelineRows")', 1, true) ~= nil,
  "Loader.lua requires Gen2PipelineRows")
check(loaderSrc:find("Gen2PipelineRows.install", 1, true) ~= nil,
  "and installs it, so a Gen 2 loader actually gets the link")

-- ------- the real chain, end to end
-- Everything above drives seams in isolation. This is the exact call
-- src/ui/gen2/OptionsMenu.lua:new makes -- real Loader, real Hooks chain, real
-- Pipelines -- because the claim is that a PLAYER can reach the mode, and only
-- this shape of the test can be wrong about that.
--
-- Skipped under an interpreter that cannot load the Loader (Lua 5.4 has no
-- `bit`, which src/mods/StreamMD5.lua requires); run the suite under luajit to
-- get these. See docs/RECOMP_OVERLAY_PORTING.md.
local okLoader, Loader = pcall(require, "src.mods.Loader")
if okLoader then
  local fs = { getInfo = function() return nil end, read = function() return nil end,
               getDirectoryItems = function() return {} end,
               append = function() return true end }
  local function sameRows(_, r) return r end   -- the screen's own identity fn
  local function rowsThroughChain(generation, save)
    local loader = Loader.new({ generation = generation, fs = fs })
    Pipelines.applyOptions(save.options)
    return loader.hooks:call("ui.options.rows", sameRows, { save = save },
                             { { id = "zoom" }, { id = "tilt" }, { id = "color" } })
  end
  local function indexOfVoxel(list)
    for i, r in ipairs(list) do if r.id == "pipeline:voxel" then return i end end
  end

  local g1 = rowsThroughChain(1, { options = {} })
  check(indexOfVoxel(g1) == nil,
    "Gen 1's chain adds nothing: its own OPTIONS menu already splices the row")

  local g2save = { options = {} }
  local g2 = rowsThroughChain(2, g2save)
  check(indexOfVoxel(g2) == 3, "Gen 2's chain puts the row straight after TILT")
  g2[3].step({ save = g2save }, 1)
  check(Pipelines.worldPipeline() == "voxel",
    "and one press on it hands the world pass to the mod")
else
  check(true, "real-Loader chain skipped: this interpreter has no bit library")
end

S.finish()
