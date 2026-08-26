-- Translates a pre-sandbox pointer assignment into an `input.pointer`
-- subscription, so a mod written against `love.mousemoved` works here.
--
-- **This is NOT upstream's LegacyCompat and must not grow into it.** That
-- file is 956 lines -- a full `io` reimplementation with file handles and
-- seek, a path classifier, an overlay filesystem, an `os` table, and
-- stand-ins for love.filesystem/system/event -- and `Loader:_modEnv`
-- deliberately never constructs one. Every field on this object other than
-- `assign` exists solely because `Sandbox.envFor` reads it, and every one of
-- them is inert.
--
-- **Why this is not a new capability.** `Hooks:wrap` asserts only that the
-- name is a non-empty string and the callback is a function; there is no
-- allow-list. A mod can already write
-- `mod.hooks:wrap("input.pointer", ...)` itself. This changes the spelling
-- of a request that is already permitted, and nothing here ever writes
-- `_G.love`. That is the whole security argument, and it is why this does
-- not reopen a boundary that has had two live escapes.
--
-- **Why translating beats permitting, on this platform specifically.**
-- `input.pointer` is fed by `Game:pointerEvent`, which never sees a pointer
-- the virtual d-pad claimed at press. On a phone the pad is the only input
-- there is, and the overlay's own `love.mousemoved` (main.lua) is what
-- dispatches it -- so a mod that really owned `love.mousemoved` would sit
-- ABOVE that rule and could swallow d-pad drags. A translated mod cannot.
--
-- See docs/superpowers/specs/2026-08-25-mod-pointer-bridge-design.md.
local PointerBridge = {}

-- phase -> the legacy callback name, per pointer source.
--
-- "cancelled" folds into "released": it is the nearest thing the legacy shape
-- can express, and dropping it would leave a mod holding a pointer that never
-- came back up -- a camera that keeps turning after the finger is gone.
local MOUSE = { pressed = "mousepressed", moved = "mousemoved",
                released = "mousereleased", cancelled = "mousereleased" }
local TOUCH = { pressed = "touchpressed", moved = "touchmoved",
                released = "touchreleased", cancelled = "touchreleased" }

local TRANSLATED = {}
for _, map in ipairs({ MOUSE, TOUCH }) do
  for _, name in pairs(map) do TRANSLATED[name] = true end
end

-- `wheelmoved` is deliberately absent from both maps. There is no
-- `input.pointer` phase for a wheel and it is desktop-only, so there is
-- nothing honest to translate it INTO; refusing it and saying so beats
-- accepting an assignment that would then never fire.
local REASON =
  'love.%s cannot be assigned. For pointer input use '
  .. 'mod.hooks:wrap("input.pointer", ...), which also respects the rule that '
  .. 'a touch starting on the virtual pad belongs to the pad. For anything '
  .. 'else use mod.hooks and mod.events.'

-- modId -> { [legacy name] = true }. Read by `Loader:legacyReport`, so the
-- mod manager can say which mods lean on the old spelling. Deliberately not
-- a player-facing badge: the mod works now, and flagging it would be a
-- warning nobody reading it can act on.
local used = {}

-- Module level, NOT per bridge, and that distinction is load-bearing. The
-- question this answers is "is a pointer event already being delivered",
-- which is a fact about the EVENT, not about one mod. With a per-bridge
-- counter, mod A re-entering the pointer path made mod B's handler run TWICE
-- for one finger movement: A's own guard held, but B's counter was still
-- zero, so the inner pass delivered to B and then the outer pass delivered to
-- B again. Caught by a test, not by reasoning.
local depth = 0

function PointerBridge.report(modId)
  if modId == nil then return used end
  return used[modId]
end

-- The suites dofile into one shared process, so this has to be resettable
-- the way every other global in `mod_sandbox_tests.lua` is put back.
function PointerBridge.reset() used = {}; depth = 0 end

