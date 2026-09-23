-- The engine's field effects inside a canvas the engine mirrors.
--
-- The claim under test is geometric, not structural, so the fake love.graphics
-- below is a real (if tiny) affine transform stack: the checks ask where a
-- pixel actually LANDS, then apply the presentation blit by hand and ask where
-- the player sees it. A test that only asserted "push/translate/scale were
-- called" would have passed for a mirror about the wrong axis, the wrong
-- height, or in the wrong order.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("gen1 field fx flip")
local check = S.check

-- ------- a love.graphics that can be asked where a point ended up

local G = {}
local stack

local function reset()
  stack = { { ox = 0, oy = 0, sx = 1, sy = 1 } }
end

local function top() return stack[#stack] end

function G.push()
  local t = top()
  stack[#stack + 1] = { ox = t.ox, oy = t.oy, sx = t.sx, sy = t.sy }
end

function G.pop()
  if #stack > 1 then stack[#stack] = nil end
end

function G.translate(dx, dy)
  local t = top()
  t.ox, t.oy = t.ox + t.sx * dx, t.oy + t.sy * dy
end

function G.scale(kx, ky)
  local t = top()
  t.sx, t.sy = t.sx * kx, t.sy * (ky or kx)
end

-- where a point drawn at (x, y) under the current transform lands in the canvas
local function landsAt(x, y)
  local t = top()
  return t.ox + t.sx * x, t.oy + t.sy * y
end

local CANVAS_H = 400
local boundCanvas = { getHeight = function() return CANVAS_H end }
function G.getCanvas() return boundCanvas end

local osName, majorVersion = "iOS", 12
love = {
  graphics = G,
  system = { getOS = function() return osName end },
  getVersion = function() return majorVersion, 0, 0, "" end,
}

reset()

local Flip = require("src.mods.Gen1FieldFxFlip")

-- ------- the seam test

local GEN1_CTX = {
  state = { isOverworld = true },
  fx = { emote = function() end, dust = function() end, rod = function() end },
}
-- src/world/gen2/World.lua builds this deliberately identical, minus the
-- marker and minus the three effects Gold does not have.
local GEN2_CTX = { state = {}, fx = { emote = function() end } }

check(Flip.isGen1WorldSeam(GEN1_CTX), "Gen 1's world state is recognised")
check(not Flip.isGen1WorldSeam(GEN2_CTX), "Gold's is not, so its ctx is left alone")
check(not Flip.isGen1WorldSeam({ state = { isOverworld = true }, fx = {} }),
  "the marker alone is not enough: no Gen 1 effect keys, no claim")
-- The mirror image of that, and the one that keeps both halves honest: the
-- effect keys alone are not enough either. Gold reaches this code through the
-- same drawWorld, and a fork that grows a dust effect must not become Gen 1.
check(not Flip.isGen1WorldSeam({ state = {}, fx = { dust = function() end } }),
  "effect keys without the isOverworld marker are refused")
check(not Flip.isGen1WorldSeam({ state = { isOverworld = true } }),
  "a ctx with no fx table at all is refused rather than assumed")

check(Flip.presentationMirrors(), "iOS on LOVE 12 is where endFrame mirrors")
majorVersion = 11
check(not Flip.presentationMirrors(), "LOVE 11 blits straight, so nothing to undo")
majorVersion = 12
osName = "Android"
check(not Flip.presentationMirrors(), "and no other host reaches that branch")
osName = "iOS"

-- ------- the geometry, against the real engine `at`

-- src/world/OverworldController.lua's ctx.drawFx, reproduced exactly: this is
-- the code whose output the shim has to land correctly.
local function engineAt(project, scale, wx, wy, camX, camY, drawAt)
  local sx, sy = project(wx, wy)
  if not sx then return nil end
  local fx, fy = wx - camX, wy - camY
  G.push()
  G.scale(scale, scale)
  G.translate(sx / scale - fx, sy / scale - fy)
  local px, py = landsAt(drawAt[1], drawAt[2])
  G.pop()
  return px, py
end

-- The presentation blit: src/render/Renderer.lua draws the override from the
-- bottom edge with a negative Y scale, so canvas row r reaches screen row H-r.
local function onScreen(row) return CANVAS_H - row end

local CAM_X, CAM_Y = 100, 200
local NPC_X, NPC_Y = 148, 264            -- the foot `at` is anchored to
local SCREEN_ROW = 120                   -- where the pipeline projects that foot
local SCALE = 2
-- Voxel3D.project answers in SCREEN rows: it feeds the pre-flipped matrix into
-- (y / w * 0.5 + 0.5) * canvasH, and the fold makes clip -1 the top.
local function project() return 260, SCREEN_ROW end

-- fxEmote draws the bubble 36 world pixels above the foot it is anchored to
-- (npc.py - cam.y - 20 against an anchor of npc.py + 16 - cam.y).
local FOOT = { NPC_X - CAM_X, NPC_Y - CAM_Y }
local BUBBLE = { NPC_X - CAM_X, NPC_Y - CAM_Y - 36 }

-- what ships today, with nothing wrapping drawFx
reset()
local _, footRow = engineAt(project, SCALE, NPC_X, NPC_Y, CAM_X, CAM_Y, FOOT)
local _, bubbleRow = engineAt(project, SCALE, NPC_X, NPC_Y, CAM_X, CAM_Y, BUBBLE)
check(onScreen(footRow) == CANVAS_H - SCREEN_ROW,
  "today the effect's anchor is presented at the mirrored screen row")
check(onScreen(bubbleRow) > onScreen(footRow),
  "and the bubble that belongs ABOVE the trainer is presented below it")

-- the same frame, with the shim's one transform around it
reset()
local footRow2, bubbleRow2
Flip.mirrorAbout(CANVAS_H, function()
  _, footRow2 = engineAt(project, SCALE, NPC_X, NPC_Y, CAM_X, CAM_Y, FOOT)
  _, bubbleRow2 = engineAt(project, SCALE, NPC_X, NPC_Y, CAM_X, CAM_Y, BUBBLE)
end)
check(onScreen(footRow2) == SCREEN_ROW,
  "mirrored, the anchor is presented exactly where the pipeline projected it")
check(onScreen(bubbleRow2) == SCREEN_ROW - 36 * SCALE,
  "and the bubble sits its 36 scaled pixels ABOVE the trainer, upright")
check(#stack == 1, "the transform stack is left balanced")

-- A body that throws still leaves the stack balanced, and still throws: it is
-- Pipelines.guardRender's job to decide what a failing pipeline costs.
reset()
local threw = not pcall(Flip.mirrorAbout, CANVAS_H, function() error("boom", 0) end)
check(threw, "a throwing effect chain is handed on, not swallowed")
check(#stack == 1, "and the transform stack is still balanced after it")

-- ------- installation

local drawnWith, returned = nil, {}
local Pipelines = { drawWorld = function(id, ctx)
  drawnWith = ctx
  returned[#returned + 1] = id
  return "canvas"
end }
package.loaded["src.render.Pipelines"] = Pipelines

check(Flip.install() == true, "the wrap installs over src.render.Pipelines")
check(select(1, Flip.install()) == false, "and refuses to install twice")

local calls = 0
local function freshCtx(base)
  local ctx = { state = base.state, fx = base.fx }
  ctx.drawFx = function() calls = calls + 1 end
  return ctx
end

reset()
local g1 = freshCtx(GEN1_CTX)
local before = g1.drawFx
check(Pipelines.drawWorld("voxel", g1) == "canvas",
  "the wrap is transparent: the pipeline's own return reaches the caller")
check(g1.drawFx ~= before, "Gen 1's drawFx is replaced with the mirrored one")

reset()
local g2 = freshCtx(GEN2_CTX)
local g2Before = g2.drawFx
Pipelines.drawWorld("voxel", g2)
check(g2.drawFx == g2Before, "Gold's drawFx is handed through untouched")

osName = "Android"
reset()
local desktop = freshCtx(GEN1_CTX)
local desktopBefore = desktop.drawFx
Pipelines.drawWorld("voxel", desktop)
check(desktop.drawFx == desktopBefore,
  "and on a host that blits straight, Gen 1's is untouched too")
osName = "iOS"

-- A ctx that reaches drawWorld twice must be mirrored once, not twice: two
-- mirrors is the original bug wearing a different hat.
reset()
local twice = freshCtx(GEN1_CTX)
Pipelines.drawWorld("voxel", twice)
local onceWrapped = twice.drawFx
Pipelines.drawWorld("voxel", twice)
check(twice.drawFx == onceWrapped, "a second pass over the same ctx re-wraps nothing")

-- With no render target bound there is no height to mirror about, so the
-- frame is drawn exactly as it would have been.
reset()
local noCanvas = freshCtx(GEN1_CTX)
Pipelines.drawWorld("voxel", noCanvas)
local saved = G.getCanvas
G.getCanvas = function() return nil end
calls = 0
noCanvas.drawFx(project, SCALE)
G.getCanvas = saved
check(calls == 1, "with nothing bound the effects still draw")
check(#stack == 1, "and no transform was pushed for them")

-- The height has to survive every shape getCanvas answers in. A mod that binds
-- a colour target plus a depth buffer gets the table form, and a LOVE 12 mod
-- binding a slice gets the table-inside-the-table form; both are the SAME
-- effects going into the SAME image, and neither may silently skip the mirror.
-- Measured, not asserted about: under the mirror the canvas origin lands at
-- the canvas height, and under no mirror it stays at 0. So the row that
-- drawing coordinate 0 reaches IS the height that was mirrored about.
local function heightMirroredAbout(shape)
  local saved = G.getCanvas
  G.getCanvas = function() return shape end
  reset()
  local landed
  local ctx = { state = GEN1_CTX.state, fx = GEN1_CTX.fx,
                drawFx = function() landed = select(2, landsAt(0, 0)) end }
  Pipelines.drawWorld("voxel", ctx)
  ctx.drawFx(project, SCALE)
  G.getCanvas = saved
  return landed
end
check(heightMirroredAbout(boundCanvas) == CANVAS_H,
  "one bound canvas is mirrored about its own height")
check(heightMirroredAbout({ boundCanvas, depthstencil = {} }) == CANVAS_H,
  "a colour target bound alongside a depth buffer is still found")
check(heightMirroredAbout({ { canvas = boundCanvas, face = 1 } }) == CANVAS_H,
  "and so is one bound as a slice of an array texture")
check(heightMirroredAbout({ {} }) == 0,
  "a shape with no target in it mirrors nothing, rather than about zero")

-- ------- the tripwire: the engine behaviour this whole file assumes
--
-- Everything here is a correction for ONE line of upstream's src/render/
-- Renderer.lua. If a pin bump changes that line, this stops being a fix and
-- becomes the bug: it would mirror the effects against a composite that no
-- longer mirrors them back. Nothing else catches that. The overlay does not
-- replace Renderer.lua, so it has no BASE_SHA256SUMS entry and port_overlay.sh
-- has nothing to compare; the build would go green and the "!" would be upside
-- down again with a different cause.
--
-- So the assumption is asserted against the materialized engine, not trusted.
-- Read from wherever the suite is run: the overlay directory beside the work
-- tree, or the work tree itself once the overlay has been laid over it.
local BLIT = "love.graphics.draw(self.worldOverride, vux, vuy + vuh, 0, 1 / dpiX, -1 / dpiY)"
local function engineRenderer()
  for _, path in ipairs({ "src/render/Renderer.lua",
                          "../.gen1recomp-work/src/render/Renderer.lua" }) do
    local handle = io.open(path, "r")
    if handle then
      local body = handle:read("*a")
      handle:close()
      if body and #body > 0 then return body, path end
    end
  end
  return nil
end

local renderer, rendererPath = engineRenderer()
if renderer then
  check(renderer:find(BLIT, 1, true) ~= nil,
    "the engine still mirrors the world override, which is the ONLY reason "
      .. "this file exists (" .. rendererPath .. ")")
else
  -- Not a pass dressed as a skip: say so, so a run that silently stopped
  -- checking this is visible in the output rather than inferred from a count.
  check(false, "TRIPWIRE NOT RUN: could not read the engine's Renderer.lua")
end

-- ------- the wiring, through the REAL Pipelines and the REAL Loader
--
-- Everything above drives a stub, so all of it would still pass if nothing
-- ever called install(). This block is the one that fails when the shim ships
-- unwired: the overlay's src/mods/Loader.lua installs it at module scope, the
-- same place and the same way as ModRenderGuard, and that is the only thing
-- that makes any of the rest reach a player.
--
-- Skipped under an interpreter that cannot load the Loader (Lua 5.4 has no
-- `bit`, which src/mods/StreamMD5.lua requires); run under luajit to get it.
package.loaded["src.render.Pipelines"] = nil
local okReal, RealPipelines = pcall(require, "src.render.Pipelines")
local okLoader = okReal and pcall(require, "src.mods.Loader")
if okLoader and type(RealPipelines) == "table" then
  check(RealPipelines.__phosphorFieldFxFlip == true,
    "requiring the overlay's Loader installs the wrap on the real Pipelines")

  -- and the real drawWorld still routes a registered pipeline, mirrored.
  reset()
  local sawMirroredAnchor
  RealPipelines.install({ render_pipelines = {
    ["phosphor-fx-flip-probe"] = {
      label = "PROBE",
      drawWorld = function(ctx)
        ctx.drawFx(project, SCALE)
        return nil        -- nil is the engine's "declined this frame"
      end,
    },
  } })
  local probe = {
    state = { isOverworld = true },
    fx = { dust = function() end },
    drawFx = function(p, s)
      local _, row = engineAt(p, s, NPC_X, NPC_Y, CAM_X, CAM_Y, FOOT)
      sawMirroredAnchor = onScreen(row) == SCREEN_ROW
    end,
  }
  RealPipelines.drawWorld("phosphor-fx-flip-probe", probe)
  check(sawMirroredAnchor == true,
    "and a real pipeline's effects come back out the right way up")
else
  check(true, "real-Pipelines wiring skipped: this interpreter cannot load the Loader")
end

S.finish()
