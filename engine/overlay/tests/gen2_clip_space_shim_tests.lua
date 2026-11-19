-- The Gen 2 clip-space shim: which mods it rewrites, and which it must not.
-- Getting the set wrong in either direction turns a world upside down on iOS,
-- and nothing fails: a mod left out stays mirrored on Gold, and a mod patched
-- that already corrects itself (potato_voxel's Gold blit), that builds its clip
-- matrix another way (VOXEL_ASCENDANT), or that runs on Gen 1 (where the
-- engine's own blit corrects it) is mirrored by the patch. The sources below
-- are small synthetic stand-ins shaped like the real lines, not copies of mods.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("gen2 clip space shim")
local check = S.check

local Shim = require("src.mods.Gen2ClipSpaceShim")

local FOLD = "  proj = Mat4.mul(Mat4.scale(1, -1, 1), proj)\n"

local VOXEL = "local Voxel3D = {}\n"
  .. "local SHADER = [[\n  vec4 position(mat4 t, vec4 v) {\n"
  .. "    vec4 w = model * v;\n    return vp * w;\n  }\n]]\n"
  .. "function Voxel3D.viewProjection()\n  local proj = Mat4.perspective()\n"
  .. FOLD .. "  return proj\nend\nreturn Voxel3D\n"
local WATER = "local SHADER = [[\nvec4 position(mat4 t, vec4 v) {\n"
  .. "  vec4 w = v;\n  return vp * w;\n}\n]]\n"
local SHADOW = "local SHADER = [[\n  vec4 position(mat4 t, vec4 v) {\n"
  .. "    vec4 c = lightVP * v;\n    vDepth = c.z * 0.5 + 0.5;\n    return c;\n  }\n]]\n"
  .. "local function fit()\n  local proj = Mat4.ortho()\n" .. FOLD .. "end\n"

-- VOXEL_ASCENDANT's shape: the same shader return, the clip matrix built
-- through a helper that skips the flip on iOS. Anchors, no fold.
local VOXEL_NO_FOLD = VOXEL:gsub("Mat4%.mul%(Mat4%.scale%(1, %-1, 1%), proj%)",
                                 "Mat4.mul(worldClipMatrix(), proj)")

local CLIP_OUT = "clipY12.y = -clipY12.y"

-- love.getVersion is the only LOVE call the shim makes.
local savedLove = rawget(_G, "love")
local function setLove(major)
  _G.love = { getVersion = function() return major, 0, 0, "test" end }
end

local function freshApi(files)
  local reads = {}
  local api = {}
  function api.read(_, relative)
    reads[#reads + 1] = relative
    local s = files[relative]
    if s == nil then return nil, "missing " .. relative end
    return s, #s
  end
  return api, reads
end

local function loader(generation, present)
  present = present or {}
  return {
    generation = generation,
    fs = { getInfo = function(path) return present[path] and { type = "file" } or nil end },
  }
end

local function mod(id) return { path = "mods/" .. id, manifest = { id = id } } end

local function stdFiles(root)
  root = root or ""
  return {
    [root .. "lib/Voxel3D.lua"] = VOXEL,
    [root .. "lib/Water.lua"] = WATER,
    [root .. "lib/ShadowMap.lua"] = SHADOW,
  }
end

setLove(12)

-- 1. A pre-flipping mod other than the original one is patched on Gold.
do
  local api = freshApi(stdFiles())
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == true,
        "TERRARIUM is patched on a Gen 2 boot")
  local v, size = api:read("lib/Voxel3D.lua")
  check(v:find(CLIP_OUT, 1, true) ~= nil, "its Voxel3D return is corrected")
  check(size == #v, "the size travelling with the source is the patched size")
  check(api:read("lib/Water.lua"):find(CLIP_OUT, 1, true) ~= nil, "its Water return too")
  check(api:read("lib/ShadowMap.lua"):find("c.y = -c.y;", 1, true) ~= nil,
        "and its shadow pass")
  local _, err = api:read("lib/Missing.lua")
  check(err == "missing lib/Missing.lua", "a miss still passes its error through")
end

-- 2. Terrarium's real shape: Water.lua with no vertex shader at all.
do
  local files = stdFiles()
  files["lib/Water.lua"] = "local Water = {}\nreturn Water\n"
  local api = freshApi(files)
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == true,
        "a Water.lua with no clip-space return does not block the patch")
  check(api:read("lib/Voxel3D.lua"):find(CLIP_OUT, 1, true) ~= nil, "Voxel3D still patched")
  check(api:read("lib/Water.lua") == files["lib/Water.lua"], "and Water left as it was")
end

-- 3. A vendored renderer is patched at its own prefix and nowhere else.
do
  local files = stdFiles("vendor/gen2_voxel/")
  for k, v in pairs(stdFiles()) do files[k] = v end
  local api = freshApi(files)
  check(Shim.consider(loader(2), mod("voxel_run_bridge"), api) == true,
        "voxel_run_bridge is patched on Gold")
  check(api:read("vendor/gen2_voxel/lib/Voxel3D.lua"):find(CLIP_OUT, 1, true) ~= nil,
        "at vendor/gen2_voxel/")
  check(api:read("lib/Voxel3D.lua") == VOXEL,
        "but not its own Gen 1 renderer under lib/")
end

-- 4. Upstream's own fix retires the patch.
do
  local api = freshApi(stdFiles())
  local L = loader(2, { ["mods/TERRARIUM/lib/ClipSpace.lua"] = true })
  check(Shim.consider(L, mod("TERRARIUM"), api) == false,
        "a mod carrying lib/ClipSpace.lua is not patched")
  check(api:read("lib/Voxel3D.lua") == VOXEL, "and its source is untouched")

  local api2 = freshApi(stdFiles("vendor/gen2_voxel/"))
  local L2 = loader(2, { ["mods/voxel_run_bridge/vendor/gen2_voxel/lib/ClipSpace.lua"] = true })
  check(Shim.consider(L2, mod("voxel_run_bridge"), api2) == false,
        "nor a vendored renderer carrying its own lib/ClipSpace.lua")

  -- A mod that has started normalising clip space anywhere is trusted to
  -- have done it everywhere, rather than guessed at file by file.
  local api3 = freshApi(stdFiles("vendor/gen2_voxel/"))
  local L3 = loader(2, { ["mods/voxel_run_bridge/lib/ClipSpace.lua"] = true })
  check(Shim.consider(L3, mod("voxel_run_bridge"), api3) == false,
        "nor a mod whose own lib/ carries ClipSpace.lua beside a vendored renderer")
end

-- 5. Anchors without the fold: patching would invert a correct mod.
do
  local files = stdFiles()
  files["lib/Voxel3D.lua"] = VOXEL_NO_FOLD
  check(VOXEL_NO_FOLD:find("return vp * w;", 1, true) ~= nil, "fixture keeps the anchor")
  local api = freshApi(files)
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == false,
        "a listed mod that no longer folds the flip is not patched")
  check(api:read("lib/Voxel3D.lua") == VOXEL_NO_FOLD, "its Voxel3D is untouched")
  check(api:read("lib/Water.lua") == WATER, "and so is its Water")
end

-- 6. An unlisted mod that pre-flips and has every anchor is NOT patched:
-- potato_voxel is exactly that, and corrects its Gold frame itself.
do
  local api = freshApi(stdFiles())
  check(Shim.consider(loader(2), mod("potato_voxel"), api) == false,
        "potato_voxel is never patched")
  check(Shim.consider(loader(2), mod("VOXEL_ASCENDANT"), freshApi(stdFiles())) == false,
        "nor VOXEL_ASCENDANT")
  check(api:read("lib/Voxel3D.lua") == VOXEL, "source untouched")
end

-- 7. Not on Gen 1 or Gen 3: the engine's world blit is already mirrored there.
do
  for _, g in ipairs({ 1, 3 }) do
    local api = freshApi(stdFiles())
    check(Shim.consider(loader(g), mod("TERRARIUM"), api) == false,
          ("not on a Gen %d boot"):format(g))
    check(api:read("lib/Voxel3D.lua") == VOXEL, ("Gen %d source untouched"):format(g))
  end
  check(Shim.consider(nil, mod("TERRARIUM"), freshApi(stdFiles())) == false,
        "nor when the loader cannot say which generation this is")
end

-- 8. Not below LOVE 12, where the fold is correct.
do
  setLove(11)
  local api = freshApi(stdFiles())
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == false,
        "not on LOVE 11")
  check(api:read("lib/Voxel3D.lua") == VOXEL, "LOVE 11 source untouched")
  check(Shim.consider(loader(2), mod("STADIUM2_OVERWORLD_MODELS"), freshApi(stdFiles())) == false,
        "the original mod is not patched on LOVE 11 either")
  setLove(12)
