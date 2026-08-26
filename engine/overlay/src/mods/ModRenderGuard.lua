-- A rendering mod costs you a frame, never your session.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- WHAT GOES WRONG WITHOUT THIS. src/mods/Hooks.lua already runs every link
-- under pcall, so a throwing mod is usually logged and skipped. Two things it
-- does NOT do:
--
--   1. It never restores GRAPHICS STATE. A mod that throws part-way through
--      drawing leaves behind whatever it had set: its own shader, its depth
--      mode, an unbalanced transform, and -- worst -- its own canvas still
--      bound. The engine then draws the rest of the frame into the mod's
--      offscreen target with the mod's shader. Note that love.graphics.push
--      ("all") does NOT save the render target, so even Pipelines.guardRender
--      leaks a bound canvas; the restore here is explicit for that reason.
--
--   2. It re-raises in two paths (vanilla already ran with no downstream
--      result, and a PASS-wrapped vanilla error). An error that escapes the
--      hook chain unwinds into boot.lua and CLOSES THE VM -- see LoveHost's
--      stepFrame. To a player that is the game vanishing mid-battle.
--
-- WHY PHOSPHOR SEES THIS AND NOTHING ELSE DOES. gen1recomp's conf.lua asks for
-- LOVE "12.0" on iOS and "11.5" everywhere else, so Phosphor is the only host
-- running LOVE 12, and on Apple hardware that means the METAL backend rather
-- than OpenGL. Metal is far stricter about exactly the state this leaks:
-- drawing with a shader whose uniforms were never bound, or into a target with
-- no depth buffer, is a validation abort where a desktop GL driver quietly
-- tolerates it. The mods are written and tested against 11.5 on GL, so the
-- same latent bug is invisible on Windows, Linux, macOS and Android and fatal
-- here.
--
-- WHAT THIS DOES. Around every render.* hook: snapshot the canvas, push the
-- full graphics state, run the chain, then restore both no matter what
-- happened. A failure is swallowed rather than propagated, because losing one
-- composed frame is always better than losing the session. After
-- RETIRE_AFTER consecutive failures the hook is retired and only the engine's
-- own renderer runs, so a broken frame degrades to plain 2D instead of storming
-- the log at 60 Hz.
--
-- Note what this can and cannot see. A mod link that throws BEFORE calling
-- next() is caught by Hooks itself, logged, and skipped, so the chain returns
-- normally and never reaches the failure path here -- but its graphics state
-- is still restored below, which is the whole point. Only an error that
-- ESCAPES the chain (upstream re-raises when vanilla itself threw) is counted
-- and retired against.
--
-- Non-render hooks are passed through untouched: their semantics are the
-- engine's business and errors there are not a graphics-state problem.

local ModRenderGuard = {}

local RETIRE_AFTER = 10

-- read back with mod.storage or a container pull; see docs
ModRenderGuard.LOG_FILE = "mod_render_failures.log"

local unpack = unpack or table.unpack
local function pack(...) return { n = select("#", ...), ... } end

ModRenderGuard.failures = {}    -- hook name -> consecutive failure count
ModRenderGuard.retired = {}     -- hook name -> true once given up on
ModRenderGuard.lastError = nil  -- { hook, message } for the diagnostics screen
ModRenderGuard.totalFailures = 0

local function isRenderHook(name)
  return type(name) == "string" and name:find("^render%.") ~= nil
end

local function note(name, err)
  local count = (ModRenderGuard.failures[name] or 0) + 1
  ModRenderGuard.failures[name] = count
  ModRenderGuard.totalFailures = ModRenderGuard.totalFailures + 1
  ModRenderGuard.lastError = { hook = name, message = tostring(err) }
  -- first of a run, and the moment it is given up on: loud enough to find in a
  -- device console, quiet enough not to be the reason the frame is late
  if count == 1 or count == RETIRE_AFTER then
    local Logger = package.loaded["src.core.Logger"]
    local line = ("[ModRenderGuard] %s failed (%d): %s"):format(name, count,
                                                                tostring(err))
    if Logger and type(Logger.warn) == "function" then
      pcall(Logger.warn, "%s", line)
    else
      print(line)
    end
  end
  -- Post-mortem. The console line above is gone the moment the player closes
  -- the app, and a remote report of "it crashed" is unactionable without it.
  -- Once per hook per session, so a 60 Hz failure cannot fill the disk.
  if count == 1 then
    pcall(function()
      local fs = love and love.filesystem
      if not (fs and fs.append) then return end
      fs.append(ModRenderGuard.LOG_FILE,
        ("%s\t%s\n"):format(tostring(name), tostring(err)))
    end)
  end
  if count >= RETIRE_AFTER then ModRenderGuard.retired[name] = true end
end

-- Restore the frame the engine handed us. Canvas last and explicitly, because
-- it is the one piece push/pop does not carry and the one that ruins the rest
-- of the frame when it is wrong.
local function restore(prevOk, prevCanvas)
  local G = love and love.graphics
  if not G then return end
  pcall(G.pop)
  pcall(G.setShader)
  if prevOk then
    if prevCanvas then pcall(G.setCanvas, prevCanvas) else pcall(G.setCanvas) end
  end
end

function ModRenderGuard.install()
  local ok, Hooks = pcall(require, "src.mods.Hooks")
  if not (ok and type(Hooks) == "table" and type(Hooks.call) == "function") then
    return false, "src.mods.Hooks is unavailable"
  end
  if Hooks.__phosphorRenderGuard then return false, "already installed" end

  local original = Hooks.call
  Hooks.call = function(self, name, vanilla, ...)
    if not isRenderHook(name) then
      return original(self, name, vanilla, ...)
    end
    local G = love and love.graphics
    if not G then return original(self, name, vanilla, ...) end

    -- Given up on: mods are out of the picture for this hook, but the engine
    -- still gets to draw, under the same guard. Calling vanilla bare here was
    -- a bug -- the path that retires this hook is the one where VANILLA is
    -- what throws, so an unprotected call made the failure worse.
    if ModRenderGuard.retired[name] then
      local rOk, rCanvas = pcall(G.getCanvas)
      pcall(G.push, "all")
      local r = pack(pcall(vanilla, ...))
      restore(rOk, rCanvas)
      if r[1] then return unpack(r, 2, r.n) end
      return nil
    end

    local prevOk, prevCanvas = pcall(G.getCanvas)
    pcall(G.push, "all")
    local res = pack(pcall(original, self, name, vanilla, ...))
    restore(prevOk, prevCanvas)

    if res[1] then
      ModRenderGuard.failures[name] = 0
      return unpack(res, 2, res.n)
    end
    note(name, res[2])
    -- swallowed on purpose: this returns nothing, which every render hook
    -- call site already treats as "the mod declined this frame"
    return nil
  end

  Hooks.__phosphorRenderGuard = true
  return true
end

-- for the diagnostics screen and the suite
function ModRenderGuard.status()
  return {
    totalFailures = ModRenderGuard.totalFailures,
    lastError = ModRenderGuard.lastError,
    retired = ModRenderGuard.retired,
  }
end

return ModRenderGuard
