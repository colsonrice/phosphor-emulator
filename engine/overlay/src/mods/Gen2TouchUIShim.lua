-- The Gen 2 voxel mod's touch controls, on iOS.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- WHAT IS MISSING. The mod has two different ideas of "mobile" and applies
-- them inconsistently. Six places correctly test `Android or iOS` -- the canvas
-- restore policy in Voxel3D and ShadowMap, AntiAlias, EngineCompat,
-- VoxelDiskCache, StadiumRomMenu -- and every one of those is a rendering or
-- storage concern. Every TOUCH gate, though, tests Android alone, so iOS falls
-- through to the DESKTOP control scheme:
--
--   * the DIORAMA / 3RD / 1ST camera slider is never installed
--   * right-thumb camera look is off
--   * pinch-to-zoom for the diorama camera is off
--   * the split-thumb layout is off, so rightLookZone() returns true for every
--     x and the WHOLE screen becomes the look zone, which is why a drag fights
--     the movement input rather than sitting beside it
--   * camera-mode cycling falls to the desktop path, which polls
--     love.keyboard.isDown for F6 -- a key no iPhone has, and with the slider
--     suppressed there is then NO way to change camera mode at all
--
-- That reads as "the UI is rough". It is really the desktop scheme running on
-- a touchscreen.
--
-- WHY THIS IS SAFE TO WIDEN. The touch paths use portable love.touch
-- (getTouches / getPosition), not anything Android-specific, and the mod
-- already ships the `Android or iOS` idiom in the six files above. This is an
-- oversight, not a platform decision.
--
-- THREE ANCHORS, because one of them does the heavy lifting: GoldVoxelBridge's
-- isAndroid() is the single gate behind all six touch behaviours, and it is
-- exported as Bridge.isAndroid with no consumer anywhere in the mod, so
-- widening it moves nothing else. The other two are the split-thumb zone,
-- which is duplicated verbatim in FirstPerson and CamControl.
--
-- DELIBERATELY NOT TOUCHED: GoldComposeBridge has its own private isAndroid()
-- used only by screenFlipEnabled(). That is the whole-frame 180 rotation for
-- Android devices that insist on the wrong landscape side, and it is a
-- compatibility workaround rather than a control, so iOS must stay out of it.
--
-- SELF-CANCELLING the same way the clip-space shim is: each edit is anchored to
-- the exact Android-only text, so a mod that widens these itself -- or merely
-- refactors the line -- misses the anchor and is left completely alone.

local Gen2TouchUIShim = {}

local unpack = unpack or table.unpack

local MOD_ID = "STADIUM2_OVERWORLD_MODELS"

local PATCHES = {
  -- The one gate behind the slider, thumb-look, pinch, and the F6 fallback.
  ["lib/GoldVoxelBridge.lua"] = {
    { 'local function isAndroid()\n  return platformName():lower() == "android"\nend\n',
      'local function isAndroid()\n'
      .. '  -- Phosphor: iOS is a touchscreen too. The touch paths below use\n'
      .. '  -- portable love.touch, and the desktop fallback they gate is F6.\n'
      .. '  local osName = platformName():lower()\n'
      .. '  return osName == "android" or osName == "ios"\n'
      .. 'end\n' },
  },
  -- The split-thumb look zone, duplicated verbatim in both files.
  ["lib/FirstPerson.lua"] = {
    { '    if osName ~= "Android" then return true end\n',
      '    if osName ~= "Android" and osName ~= "iOS" then return true end\n' },
  },
  ["lib/CamControl.lua"] = {
    { '    if osName ~= "Android" then return true end\n',
      '    if osName ~= "Android" and osName ~= "iOS" then return true end\n' },
  },
}

Gen2TouchUIShim.PATCHES = PATCHES

local function osName()
  local ok, name = pcall(function()
    local sys = love and love.system
    return sys and sys.getOS and sys.getOS()
  end)
  return ok and type(name) == "string" and name or ""
end

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

Gen2TouchUIShim.applyPatches = applyPatches

-- Called with the mod's api BEFORE its entry chunk runs, because the mod loads
-- every lib file through api:read during that chunk.
function Gen2TouchUIShim.consider(loader, mod, api)
  if not (mod and mod.manifest and mod.manifest.id == MOD_ID) then return false end
  if not (api and type(api.read) == "function") then return false end
  if osName() ~= "iOS" then return false end

  local original = api.read
  local patched = {}
  api.read = function(self, relative)
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
  Gen2TouchUIShim.patchedFiles = patched
  return true
end

return Gen2TouchUIShim