end

-- 9. Water and Voxel3D move together: a Water return the anchor cannot take
-- refuses the whole root rather than right the world over inverted water.
do
  local files = stdFiles()
  files["lib/Water.lua"] = WATER .. "local OTHER = [[\n  return vp * w;\n]]\n"
  local api = freshApi(files)
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == false,
        "two Water returns refuse the root")
  check(api:read("lib/Voxel3D.lua") == VOXEL, "and Voxel3D stays as it was")
  local files2 = stdFiles()
  files2["lib/Voxel3D.lua"] = VOXEL .. "local SECOND = [[\n    return vp * w;\n]]\n"
  check(Shim.consider(loader(2), mod("TERRARIUM"), freshApi(files2)) == false,
        "two Voxel3D returns refuse the root")
  local files3 = stdFiles()
  files3["lib/Voxel3D.lua"] = VOXEL:gsub("\n", "\r\n")
  check(Shim.consider(loader(2), mod("TERRARIUM"), freshApi(files3)) == false,
        "a CRLF Voxel3D misses the anchor and refuses the root")
end

-- 10. The shadow pass is patched only when it folds its own flip.
do
  local files = stdFiles()
  files["lib/ShadowMap.lua"] = SHADOW:gsub("Mat4%.mul%(Mat4%.scale%(1, %-1, 1%), proj%)", "proj")
  local api = freshApi(files)
  check(Shim.consider(loader(2), mod("TERRARIUM"), api) == true, "the main pass still qualifies")
  check(api:read("lib/ShadowMap.lua") == files["lib/ShadowMap.lua"],
        "an unflipped shadow pass is left alone")
