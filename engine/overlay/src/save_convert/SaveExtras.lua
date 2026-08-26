-- SaveExtras -- the sidecar that carries a modded bag between the player's
-- devices, because the cartridge save cannot.
--
-- Phosphor's iCloud sync moves `.sav` files and save states and nothing else,
-- so the ONLY thing that reaches a player's other device is the 32768-byte
-- Gen 1 cartridge image this engine exports at the end of a session. A Game
-- Boy bag has room for 20 items and the PC for 50 (GenSave.encode's
-- encodeItemList caps), and mods routinely hand players far more than that --
-- the public mod API's `constants.bagSize` is exactly how Bottomless Bag and
-- "Bag and PC 999 Item Slots" work. Everything past the cap was written
-- nowhere and reported by no one.
--
-- The casualties were never random. RomExtractor gives TM/HM entries no
-- `index` (only machine = {kind, number, move}), so Bag.order scores them
-- math.huge and sorts them to the very end of the bag -- and you pick TMs up
-- late anyway. The tail is what the 20-slot write drops, and the tail is the
-- TMs and the HMs. A player who cloud-saved arrived on their iPad unable to
-- SURF.
--
-- So: beside the exported `.sav`, write down what the bag and the PC actually
-- held, and put it back on the far side. The cartridge image stays a
-- completely ordinary cartridge image -- a real Game Boy, and Phosphor's own
-- 2D emulator, read exactly what they read before, and nothing here forges a
-- byte of SRAM.
--
-- The stamp is what keeps this honest. It fingerprints the exact `.sav` the
-- sidecar was written beside, and apply() refuses on any mismatch. Play that
-- cartridge in the 2D emulator and spend one Potion and the bytes move, the
-- sidecar goes stale, and the honest answer is to ignore it -- the cartridge
-- is the newer truth. Restoring 23 items into a save that moved on is the
-- kind of help nobody asked for.
--
-- Pure Lua apart from stamp(), which is the one function that needs love's
-- hasher; capture/apply take the stamp as a plain string so the codec stays
-- testable headless.

local Json = require("src.link.Json")
local Bag = require("src.inventory.Bag")

local SaveExtras = {}

SaveExtras.VERSION = 1

-- Written and read beside the cartridge image at both ends of the seam.
SaveExtras.EXPORT_PATH = "host/export_extras.json"
SaveExtras.IMPORT_PATH = "host/import_extras.json"

-- The fingerprint of the 32768-byte image the sidecar belongs to. SHA-256 hex,
-- the same digest SaveVault.hash uses on the host side, so the two can be
-- compared by eye in a bug report. Nil when there is no hasher (a headless
-- run): no stamp means no sidecar, which is exactly the behaviour that
-- shipped before this file existed.
function SaveExtras.stamp(bytes)
  if type(bytes) ~= "string" or #bytes == 0 then return nil end
  if not (love and love.data and love.data.hash and love.data.encode) then return nil end
  -- LOVE 12 (the iOS host) wants the container type first and marks the
  -- two-argument call deprecated; LOVE 11 (every other host this engine runs
  -- on) only has the two-argument one and raises on the three. Ask for the
  -- modern shape, fall back to the old, and a host with neither simply gets
  -- no sidecar rather than a traceback mid-save.
  local ok, digest = pcall(love.data.hash, "string", "sha256", bytes)
  if not ok then ok, digest = pcall(love.data.hash, "sha256", bytes) end
  if not ok then return nil end
  local okHex, hex = pcall(love.data.encode, "string", "hex", digest)
  if not okHex or type(hex) ~= "string" then return nil end
  return hex
end

-- Badges live in save.inventory beside the bag but are not bag items -- they
-- ride the SRAM badge byte and GenSave decodes them from it. Bag.isBadge is
-- the engine's own rule (the one the bag UI hides rows by), so using it here
-- means the sidecar carries exactly what the player sees in their bag.
local isBadge = Bag.isBadge

-- inventory + order -> [[id, qty], ...] in the player's own order. Ids the
-- order forgot are appended rather than dropped: Bag.order is maintained
-- incrementally and a mod writing save.inventory directly can outrun it, and
-- an item missing from a list whose whole job is not to lose items would be a
-- poor joke.
local function pairsInOrder(items, order)
  local out, seen = {}, {}
  for _, id in ipairs(order or {}) do
    local qty = items and items[id]
    if qty and not seen[id] and not isBadge(id) then
      seen[id] = true
      out[#out + 1] = { id, qty }
    end
  end
  for id, qty in pairs(items or {}) do
    if not seen[id] and not isBadge(id) then
      seen[id] = true
      out[#out + 1] = { id, qty }
    end
  end
  return out
end

-- capture(save, stamp) -> json string, or nil when there is nothing to stamp
-- it with. Carries the WHOLE bag and PC rather than only the overflow: on the
-- far side "replace these two lists" needs no agreement about which items did
-- or did not fit, and the stamp already guarantees the two halves belong
-- together.
function SaveExtras.capture(save, stamp)
  if type(save) ~= "table" or type(stamp) ~= "string" or stamp == "" then return nil end
  local ok, encoded = pcall(Json.encode, {
    v = SaveExtras.VERSION,
    sav = stamp,
    bag = pairsInOrder(save.inventory, save.bagOrder),
    pc = pairsInOrder(save.pcItems, save.pcOrder),
  })
  if not ok or type(encoded) ~= "string" then return nil end
  return encoded
end

local function readList(rows, items, order)
  for _, row in ipairs(rows or {}) do
    local id, qty = row[1], row[2]
    if type(id) == "string" and type(qty) == "number" and qty > 0
       and not isBadge(id) and not items[id] then
      items[id] = qty
      order[#order + 1] = id
    end
  end
end

-- apply(save, doc, stamp) -> true when the sidecar spoke for THIS save and its
-- bag and PC replaced the decoded ones; false (leaving `save` untouched) for
-- an absent, malformed, wrong-version or wrongly-stamped sidecar. Never
-- raises: a bad sidecar must degrade to the cartridge's own 20 items, not
-- take the import down with it.
function SaveExtras.apply(save, doc, stamp)
  if type(save) ~= "table" or type(doc) ~= "string" then return false end
  if type(stamp) ~= "string" or stamp == "" then return false end
  local ok, parsed = pcall(Json.decode, doc)
  if not ok or type(parsed) ~= "table" then return false end
  if parsed.v ~= SaveExtras.VERSION or parsed.sav ~= stamp then return false end
  if type(parsed.bag) ~= "table" or type(parsed.pc) ~= "table" then return false end

  -- The decoded save's badges stay: they came off the badge byte, which is
  -- real cartridge data and newer than anything written here.
  local inventory, bagOrder = {}, {}
  for id, qty in pairs(save.inventory or {}) do
    if isBadge(id) then inventory[id] = qty end
  end
  readList(parsed.bag, inventory, bagOrder)
  save.inventory, save.bagOrder = inventory, bagOrder

  local pcItems, pcOrder = {}, {}
  readList(parsed.pc, pcItems, pcOrder)
  save.pcItems, save.pcOrder = pcItems, pcOrder
  return true
end

return SaveExtras
