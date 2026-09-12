-- Gold, Silver and Crystal get the render-pipeline OPTIONS rows Red already has.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- THE BUG. A mod's world pipeline draws only while its level is above zero
-- (src/render/Pipelines.lua:eligible -> worldPipeline), and nothing raises that
-- level on its own: the render_pipelines schema has no default rung, so a
-- freshly installed voxel mod sits at OFF. There are exactly three ways up --
-- the OPTIONS row Pipelines.rows builds, the mod's own `hotkey`, and a host
-- directive (HostSeam.applyLaunchPipelines, which Phosphor sends only on DEBUG
-- builds).
--
-- src/ui/OptionsMenu.lua splices Pipelines.rows(game) in after TILT.
-- src/ui/gen2/OptionsMenu.lua does not -- it never requires Pipelines at all --
-- so on a Gen 2 game the row does not exist and the hotkey is the only way
-- left. docs/mod-api-gen2-compat.md says so in those words: "Gold also has no
-- OPTION row for a pipeline (`Pipelines.rows` is read only from
-- `src/ui/OptionsMenu.lua`), so a Gold player reaches one by its `hotkey`."
--
-- WHY THAT IS FATAL HERE AND NOWHERE ELSE. The hotkey is a KEYBOARD key -- the
-- voxel family declares F6. A desktop player presses it. An Android player has
-- no F6 but does get the mod's own on-screen camera slider, which the mods gate
-- on Android. Phosphor has neither: no keyboard, and LOVE never receives a
-- touch at all, because the on-screen controls are native UIKit views injecting
-- SDL virtual gamepad buttons and nothing in LoveHost forwards touches into
-- LOVE. That is the same finding that unwired src/mods/Gen2TouchUIShim.lua, and
-- it is why widening the mod's own touch gate is not the fix: the control it
-- puts on screen cannot be pressed.
--
-- So a Phosphor player on Gold, Silver or Crystal has NO way to switch a voxel
-- mod on. The mod loads, registers its pipeline, reports drawsWorld to the mod
-- manager, and draws nothing -- forever. Reported Sep 2026 as "Pokemon GSC does
-- not load the 3D voxels, no matter what mod I use", against an RBY that works
-- perfectly. That asymmetry is exactly the asymmetry between the two menus:
-- input reaches the engine as gamepad buttons, so the OPTIONS row is the one
-- control a Phosphor player can actually reach, and Gen 2 is missing it.
--
-- WHAT THIS DOES. Wraps the `ui.options.rows` hook that Gen 2's OPTIONS screen
-- already calls (src/ui/gen2/OptionsMenu.lua:new) and splices in the very rows
-- Gen 1 splices, in the same place: directly after TILT, carrying no group id,
-- so groupView leaves them on the top level instead of swallowing them into
-- EXTRAS. It claims the highest priority in the chain so it runs FIRST, which
-- means a mod's own `ui.options.rows` link sees the pipeline rows exactly as it
-- does on Gen 1.
--
-- Nothing here reaches the pipeline's behaviour. The row descriptors, the
-- OFF/15/35/50 ladder, the tilt exclusion and the write-back into
-- save.options.pipelines are all Pipelines.rows' own, unchanged, so a mode
-- switched on here is switched on the way Red switches it on.
--
-- SELF-CANCELLING, the same discipline as the clip-space shim: a row list that
-- already carries a `pipeline:` row is handed back untouched, so the day
-- upstream splices these itself this is inert rather than doubled. DELETE THIS
-- FILE that day.

local Gen2PipelineRows = {}

-- Ahead of any mod link. Hooks sorts the chain by descending priority, so a
-- number no manifest would think to write keeps this first without pinning it
-- to math.huge, which two links could tie on.
local PRIORITY = 1e9

-- Not a legal mod id (Manifest ids are word characters), so the entry-chunk
-- rollback path -- Hooks:removeOwner(modId) -- can never drop this link while
-- attributing a failing mod's wraps.
local OWNER = "phosphor.gen2-pipeline-rows"

local ROW_PREFIX = "pipeline:"

local function alreadySpliced(rows)
  for _, row in ipairs(rows) do
    local id = type(row) == "table" and row.id
    if type(id) == "string" and id:sub(1, #ROW_PREFIX) == ROW_PREFIX then
      return true
    end
  end
  return false
end

-- Insert `pipelineRows` after the TILT row, or append when there is none to
-- anchor to -- the rule and the fallback src/ui/OptionsMenu.lua follows, so the
-- two generations put a mod's mode in the same place. Returns a NEW list: the
-- caller's `rows` are the screen's own descriptors and are not ours to reorder
-- in place.
--
-- Pure, and named for the suite.
function Gen2PipelineRows.splice(rows, pipelineRows)
  if type(rows) ~= "table" or type(pipelineRows) ~= "table" then return rows end
  if pipelineRows[1] == nil or alreadySpliced(rows) then return rows end
  local out, anchored = {}, false
  for _, row in ipairs(rows) do
    out[#out + 1] = row
    if not anchored and type(row) == "table" and row.id == "tilt" then
      for _, extra in ipairs(pipelineRows) do out[#out + 1] = extra end
      anchored = true
    end
  end
  if not anchored then
    for _, extra in ipairs(pipelineRows) do out[#out + 1] = extra end
  end
  return out
end

-- The link itself, exposed so the suite can drive it without a Hooks chain.
-- `nextFn` carries the rest of the chain and then the screen's own identity
-- function, so handing it a new list is how the screen ends up with one.
function Gen2PipelineRows.link(nextFn, game, rows)
  local okRequire, Pipelines = pcall(require, "src.render.Pipelines")
  if not (okRequire and type(Pipelines) == "table"
      and type(Pipelines.rows) == "function") then
    return nextFn(game, rows)
  end
  -- A pipeline's own record supplies the label and the ladder, so this can
  -- throw on a mod's data; a broken mod must cost its row, never the screen.
  local ok, pipelineRows = pcall(Pipelines.rows, game)
  if not (ok and type(pipelineRows) == "table") then
    return nextFn(game, rows)
  end
  return nextFn(game, Gen2PipelineRows.splice(rows, pipelineRows))
end

-- Gen 2 only: Gen 1's OPTIONS screen already splices these itself, and a second
-- copy there would show every mode twice.
function Gen2PipelineRows.install(loader)
  if type(loader) ~= "table" or loader.generation ~= 2 then return false end
  local hooks = loader.hooks
  if not (type(hooks) == "table" and type(hooks.wrap) == "function") then
    return false
  end
  if loader.__phosphorPipelineRows then return false end
  loader.__phosphorPipelineRows = true
  hooks:wrap("ui.options.rows", Gen2PipelineRows.link, PRIORITY, OWNER)
  return true
end

Gen2PipelineRows.PRIORITY = PRIORITY
Gen2PipelineRows.OWNER = OWNER

return Gen2PipelineRows