function PointerBridge.new(opts)
  opts = opts or {}
  local modId, hooks, log = opts.modId, opts.hooks, opts.log
  local handlers = {}
  local subscribed = false

  -- Reads of a translated name answer with a no-op, NOT with
  -- `_G.love[key]`.
  --
  -- This is the fix for a crash a device found. The pre-sandbox convention is
  --   local old = love.mousemoved
  --   love.mousemoved = function(...) ...; return old(...) end
  -- and upstream that is harmless, because the mod's function REPLACES the
  -- engine's, so `old` runs exactly once. Here the mod's handler is invoked
  -- from INSIDE love.mousemoved -> Game:mousemoved -> pointerEvent -> hooks
  -- (on iOS SDL synthesizes a mouse event from the primary touch), so an
  -- `old` that resolved to the engine's live handler re-entered the same
  -- path once per finger movement until the stack went.
  --
  -- Answering with a no-op is not just a guard, it is the truer answer: from
  -- the mod's side "the previous handler" means whatever sat before it in
  -- the chain, and for the first mod that is nothing. Mods compose through
  -- the hooks chain, which is ordered and owned, rather than by threading
  -- function references through a global table. Returning nil would not do:
  -- `loveFacade.__index` treats a nil override as "no override" and falls
  -- through to `_G.love[key]`, which is the engine's handler again.
  local function noop() end
  local bridge = {
    globals = {}, os = {},
    love = setmetatable({}, {
      __index = function(_, key)
        if TRANSLATED[key] then return noop end
        return nil
      end,
    }),
  }

  -- Inert, and present only because `Sandbox.envFor` and `loveFacade` read
  -- them. `module` returning nil is what keeps require("io") refusing: the
  -- facade falls through to its own deny list on a nil substitute.
  function bridge.module() return nil end
  function bridge.bind() end

  -- One chain link per mod, opened on the first translated assignment.
  --
  -- **It ALWAYS calls next().** A link that returns without calling next
  -- short-circuits the chain: `vanilla` never runs and every downstream mod
  -- is skipped. Suppressing the game's own handling of every touch is not
  -- something a `love.mousemoved` handler ever did, so the legacy return
  -- value is ignored rather than read as a claim. That also drags a mod
  -- which CLOBBERED `love.mousemoved` instead of chaining it -- the
  -- badly-behaved half of the pre-sandbox convention -- into behaving like
  -- the well-behaved half.
  --
  -- **The pcall below is for the depth counter, not for the mod.** `Hooks:call`
  -- already pcalls every link, and a link that throws before calling next is
  -- logged and the chain resumes, so vanilla still runs -- which is why the
  -- error is re-raised unchanged rather than swallowed. Without the pcall a
  -- throwing handler would unwind past the decrement and leave `depth` stuck
  -- above zero, silently deafening this mod's pointer input for the rest of
  -- the session. The counter itself is module level; see its declaration.

  local function invoke(p)
    local map = (p.source == "mouse") and MOUSE or TOUCH
    local handler = handlers[map[p.phase or ""] or ""]
    if handler then
      if map == MOUSE then
        -- the legacy signatures, positionally: mousemoved(x, y, dx, dy,
        -- istouch) and mouse{pressed,released}(x, y, button, istouch,
        -- presses). istouch is false because this pointer came through the
        -- mouse path; a real finger arrives with source == "touch".
        if p.phase == "moved" then
          handler(p.x, p.y, p.dx, p.dy, false)
        else
          handler(p.x, p.y, p.button or 1, false, 1)
        end
      else
        handler(p.id, p.x, p.y, p.dx, p.dy, p.pressure)
      end
    end
  end

  local function dispatch(next, _game, p)
    -- Re-entrancy backstop, belt to the no-op's braces. The no-op closes the
    -- one route a real mod took; this closes every other way back in --
    -- anything a handler does that ends up pumping another pointer event
    -- re-enters here, and the outer call has already delivered this event.
    -- Cheap, and the failure it prevents is a hard crash on a player's phone.
    if depth > 0 then return next() end
    depth = depth + 1
    local ok, err = pcall(invoke, p)
    depth = depth - 1
    if not ok then error(err, 0) end
    -- zero-arg: Hooks' nextFn reads that as "continue with the current
    -- arguments", which is what a passive observer wants.
    return next()
  end

  local function subscribe()
    if subscribed or not hooks then return end
    subscribed = true
    -- owner is the modId, so the existing `hooks:removeOwner(modId)` on mod
    -- unload detaches this with no teardown code of our own.
    hooks:wrap("input.pointer", dispatch, 0, modId)
  end

  function bridge.assign(key, value)
    if not TRANSLATED[key] then
      return false, string.format(REASON, tostring(key))
    end
    -- a non-function is not a callback chain; refuse it the same way rather
    -- than storing something dispatch would then try to call
    if value ~= nil and type(value) ~= "function" then
      return false, string.format(REASON, tostring(key))
    end
    handlers[key] = value
    subscribe()
    used[modId] = used[modId] or {}
    if not used[modId][key] then
      used[modId][key] = true
      if log then log(modId, key) end
    end
    -- NOT plain `true`. Sandbox's __newindex writes _G.love[key] on `true`,
    -- and that write is the exact hazard this module exists to avoid: on iOS
    -- the overlay's own love.mousemoved dispatches the virtual pad. "handled"
    -- is the outcome that says the assignment already went somewhere.
    return "handled"
  end

  return bridge
end

return PointerBridge
