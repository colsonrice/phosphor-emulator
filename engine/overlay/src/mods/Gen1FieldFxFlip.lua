-- The engine's own field effects, drawn into a canvas the engine then mirrors.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- WHAT A PLAYER SEES. With a 3D world mod on, the trainer "!" alert, the ledge
-- dust, the Cut animation, the healing sparkle, the Fly bird and the fishing
-- rod all come out UPSIDE DOWN, and on the mirrored half of the screen, while
-- the 3D world itself looks right. Reported Sep 23 2026 on Yellow with one
-- voxel mod installed, as "2D elements in voxel environments are flipped
-- upside down relative to the screen".
--
-- WHOSE BUG. Ours. The seam's, not the mod's, and nothing the mod can reach.
-- src/render/Renderer.lua's endFrame blits a world override with a NEGATIVE Y
-- scale on iOS + LOVE >= 12:
--
--     love.graphics.draw(self.worldOverride, vux, vuy + vuh, 0, 1/dpiX, -1/dpiY)
--
-- That line exists because the voxel mods fold Mat4.scale(1, -1, 1) into their
-- own projection, which is correct on LOVE 11 (an FBO stores clip Y = -1 in
-- texel row 0), and LOVE 12 normalises clip space so the fold is one flip too
-- many. Phosphor is the only LOVE 12 host, so the blit is there to undo it,
-- and the mods write to that contract on purpose now: potato_voxel's Gold half
-- carries the same bottom-origin negative-Y draw with a comment naming this
-- very line in this very file.
--
-- So the contract is: THE WORLD OVERRIDE CANVAS IS PRESENTED MIRRORED. The
-- engine is the one party that breaks it, because the engine draws into that
-- canvas too. src/world/OverworldController.lua builds ctx.drawFx and hands it
-- to the pipeline so the field FX composite over the finished 3D scene -- its
-- own comment: "the field FX stay ordinary 2D draws composited on top by
-- ctx.drawFx" -- and the blit then mirrors them along with everything else.
--
-- WHY NOT JUST DROP THE FLIP. Because every shipping world mod pre-flips (37
-- of the archives in the published catalog when this was written, and not one
-- of them carries the upstream lib/ClipSpace.lua fix), and because a mod's own
-- screen-space overlays go into the same canvas and depend on the mirror the
-- blit provides. Dropping it inverts all of them at once. The narrow,
-- reversible fix is to make the ENGINE's own contribution obey the ENGINE's
-- own contract.
--
-- WHAT THIS DOES. On the Gen 1 seam, and only where the blit will mirror,
-- ctx.drawFx runs under one extra transform: translate(0, H) then
-- scale(1, -1) about the bound canvas. Each effect lands at the mirrored row
-- with its own orientation mirrored, and the blit rights both. `project` is
-- passed through UNTOUCHED, which is the subtle part and the reason this is
-- one transform rather than a rewritten drawFx: project feeds the pre-flipped
-- matrix into (y/w * 0.5 + 0.5) * canvasH, so it already answers in SCREEN
-- rows. That is exactly the space this transform mirrors out of.
--
-- WHAT IT DELIBERATELY LEAVES ALONE.
--   * Gold. src/world/gen2/World.lua:drawPipeline builds a ctx with "same ctx
--     keys, same order" and composites STRAIGHT, so its identical ctx.drawFx
--     is already right and mirroring it would break it. Hence the positive
--     Gen 1 test below rather than a generation guess.
--   * A mod's own overlays inside the same canvas (potato_voxel's
--     Weather.draw, a fork's battle HUD). Those are drawn by mod code this
--     cannot reach, and rewriting a mod's draws is not this file's business.
--     They are the mod's to fix, and upstream's to make unnecessary.
--
-- DELETE THIS FILE if upstream mirrors ctx.drawFx itself, or drops the
-- negative-Y blit. Neither is detected here and NEITHER CANCELS THIS ON ITS
-- OWN: presentationMirrors() asks about the host, not about what endFrame
-- actually does, so a pin that changes that blit would leave this mirroring
-- against a straight composite and put the effects back upside down. Nothing
-- in BASE_SHA256SUMS covers Renderer.lua either, because the overlay does not
-- replace it, so a pin bump would not fail. The tripwire that catches it is in
-- tests/gen1_field_fx_flip_tests.lua: it reads the materialized Renderer.lua
-- and fails when that blit stops matching. Heed it rather than deleting it.

local Gen1FieldFxFlip = {}

-- Wrapped drawFx closures, so a ctx that somehow reaches drawWorld twice in
-- one frame is mirrored once. Weak keys: these are per-frame closures and
-- must not be kept alive by this table.
local WRAPPED = setmetatable({}, { __mode = "k" })

local function loveMajor()
  if not (love and love.getVersion) then return 11 end
  local ok, major = pcall(function() return (love.getVersion()) end)
  return ok and tonumber(major) or 11
end

local function isIOS()
  local system = love and love.system
  if not (system and system.getOS) then return false end
  local ok, name = pcall(system.getOS)
  return ok and name == "iOS"
end

