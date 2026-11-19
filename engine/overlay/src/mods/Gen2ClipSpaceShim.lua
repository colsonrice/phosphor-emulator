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
-- WHICH MODS, AND WHY A LIST RATHER THAN A RULE (Nov 18 2026). The shim began
-- as STADIUM2_OVERWORLD_MODELS only. Reading every voxel mod on disk (the
-- survey archive cache, about 40 versions across 11 families) found two more
-- that pre-flip, have the anchors and reach the screen through Gold's straight
-- blit with nothing correcting them: TERRARIUM (gen2compat; its world, and so
-- the "Mod Terrarium" reports, upside down on Gold) and voxel_run_bridge, whose
-- Gold path is STADIUM2 0.4.33's renderer vendored under vendor/gen2_voxel/ and
-- read through that prefix. It also found why "pre-flips and has the anchors"
-- is NOT a safe rule on its own, because two mods that match it would be
-- turned upside down by it:
--   * potato_voxel folds the same flip and carries the same anchors, but its
--     Gold entry (gen2/main.lua, "drawFull") already blits its canvas mirrored
--     on iOS + LOVE 12. Patched here it would be corrected twice. Nothing in
--     the three lib files says so; the correction lives in another file.
--   * VOXEL_ASCENDANT 3.x reads gen2/lib/Voxel3D.lua on Gold, which has the
--     Voxel3D anchor but builds its projection through worldClipMatrix(),
--     which already skips the flip on iOS.
-- And no rule here may fire on Gen 1 or Gen 3 at all: both composite a world
-- override through Renderer:setWorldOverride, which already blits it mirrored
-- on iOS + LOVE 12, so the 3D is right there and this would invert it.
-- So a further mod is named below with the lib root(s) it was read at, and is
-- patched only on a Gen 2 boot, and only if its source still shows the fold
-- and exactly one clip-space return per patched shader. Add a mod only after
-- reading where its Gold frame reaches the screen.
--
-- DELETE THIS FILE once no Gen 2 voxel mod in the catalog still pre-flips.

local unpack = unpack or table.unpack

local Shim = {}

local MOD_ID = "STADIUM2_OVERWORLD_MODELS"

-- Verified beyond MOD_ID: mod id -> the lib roots (prefixes of the path the
-- mod passes to api:read) whose renderer is patched. Read Nov 18 2026:
--   TERRARIUM 1.30.1: lib/Voxel3D.lua:2760,2791 fold; :941 the one return;
--     lib/ShadowMap.lua:466 fold; lib/Water.lua has no vertex shader; no iOS
--     or LOVE-version handling anywhere in the mod.
--   voxel_run_bridge 0.13.1: modules/gen2_voxel.lua reads ROOT
--     "vendor/gen2_voxel" .. "/" .. relative; Water.lua and ShadowMap.lua
--     there are byte-identical to STADIUM2 0.4.33, Voxel3D.lua differs only
--     in the sky-body helper. Its Gen 1 lib/ is NOT listed: Gen 1 is already
--     corrected by the engine.
local VERIFIED = {
  TERRARIUM = { "" },
  voxel_run_bridge = { "vendor/gen2_voxel/" },
}

-- The flip, as every verified mod writes it. A mod that builds its clip
-- matrix any other way (VOXEL_ASCENDANT's worldClipMatrix) does not match,
-- and is left alone.
local FOLD = "proj = Mat4.mul(Mat4.scale(1, -1, 1), proj)"
local RETURN_VP = "return vp * w;"

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
-- cannot be present without the fix being present. `root` is a vendored
-- renderer's prefix; "" (or nil) is the mod's own lib/.
local function modHandlesClipSpace(loader, mod, root)
  local fs = loader and loader.fs
  if not (fs and fs.getInfo and mod and type(mod.path) == "string") then
    return false
  end
  local ok, info = pcall(fs.getInfo, mod.path .. "/" .. (root or "") .. "lib/ClipSpace.lua")
  return ok and info ~= nil
end

local function occurrences(source, needle)
  local n, at = 0, 1
  while true do
    local s = string.find(source, needle, at, true)
    if not s then return n end
    n, at = n + 1, s + #needle
  end
end

local function readSource(read, api, relative)
  local ok, source = pcall(read, api, relative)
  if ok and type(source) == "string" then return source end
  return nil
end

-- The edits for one verified lib root, or nil to leave the whole root alone.
-- Voxel3D and Water draw into the same canvas with the same matrix, so they
-- are patched together or not at all: a world righted with its water still
-- inverted is worse than today. The shadow pass is self-contained (its own
-- fold, its own lookup), so it is patched whenever its own fold is there.
local function rootPatches(read, api, root)
  local voxel = readSource(read, api, root .. "lib/Voxel3D.lua")
  if not voxel then return nil end
  if not string.find(voxel, FOLD, 1, true) then return nil end
  if occurrences(voxel, RETURN_VP) ~= 1
      or occurrences(voxel, PATCHES["lib/Voxel3D.lua"][1][1]) ~= 1 then
    return nil
  end
  local out = { [root .. "lib/Voxel3D.lua"] = PATCHES["lib/Voxel3D.lua"] }

  local water = readSource(read, api, root .. "lib/Water.lua")
  if water and occurrences(water, RETURN_VP) > 0 then
    if occurrences(water, RETURN_VP) ~= 1
        or occurrences(water, PATCHES["lib/Water.lua"][1][1]) ~= 1 then
      return nil
    end
    out[root .. "lib/Water.lua"] = PATCHES["lib/Water.lua"]
  end

  local shadow = readSource(read, api, root .. "lib/ShadowMap.lua")
  if shadow and string.find(shadow, FOLD, 1, true) then
    out[root .. "lib/ShadowMap.lua"] = PATCHES["lib/ShadowMap.lua"]
  end
  return out
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
Shim.VERIFIED = VERIFIED

local function install(api, patches)
  local original = api.read
  local patched = {}
  api.read = function(self, relative)
    -- Pass every return value through untouched and replace only the source
    -- string. loader.fs.read is love.filesystem.read, whose second value is a
    -- SIZE on success, so returning a fixed pair here would hand back a stale
    -- length for exactly the files this rewrites.
    local returned = { original(self, relative) }
    local edits = type(returned[1]) == "string" and patches[relative]
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

-- Called with the mod's api BEFORE its entry chunk runs, because the mod loads
-- every lib file through api:read during that chunk.
function Shim.consider(loader, mod, api)
  local id = mod and mod.manifest and mod.manifest.id
  if id == MOD_ID then
    -- unchanged since the shim was written for this one mod
    if not (api and type(api.read) == "function") then return false end
    if loveMajor() < 12 then return false end
    if modHandlesClipSpace(loader, mod) then return false end
    return install(api, PATCHES)
  end

  local roots = type(id) == "string" and VERIFIED[id]
  if not roots then return false end
  if not (api and type(api.read) == "function") then return false end
  if loveMajor() < 12 then return false end
  -- Gen 1 and Gen 3 already blit the world override mirrored on iOS.
  if not (loader and loader.generation == 2) then return false end
  if modHandlesClipSpace(loader, mod) then return false end

  local patches, any = {}, false
  for _, root in ipairs(roots) do
    if not modHandlesClipSpace(loader, mod, root) then
      local edits = rootPatches(api.read, api, root)
      for relative, list in pairs(edits or {}) do
        patches[relative] = list
        any = true
      end
    end
  end
  if not any then return false end
  return install(api, patches)
end

return Shim
