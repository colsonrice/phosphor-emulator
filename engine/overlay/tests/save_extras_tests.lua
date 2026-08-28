-- SaveExtras: the sidecar that carries a modded bag across devices.
--
-- A Game Boy bag holds 20 items and the PC 50, so GenSave.encode drops
-- everything past those caps -- and the host's iCloud sync carries nothing
-- BUT that 32 KiB cartridge image, so a player whose mods gave them a 43-slot
-- bag lost the tail of it on every device hop.  The tail is systematically the
-- TMs and HMs: the ROM extractor gives machine items no `index`, so Bag.order
-- sorts them last, and you pick them up late anyway.
--
-- These tests run the REAL codec, not a stand-in: encode really does drop the
-- items, and the assertions are that capture + apply put them back.
--
-- Run: luajit tests/save_extras_tests.lua

package.path = "./?.lua;./?/init.lua;" .. package.path

-- 0.2.34 (#1691): encode REFUSES an export whose map window cannot be
-- built, instead of silently writing a save that jumbles the 2D map.
-- This suite runs with no generated map data, and the extras hop under
-- test has nothing to do with maps -- satisfy the new contract with the
-- smallest possible context. Loaded BEFORE GenSave, which captures the
-- module at require time.
package.loaded["src.save_convert.MapContext"] = {
  build = function()
    return { writes = {}, spriteData = {}, tileAnimations = 0 }
  end,
}

local S = require("tests.harness").suite("save extras")
local check, eq = S.check, S.eq

local GenSave = require("src.save_convert.GenSave")
local SaveExtras = require("src.save_convert.SaveExtras")

GenSave.setCharmap(loadfile("src/save_convert/data/charmap.lua")())

-- ------------------------------------------------------------------
-- A crosswalk dataset shaped exactly like RomExtractor:extractItems():
-- ordinary items carry a sequential `index`, TM/HM entries carry NONE --
-- only machine = {kind, number, move}, which is what makes them sort last.
-- ------------------------------------------------------------------
local PLAIN = {
  "MASTER_BALL", "ULTRA_BALL", "GREAT_BALL", "POKE_BALL", "TOWN_MAP", "BICYCLE",
  "MOON_STONE", "ANTIDOTE", "BURN_HEAL", "ICE_HEAL", "AWAKENING", "PARLYZ_HEAL",
  "FULL_RESTORE", "MAX_POTION", "HYPER_POTION", "SUPER_POTION", "POTION",
  "ESCAPE_ROPE", "REPEL", "RARE_CANDY", "REVIVE", "FULL_HEAL",
}
local HMS = { "CUT", "FLY", "SURF", "STRENGTH", "FLASH" }

local function dataset()
  local items = {}
  for i, id in ipairs(PLAIN) do
    items[id] = { id = id, index = i, name = id, price = 100 }
  end
  for number, move in ipairs(HMS) do
    items["HM_" .. move] = { id = "HM_" .. move, name = ("HM%02d"):format(number),
      price = 0, machine = { kind = "HM", number = number, move = move } }
  end
  for number = 1, 50 do
    local id = "TM_MOVE" .. number
    items[id] = { id = id, name = ("TM%02d"):format(number), price = 1000,
      machine = { kind = "TM", number = number, move = "MOVE" .. number } }
  end
  return { items = items, pokemon = {}, moves = {}, maps = {} }
end

local function newSave()
  return {
    meta = { format = "gen1_import" },
    player = { name = "RED", rival = "BLUE", id = 12345,
               map = "PALLET_TOWN", x = 3, y = 3 },
    money = 3000, coins = 0,
    inventory = {}, pcItems = {}, bagOrder = {}, pcOrder = {},
    pokedex = { seen = {}, owned = {} }, flags = {},
    party = {}, boxes = {}, currentBox = 1,
  }
end

-- The bag a modded session actually holds: Bottomless Bag / "Bag and PC 999"
-- raise constants.bagSize, so the ordinary carry is followed by every HM and a
-- pile of TMs -- 43 distinct ids where the cartridge has room for 20.
local function moddedSave()
  local save = newSave()
  local function carry(id, qty)
    save.inventory[id] = qty
    save.bagOrder[#save.bagOrder + 1] = id
  end
  for i = 1, 18 do carry(PLAIN[i], 3) end
  for _, move in ipairs(HMS) do carry("HM_" .. move, 1) end
  for i = 1, 20 do carry("TM_MOVE" .. i, 1) end
  return save
end

local STAMP = "b7e2" .. string.rep("0", 60)   -- a .sav fingerprint, any string

-- ------------------------------------------------------------------
-- The whole point: a bag the cartridge cannot hold survives the hop
-- ------------------------------------------------------------------
do
  local data, save = dataset(), moddedSave()
  local before = #save.bagOrder
  eq(before, 43, "the modded bag holds 43 distinct items before the export")

  local doc = SaveExtras.capture(save, STAMP)
  local bytes = GenSave.encode(save, data, nil, nil)
  eq(bytes:byte(GenSave.OFFSETS.numBagItems + 1), 20,
     "the cartridge image itself still holds only 20 -- the sidecar does not forge SRAM")

  local landed = GenSave.decode(bytes, data)
  local kept = 0
  for _ in pairs(landed.inventory) do kept = kept + 1 end
  eq(kept, 20, "and the decode alone is still the 20-item loss this bug is about")

  check(SaveExtras.apply(landed, doc, STAMP), "a matching sidecar applies")

  local missing = {}
  for _, id in ipairs(save.bagOrder) do
    if landed.inventory[id] ~= save.inventory[id] then missing[#missing + 1] = id end
  end
  eq(#missing, 0, "every bag item is back with its quantity: missing "
                  .. table.concat(missing, ", "))
  eq(#landed.bagOrder, before, "and the bag is in its original order, whole")
  -- 18 ordinary items, then the HMs in HMS order: CUT 19, FLY 20, SURF 21
  eq(landed.bagOrder[21], "HM_SURF", "HM SURF is where the player left it")
end

-- ------------------------------------------------------------------
-- Items a MOD added have no cartridge id at all, so encode drops them
-- without even spending a slot
-- ------------------------------------------------------------------
do
  local data, save = dataset(), newSave()
  save.inventory = { POTION = 2, MOD_MEGA_STONE = 1, HM_SURF = 1 }
  save.bagOrder = { "POTION", "MOD_MEGA_STONE", "HM_SURF" }

  local doc = SaveExtras.capture(save, STAMP)
  local landed = GenSave.decode(GenSave.encode(save, data, nil, nil), data)
  check(landed.inventory.MOD_MEGA_STONE == nil,
        "a mod's own item cannot survive the cartridge on its own")

  SaveExtras.apply(landed, doc, STAMP)
  eq(landed.inventory.MOD_MEGA_STONE, 1, "the sidecar brings it back")
  eq(landed.bagOrder[2], "MOD_MEGA_STONE", "in the slot it occupied")
end

-- ------------------------------------------------------------------
-- The PC has the same shape of cap, 50 instead of 20
-- ------------------------------------------------------------------
do
  local data, save = dataset(), newSave()
  for i = 1, 60 do
    local id = "PC_ITEM_" .. i
    data.items[id] = { id = id, index = 100 + i, name = id, price = 1 }
    save.pcItems[id] = 1
    save.pcOrder[#save.pcOrder + 1] = id
  end
  local doc = SaveExtras.capture(save, STAMP)
  local landed = GenSave.decode(GenSave.encode(save, data, nil, nil), data)
  local kept = 0
  for _ in pairs(landed.pcItems) do kept = kept + 1 end
  eq(kept, 50, "the cartridge PC holds 50")

  SaveExtras.apply(landed, doc, STAMP)
  local back = 0
  for _ in pairs(landed.pcItems) do back = back + 1 end
  eq(back, 60, "all 60 PC slots come back")
end

-- ------------------------------------------------------------------
-- A sidecar must never speak for a save it did not come from.  The stamp is
-- the fingerprint of the exact .sav that was exported beside it: if the
-- player took that cartridge into the 2D emulator and spent a Potion, the
-- bytes moved and the sidecar is stale -- ignoring it is the honest answer,
-- resurrecting 23 items into someone else's afternoon is not.
-- ------------------------------------------------------------------
do
  local data, save = dataset(), moddedSave()
  local doc = SaveExtras.capture(save, STAMP)
  local landed = GenSave.decode(GenSave.encode(save, data, nil, nil), data)

  check(not SaveExtras.apply(landed, doc, "a-different-cartridge"),
        "a sidecar stamped for other bytes is refused")
  local kept = 0
  for _ in pairs(landed.inventory) do kept = kept + 1 end
  eq(kept, 20, "and it changed nothing on its way out")

  check(not SaveExtras.apply(landed, "{ not json", STAMP), "garbage is refused")
  check(not SaveExtras.apply(landed, nil, STAMP), "an absent sidecar is not an error")
  eq(#landed.bagOrder, 20, "still the cartridge's own 20")
end

-- ------------------------------------------------------------------
-- Badges live in save.inventory beside the bag but are NOT bag items: they
-- come off the SRAM badge byte on import, and the sidecar must not carry
-- them or a stale copy could hand someone a badge they no longer have.
-- ------------------------------------------------------------------
do
  local data, save = dataset(), newSave()
  save.inventory = { POTION = 1, BOULDERBADGE = 1, CASCADEBADGE = 1 }
  save.bagOrder = { "POTION" }

  local doc = SaveExtras.capture(save, STAMP)
  check(not doc:find("BOULDERBADGE", 1, true), "no badge is written into the sidecar")

  local landed = GenSave.decode(GenSave.encode(save, data, nil, nil), data)
  eq(landed.inventory.BOULDERBADGE, 1, "the badge came off the SRAM badge byte")
  SaveExtras.apply(landed, doc, STAMP)
  eq(landed.inventory.BOULDERBADGE, 1, "and applying the sidecar leaves it alone")
  eq(landed.inventory.POTION, 1, "while the bag still applies")
end

S.finish()
