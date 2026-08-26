-- The Gold wild-alert crash: the mod builds `ow.emote` with no `left`, and
-- Gold's World:update ticks any emote through `self.emote.left - 1`. This
-- suite is the guard on the patch that inserts the field, because the patch
-- is an exact string replacement against a file we do not own: upstream
-- reformatting that table silently stops it applying, and the only symptom
-- is the crash coming back.
package.path = "./?.lua;./?/init.lua;" .. package.path

local S = require("tests.harness").suite("gen2 wild alert fix")
local check = S.check

local Fix = require("src.mods.Gen2WildAlertFix")
local edits = Fix.PATCHES["lib/spawn_logic.lua"]

-- The shape the mod ships, verbatim enough to match the anchor.
local MOD_SOURCE = [[
local function alert(entity, frames)
  ow.emote = {
    npc = entity,
    frames = frames,
    onDone = function()
      ow.emote = nil
    end,
  }
end
]]

local patched, changed = Fix.applyPatches(MOD_SOURCE, edits)
check(changed, "the anchor still matches the mod's source")
check(patched:find("left = frames", 1, true) ~= nil, "the field the engine ticks is inserted")
check(patched:find("npc = entity", 1, true) ~= nil, "and the rest of the table survives")
check(patched:find("onDone = function()", 1, true) ~= nil, "including onDone, which is not ours to touch")

-- Twice must not insert twice: the anchor runs through onDone so patching
-- destroys it.
local again, changedAgain = Fix.applyPatches(patched, edits)
check(not changedAgain, "a second pass is a no-op")
local count = 0
for _ in again:gmatch("left = frames") do count = count + 1 end
check(count == 1, "exactly one `left`, not two")

-- A source that never matched is returned untouched.
local other, otherChanged = Fix.applyPatches("local x = 1\n", edits)
check(not otherChanged and other == "local x = 1\n", "an unrelated file is left alone")

-- When upstream merges the PR, the patch must retire itself rather than
-- fight a table that already sets the field.
local upstreamFixed = MOD_SOURCE:gsub("    frames = frames,\n",
                                      "    frames = frames,\n    left = frames,\n", 1)
check(upstreamFixed:find("left = frames", 1, true) ~= nil, "fixture sanity")
local consideredFile = nil
local api = {
  read = function(_, relative)
    consideredFile = relative
    return upstreamFixed, #upstreamFixed
  end,
}
local mod = { manifest = { id = "STADIUM2_OVERWORLD_MODELS" } }
check(Fix.consider(nil, mod, api) == true, "the fix hooks the mod it is for")
local returned = api:read("lib/spawn_logic.lua")
check(consideredFile == "lib/spawn_logic.lua", "it reads through the mod's own api")
local n = 0
for _ in returned:gmatch("left = frames") do n = n + 1 end
check(n == 1, "an already-fixed upstream is not patched a second time")

-- And it is a no-op for every other mod.
local untouched = { read = function(_, _) return MOD_SOURCE, #MOD_SOURCE end }
check(Fix.consider(nil, { manifest = { id = "SOME_OTHER_MOD" } }, untouched) == false,
      "no other mod is touched")

S.finish()