end

-- 11. The original mod keeps exactly its old behaviour: no generation gate,
-- no fold requirement, the same three files.
do
  local files = stdFiles()
  files["lib/Voxel3D.lua"] = VOXEL_NO_FOLD
  local api = freshApi(files)
  check(Shim.consider(loader(1), mod("STADIUM2_OVERWORLD_MODELS"), api) == true,
        "STADIUM2_OVERWORLD_MODELS is patched whatever the loader says")
  check(api:read("lib/Voxel3D.lua"):find(CLIP_OUT, 1, true) ~= nil,
        "on its anchors alone, as before")
  check(Shim.consider(nil, mod("STADIUM2_OVERWORLD_MODELS"), freshApi(stdFiles())) == true,
        "and with no loader at all, as before")
  local L = loader(2, { ["mods/STADIUM2_OVERWORLD_MODELS/lib/ClipSpace.lua"] = true })
  check(Shim.consider(L, mod("STADIUM2_OVERWORLD_MODELS"), freshApi(stdFiles())) == false,
        "and still retires on lib/ClipSpace.lua")
end

-- 12. Patching twice is a no-op: the replacement destroys every anchor.
do
  for file, edits in pairs(Shim.PATCHES) do
    local src = ({ ["lib/Voxel3D.lua"] = VOXEL, ["lib/Water.lua"] = WATER,
                   ["lib/ShadowMap.lua"] = SHADOW })[file]
    local once, changed = Shim.applyPatches(src, edits)
    local twice, changedAgain = Shim.applyPatches(once, edits)
    check(changed and not changedAgain and once == twice, file .. " patches exactly once")
  end
end

_G.love = savedLove
S.finish()
