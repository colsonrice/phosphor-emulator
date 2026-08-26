-- Which shaders failed to compile, and why.
--
-- Phosphor-only. No upstream counterpart, so it replaces nothing, carries no
-- BASE_SHA256SUMS entry, and a pin bump cannot drift it.
--
-- WHY THIS EXISTS. Every renderer in this ecosystem compiles its shaders
-- defensively and swallows the result:
--
--     local ok, sh = pcall(love.graphics.newShader, src)
--     shaders[grid] = ok and sh or false
--
-- That is the right instinct and it hides the single most likely way a mod
-- breaks HERE and nowhere else. gen1recomp's conf.lua asks for LOVE "12.0" on
-- iOS and "11.5" everywhere else, so Phosphor is the only host on LOVE 12, and
-- on Apple hardware that means Metal rather than OpenGL. Mod GLSL is written
-- and tested against desktop GL, which is far more forgiving than the
-- GLSL -> Metal translation: a construct a desktop driver accepts can simply
-- refuse to compile here.
--
-- When that happens the mod does not crash and does not complain. The feature
-- silently disappears -- or worse, the nil shader reaches a call like
--
--     pcall(sh.send, sh, "vp", "row", vp)
--
-- where indexing `sh` happens BEFORE pcall can catch anything, so a failed
-- compile surfaces later as an unrelated hard error somewhere else entirely.
-- That is a miserable thing to debug from a player's "it crashes" report.
--
-- So: wrap love.graphics.newShader, count what compiles, and record what does
-- not along with the driver's own message. Semantics are preserved exactly --
-- a failure is re-raised unchanged, so every existing pcall behaves as before.
-- This only observes.

local ModShaderReport = {}

local unpack = unpack or table.unpack
local function pack(...) return { n = select("#", ...), ... } end

local MAX_RECORDED = 12   -- a shader that fails once fails every time; enough

ModShaderReport.compiled = 0
ModShaderReport.failed = 0
ModShaderReport.failures = {}   -- { { message = ..., bytes = ... }, ... }
ModShaderReport.LOG_FILE = "mod_shader_failures.log"

local function note(err, sources)
  ModShaderReport.failed = ModShaderReport.failed + 1
  local message = tostring(err)
  local bytes = 0
  for _, s in ipairs(sources) do
    if type(s) == "string" then bytes = bytes + #s end
  end

  if #ModShaderReport.failures < MAX_RECORDED then
    ModShaderReport.failures[#ModShaderReport.failures + 1] =
      { message = message, bytes = bytes }
  end

  -- The driver's message names the stage and usually the line, which is the
  -- whole value here; keep it whole rather than truncating it to a summary.
  local line = ("[ModShaderReport] shader failed to compile (%d source bytes): %s")
    :format(bytes, message)
  local Logger = package.loaded["src.core.Logger"]
  if Logger and type(Logger.warn) == "function" then
    pcall(Logger.warn, "%s", line)
  else
    print(line)
  end

  -- Post-mortem, for a report that arrives as "it crashes on my phone".
  if #ModShaderReport.failures <= MAX_RECORDED then
    pcall(function()
      local fs = love and love.filesystem
      if not (fs and fs.append) then return end
      fs.append(ModShaderReport.LOG_FILE, line .. "\n")
    end)
  end
end

function ModShaderReport.install()
  local G = love and love.graphics
  if not (G and type(G.newShader) == "function") then
    return false, "love.graphics.newShader is unavailable"
  end
  if G.__phosphorShaderReport then return false, "already installed" end

  local original = G.newShader
  G.newShader = function(...)
    local sources = { ... }
    local res = pack(pcall(original, ...))
    if res[1] then
      ModShaderReport.compiled = ModShaderReport.compiled + 1
      return unpack(res, 2, res.n)
    end
    note(res[2], sources)
    -- Re-raised unchanged. Callers pcall this and expect a throw; observing
    -- must not become a behaviour change.
    error(res[2], 0)
  end

  G.__phosphorShaderReport = true
  return true
end

function ModShaderReport.status()
  return {
    compiled = ModShaderReport.compiled,
    failed = ModShaderReport.failed,
    failures = ModShaderReport.failures,
  }
end

return ModShaderReport