-- The same question src/render/Renderer.lua's endFrame asks before it blits a
-- world override. Asked here per frame rather than cached at load, so the two
-- cannot drift apart across a host that answers late.
local function presentationMirrors()
  return isIOS() and loveMajor() >= 12
end

-- Gen 1's seam, positively identified. Gold's World:drawPipeline deliberately
-- mirrors Gen 1's ctx key for key, so the test has to rest on something the
-- two genuinely differ on, and both of these are load-bearing engine facts
-- rather than incidental shape:
--   * `isOverworld` marks Gen 1's live world state (src/world/OverworldController
--     .lua:34) and is read across the engine -- Game.lua's state kind, WorldAPI's
--     stack scan, NPC and Player. gen2/World.lua does not set it.
--   * Gold documents that it has no dust, Cut tree or rod: "Gold's only
--     standing effects ... those keys are simply absent".
-- Both must hold. Either one missing means "not proven to be Gen 1", and the
-- answer to that is to leave the frame exactly as it is: an un-mirrored FX
-- layer is the bug we already have, a wrongly mirrored one would be a new one.
local function isGen1WorldSeam(ctx)
  local state = ctx.state
  if type(state) ~= "table" or state.isOverworld ~= true then return false end
  local fx = ctx.fx
  if type(fx) ~= "table" then return false end
  return fx.dust ~= nil or fx.cutTree ~= nil or fx.rod ~= nil
end

-- Mirror about the BOUND canvas, never about ctx.height: a mod with a render
-- scale (potato_voxel ships 100/75/50/33%) draws into a smaller target and
-- lets the engine scale it up, so ctx.height is the playfield's and would put
-- every effect off by the difference.
local function boundCanvasHeight()
  local G = love and love.graphics
  if not (G and G.getCanvas) then return nil end
  local ok, bound = pcall(G.getCanvas)
  if not ok or bound == nil then return nil end
  -- LOVE hands back the canvas itself when one target is bound, and a TABLE of
  -- them when several are; in LOVE 12 an entry in that table can itself be a
  -- table carrying the canvas plus a face or layer. Asked as "can this tell me
  -- its height", not as "is this userdata", so the unwrapping is driven by what
  -- the value can do rather than by a type name that differs between LOVE's
  -- backends and any harness.
  local function isTarget(value)
    return value ~= nil and pcall(function() return value.getHeight end)
      and value.getHeight ~= nil
  end
  if not isTarget(bound) and type(bound) == "table" then
    local first = bound[1]
    if not isTarget(first) and type(first) == "table" then
      first = first.canvas or first[1]
    end
    bound = first
  end
  if not isTarget(bound) then return nil end
  local okHeight, height = pcall(function() return bound:getHeight() end)
  if not okHeight then return nil end
  height = tonumber(height)
  if not (height and height > 0) then return nil end
  return height
end

-- Exposed for the suite: the whole correction, given the height to mirror
-- about. Kept separate from the canvas lookup so the math can be driven
-- without a real render target.
function Gen1FieldFxFlip.mirrorAbout(height, body)
  local G = love.graphics
  G.push()
  local ok, err = pcall(function()
    G.translate(0, height)
    G.scale(1, -1)
    body()
  end)
  -- The transform is restored whatever happened, then the failure is handed
  -- on unchanged: Pipelines.guardRender is what decides a throwing pipeline's
  -- fate, and swallowing here would hide a mod fault from it.
  G.pop()
  if not ok then error(err, 0) end
end

local function mirrored(drawFx)
  local wrapper = function(project, scale)
    local height = boundCanvasHeight()
    -- Nothing bound means this pipeline is compositing somewhere this cannot
    -- reason about. Leave the frame exactly as it would have been.
    if not height then return drawFx(project, scale) end
    return Gen1FieldFxFlip.mirrorAbout(height, function()
      drawFx(project, scale)
    end)
  end
  WRAPPED[wrapper] = true
  return wrapper
end

Gen1FieldFxFlip.presentationMirrors = presentationMirrors  -- named for the suite
Gen1FieldFxFlip.isGen1WorldSeam = isGen1WorldSeam

-- Wraps src/render/Pipelines.lua's drawWorld rather than the state that builds
-- the ctx, because drawWorld is the ONE place both seams funnel through and
-- the only one reachable without overlaying a 6000-line pin file.
function Gen1FieldFxFlip.install()
  local ok, Pipelines = pcall(require, "src.render.Pipelines")
  if not (ok and type(Pipelines) == "table"
          and type(Pipelines.drawWorld) == "function") then
    return false, "src.render.Pipelines is unavailable"
  end
  if Pipelines.__phosphorFieldFxFlip then return false, "already installed" end

  local original = Pipelines.drawWorld
  Pipelines.drawWorld = function(id, ctx)
    if type(ctx) == "table" and type(ctx.drawFx) == "function"
        and not WRAPPED[ctx.drawFx]
        and presentationMirrors() and isGen1WorldSeam(ctx) then
      ctx.drawFx = mirrored(ctx.drawFx)
    end
    return original(id, ctx)
  end
  Pipelines.__phosphorFieldFxFlip = true
  return true
end

return Gen1FieldFxFlip
