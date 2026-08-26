-- Gen 2 voxel-world orientation shim for LOVE 12 hosts.
--
-- Phosphor-only. This file has no upstream counterpart, so it replaces nothing
-- and carries no BASE_SHA256SUMS entry: a pin bump cannot drift it.
--
-- THE BUG. The voxel mods build their own projections and bypass LOVE's
-- transform_projection, so they own the clip convention. They fold
-- Mat4.scale(1, -1, 1) into it, making clip Y = -1 the top of the target, which
-- is how LOVE 11 stores a canvas. LOVE 12 normalises clip space itself
-- (love_clipSpaceTransform runs on whatever position() returns, and each
-- backend flips or does not so clip Y = +1 is the top everywhere), so the fold
-- is one flip too many and the 3D pass composites upside down.
--
-- Gen 1 never showed it: Renderer:setWorldOverride already blits a world
-- override flipped on iOS/LOVE 12. Gold has its own seam, World:drawPipeline,
-- which blits straight, so Gen 2 was the only place the mirror reached a player.
--
-- WHY THIS PATCHES SOURCE INSTEAD OF FLIPPING THE FINISHED CANVAS. Flipping the
-- canvas was tried first and is WRONG, because the canvas is MIXED: the 3D
-- arrives through the mod's own projection while ordinary LOVE 2D is drawn into
-- the very same target, by Weather.paintOverlay inside Voxel3D.endScene and by
-- BattleControllerUI before it. A whole-canvas flip rights the world and
-- inverts the rain and the battle HUD, and there is no moment in the pass where
-- all the 3D is done and none of the 2D has happened. Only correcting the
-- projection makes the 3D agree with the 2D, which is what this does: exactly
-- the change in randyadr/Gen2-3D-Sprites#9, applied to the source as it is read.
--
-- WHY IT IS SELF-CANCELLING. Three independent reasons this cannot double-apply:
-- the mod is skipped if it carries lib/ClipSpace.lua (the fix landed upstream),
-- the patch is anchored to the exact broken lines so any edit upstream misses,
-- and a miss leaves the source untouched rather than half-patched.
--
-- DELETE THIS FILE once no Gen 2 voxel mod in the catalog still pre-flips.

local unpack = unpack or table.unpack

local Shim = {}

local MOD_ID = "STADIUM2_OVERWORLD_MODELS"

-- One edit per shader that transforms geometry with one of the Y-down
-- matrices. Anchored on the exact clip-space return, which is why a mod that
-- has changed that line -- fixed it upstream, or refactored around it -- is
-- silently left alone.
local PATCHES = {
  ["lib/Voxel3D.lua"] = {
    { "    return vp * w;\n",
      "    vec4 clipY12 = vp * w; clipY12.y = -clipY12.y; return clipY12;\n" },
  },
  ["lib/Water.lua"] = {
    { "  return vp * w;\n",
      "  vec4 clipY12 = vp * w; clipY12.y = -clipY12.y; return clipY12;\n" },
  },
  ["lib/ShadowMap.lua"] = {
    { "    vDepth = c.z * 0.5 + 0.5;\n    return c;\n",
      "    vDepth = c.z * 0.5 + 0.5;\n    c.y = -c.y;\n    return c;\n" },
  },
}

local function loveMajor()
  local ok, major = pcall(function() return (love.getVersion()) end)
  return ok and tonumber(major) or 11
end

-- The mod fixed itself: lib/ClipSpace.lua is where that fix lives, and it
-- cannot be present without the fix being present.
local function modHandlesClipSpace(loader, mod)
  local fs = loader and loader.fs
  if not (fs and fs.getInfo and mod and type(mod.path) == "string") then
    return false
  end
  local ok, info = pcall(fs.getInfo, mod.path .. "/lib/ClipSpace.lua")
  return ok and info ~= nil
end

-- Exact, whole-string, single-occurrence replacement. No patterns: the
-- replacement text is data, not a gsub template, and a `%` in it must not be
-- read as a capture reference.
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

Shim.applyPatches = applyPatches   -- named for the suite
Shim.PATCHES = PATCHES

-- Called with the mod's api BEFORE its entry chunk runs, because the mod loads
-- every lib file through api:read during that chunk.
function Shim.consider(loader, mod, api)
  if not (mod and mod.manifest and mod.manifest.id == MOD_ID) then return false end
  if not (api and type(api.read) == "function") then return false end
  if loveMajor() < 12 then return false end
  if modHandlesClipSpace(loader, mod) then return false end

  local original = api.read
  local patched = {}
  api.read = function(self, relative)
    -- Pass every return value through untouched and replace only the source
    -- string. loader.fs.read is love.filesystem.read, whose second value is a
    -- SIZE on success, so returning a fixed pair here would hand back a stale
    -- length for exactly the files this rewrites.
    local returned = { original(self, relative) }
    local edits = type(returned[1]) == "string" and PATCHES[relative]
    if edits then
      local out, changed = applyPatches(returned[1], edits)
      if changed then
        patched[relative] = true
        returned[1] = out
        if type(returned[2]) == "number" then returned[2] = #out end
      end
    end
    return unpack(returned)
  end
  Shim.patchedFiles = patched
  return true
end

return Shim
