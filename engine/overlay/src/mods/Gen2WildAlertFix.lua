-- The Gold wild-alert crash: emote table missing `left`.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- THE CRASH. SpawnLogic:_onAggressiveAlert builds `ow.emote` with npc, frames
-- and onDone, and no `left`. Gold's World:update (src/world/gen2/World.lua)
-- ticks ANY ow.emote unconditionally via `self.emote.left - 1`, regardless of
-- who set it, so the very next frame does arithmetic on nil and the error
-- escapes into boot.lua, which closes the VM. To a player that is the game
-- dropping out of a battle the moment a wild alert fires.
--
-- It leaves no crash report and no jetsam event, because nothing crashed: the
-- LOVE VM shut down cleanly through LoveHost's finishAndClose and the recomp
-- session ended. It is also invisible to ModRenderGuard, which only guards
-- render.* hooks, and this is world-update logic.
--
-- WHOSE FIX THIS IS. Not ours. jramiresbrito diagnosed it and opened
-- randyadr/Gen2-3D-Sprites#6 on Aug 16 2026, and this applies exactly that
-- change: one field. The PR has sat unmerged, along with every other PR that
-- repository has ever received, so players hit the crash with a fix that
-- already exists sitting a merge button away. When it lands upstream the
-- anchor below stops matching and this quietly stops doing anything.
--
-- onDone is deliberately not touched: Gold's engine never invokes it (that is
-- a Gen 1 OverworldController behaviour), and the bx.alertAt fail-safe is what
-- actually arms chase/flee. `left` here is purely the crash guard.

local Gen2WildAlertFix = {}

local unpack = unpack or table.unpack

local MOD_ID = "STADIUM2_OVERWORLD_MODELS"

local PATCHES = {
  ["lib/spawn_logic.lua"] = {
    -- The anchor runs THROUGH onDone so that patching destroys it: without
    -- that, the head of the table still matches afterwards and a second pass
    -- would insert `left` twice.
    { '  ow.emote = {\n    npc = entity,\n    frames = frames,\n    onDone = function()\n',
      '  ow.emote = {\n    npc = entity,\n    frames = frames,\n'
      .. '    -- Gold\'s World:update ticks ANY ow.emote via `.left`\n'
      .. '    -- unconditionally, so without this the next frame crashes on\n'
      .. '    -- `self.emote.left - 1`. See randyadr/Gen2-3D-Sprites#6.\n'
      .. '    left = frames,\n    onDone = function()\n' },
  },
}

Gen2WildAlertFix.PATCHES = PATCHES

-- Exact, whole-string, single-occurrence replacement. No patterns: the
-- replacement is data, and a `%` in it must not read as a capture reference.
local function applyPatches(source, edits)
  local changed = false
  for _, edit in ipairs(edits) do
    local from, to = edit[1], edit[2]
    local at = string.find(source, from, 1, true)
    if at and not string.find(source, from, at + #from, true) then
      source = string.sub(source, 1, at - 1) .. to
        .. string.sub(source, at + #from)
      changed = true
    end
  end
  return source, changed
end

Gen2WildAlertFix.applyPatches = applyPatches

-- Already fixed upstream: the mod sets `left` on that table itself.
local function modSetsLeft(source)
  local at = string.find(source, "  ow.emote = {", 1, true)
  if not at then return false end
  local tail = string.sub(source, at, at + 400)
  return string.find(tail, "left = ", 1, true) ~= nil
end

-- Called with the mod's api BEFORE its entry chunk runs, because the mod loads
-- every lib file through api:read during that chunk.
function Gen2WildAlertFix.consider(loader, mod, api)
  if not (mod and mod.manifest and mod.manifest.id == MOD_ID) then return false end
  if not (api and type(api.read) == "function") then return false end

  local original = api.read
  local patched = {}
  api.read = function(self, relative)
    local returned = { original(self, relative) }
    local edits = type(returned[1]) == "string" and PATCHES[relative]
    if edits and not modSetsLeft(returned[1]) then
      local out, changed = applyPatches(returned[1], edits)
      if changed then
        patched[relative] = true
        returned[1] = out
        if type(returned[2]) == "number" then returned[2] = #out end
      end
    end
    return unpack(returned)
  end
  Gen2WildAlertFix.patchedFiles = patched
  return true
end

return Gen2WildAlertFix
