-- The map-header cache window an export must derive for its own position.
--
-- The vanilla game TRUSTS these bytes on CONTINUE (LoadMapHeader returns
-- early on the continue path) and the overworld loop's first RunMapScript
-- does `jp [wMapScriptPtr]` after banking to wCurMap's bank — so a window
-- inherited from a template saved on a DIFFERENT map executes data as code
-- (the Aug 2026 outdoor-Cerulean rst38 crash). These tests pin the
-- derivation against a synthetic cartridge, independent of any commercial
-- ROM: a header at a known banked address, reachable through the same
-- pointer/bank tables the game itself walks.
--
--   luajit tests/save_convert_map_window_tests.lua      (from the repo root)

package.path = "./?.lua;./?/init.lua;" .. package.path

local GenSave = require("src.save_convert.GenSave")

local failures = 0
local function check(cond, label)
  if cond then
    print("ok  - " .. label)
  else
    failures = failures + 1
    print("FAIL - " .. label)
  end
end
local function eq(got, want, label)
  check(got == want, ("%s (got %s, want %s)"):format(label, tostring(got), tostring(want)))
end

-- ------------------------------------------------------------ synthetic ROM
-- Map index 3, header in bank 6 at $4700: tileset 5, 9x10 blocks, the three
-- pointers, connections = SOUTH|EAST, then the two present 11-byte
-- connection headers in check order (N, S, W, E -> S first, then E).
local MAP_INDEX = 3
local BANK = 6
local HDR_ADDR = 0x4700
local PTRS_OFF = 0x1000       -- arbitrary table homes: the derivation takes
local BANKS_OFF = 0x2000      -- file offsets, versions differ anyway

local rom = {}
for i = 1, 0x100000 do rom[i] = "\0" end
local function poke(fileOff, byte) rom[fileOff + 1] = string.char(byte) end

poke(PTRS_OFF + MAP_INDEX * 2, HDR_ADDR % 256)
poke(PTRS_OFF + MAP_INDEX * 2 + 1, math.floor(HDR_ADDR / 256))
poke(BANKS_OFF + MAP_INDEX, BANK)

local hdrFile = BANK * 0x4000 + (HDR_ADDR - 0x4000)
local header = {
  0x05,             -- tileset
  0x09, 0x0A,       -- height, width (blocks)
  0x23, 0x41,       -- map data pointer  $4123
  0x56, 0x44,       -- text pointer      $4456
  0x89, 0x47,       -- script pointer    $4789
  0x05,             -- connections: SOUTH (bit 2) | EAST (bit 0)
}
for i, b in ipairs(header) do poke(hdrFile + i - 1, b) end
local south = { 0x21, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }
local east  = { 0x42, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 }
for i, b in ipairs(south) do poke(hdrFile + 10 + i - 1, b) end
for i, b in ipairs(east)  do poke(hdrFile + 21 + i - 1, b) end

-- object data at $4780 in the same bank: border, 2 warps, 1 sign, and two
-- people — a plain NPC and a trainer (whose entry carries 2 extra bytes)
local OBJ_ADDR = 0x4780
poke(hdrFile + 32, OBJ_ADDR % 256)              -- object data pointer follows
poke(hdrFile + 33, math.floor(OBJ_ADDR / 256))  -- the two connection headers
local objFile = BANK * 0x4000 + (OBJ_ADDR - 0x4000)
local objData = {
  0x0B,                         -- border block
  0x02,                         -- warps
  7, 3, 0, 0x40,                -- warp 0: y7 x3 -> dest warp 0, map $40
  9, 5, 1, 0x41,                -- warp 1
  0x01,                         -- signs
  6, 4, 0x0D,                   -- sign: y6 x4, text $0D
  0x02,                         -- people
  0x2A, 8, 9, 0xFE, 0x01, 0x05,             -- NPC: pic $2A, y8 x9, text 5
  0x1C, 10, 11, 0xFF, 0x02, 0x40 + 0x07, 0x22, 0x03,  -- trainer: text 7, class $22 num 3
}
for i, b in ipairs(objData) do poke(objFile + i - 1, b) end

-- tileset headers table: entry for tileset 5 (11 bytes)
local TILESETS_OFF = 0x3000
for i = 0, 10 do poke(TILESETS_OFF + 5 * 12 + i, 0x60 + i) end

-- map song table + wild data (grass rate 25, water rate 0)
local SONGS_OFF = 0x3800
poke(SONGS_OFF + MAP_INDEX * 2, 0x1D)
poke(SONGS_OFF + MAP_INDEX * 2 + 1, 0x02)
local WILD_OFF = 0x3 * 0x4000 + (0x4C00 - 0x4000)
local WILD_PTRS = 0x3 * 0x4000 + (0x4B00 - 0x4000)
poke(WILD_PTRS + MAP_INDEX * 2, 0x00)
poke(WILD_PTRS + MAP_INDEX * 2 + 1, 0x4C)
poke(WILD_OFF, 25)
for i = 0, 19 do poke(WILD_OFF + 1 + i, 0x80 + i) end
poke(WILD_OFF + 21, 0)                          -- water rate

local romArg = { bytes = table.concat(rom), pointers = PTRS_OFF, banks = BANKS_OFF,
                 tilesets = TILESETS_OFF, songs = SONGS_OFF, wild = WILD_PTRS }

-- ------------------------------------------------------------ derivation
local SAVE_SIZE = 32768
local buf = {}
for i = 1, SAVE_SIZE do buf[i] = "\170" end   -- 0xAA = visibly-stale template

local save = { player = { map = "CERULEAN_CITY", x = 8, y = 27 } }
local cw = { mapsIndex = { CERULEAN_CITY = MAP_INDEX } }

local derived = GenSave.deriveMapMachineWindow(buf, save, cw, romArg)
check(derived == true, "window derives when ROM tables resolve")

local MAIN = 0x25A3
local function at(off) return buf[off + 1]:byte() end

eq(at(MAIN + 112), 0x05, "tileset from the ROM header")
eq(at(MAIN + 113), 0x09, "height")
eq(at(MAIN + 114), 0x0A, "width")
eq(at(MAIN + 115), 0x23, "map data pointer lo")
eq(at(MAIN + 116), 0x41, "map data pointer hi")
eq(at(MAIN + 117), 0x56, "text pointer lo")
eq(at(MAIN + 118), 0x44, "text pointer hi")
eq(at(MAIN + 119), 0x89, "script pointer lo — the byte the crash executed")
eq(at(MAIN + 120), 0x47, "script pointer hi")
eq(at(MAIN + 121), 0x05, "connections mask")

-- fixed slots: N and W disabled (loader's own init state), S and E verbatim
eq(at(MAIN + 122), 0xFF, "north slot disabled ($FF map id)")
eq(at(MAIN + 123), 0x00, "north slot strip zeroed")
eq(at(MAIN + 144), 0xFF, "west slot disabled")
eq(at(MAIN + 133), 0x21, "south slot: connected map id copied")
eq(at(MAIN + 143), 0x0A, "south slot: 11th byte copied")
eq(at(MAIN + 155), 0x42, "east slot: connected map id copied")
eq(at(MAIN + 165), 0x14, "east slot: 11th byte copied")

-- view pointer: $C6E8 + (w+6)*(y>>1 + 1) + (x>>1 + 1), validated against
-- two real saves (Viridian y28 x4 w20 -> $C871; Cerulean PC y4 x13 w7 ->
-- $C716). Here: w=10 -> stride 16; y=27 -> 13; x=8 -> 4 => $C6E8+229 = $C7CD
eq(at(MAIN + 104), 0xCD, "view pointer lo")
eq(at(MAIN + 105), 0xC7, "view pointer hi")
eq(at(MAIN + 108), 1, "y block parity (27 & 1)")
eq(at(MAIN + 109), 0, "x block parity (8 & 1)")
eq(at(MAIN + 312), 0xFF, "wDestinationWarpID cleared — no pending warp")
eq(at(MAIN + 557), 0x12, "height doubled (9 -> 18)")
eq(at(MAIN + 558), 0x14, "width doubled (10 -> 20)")

-- object data
eq(at(MAIN + 182), 0x0B, "border block")
eq(at(MAIN + 183), 2, "warp count")
eq(at(MAIN + 184), 7, "warp 0 y")
eq(at(MAIN + 187), 0x40, "warp 0 destination map")
eq(at(MAIN + 191), 0x41, "warp 1 destination map")
eq(at(MAIN + 441), 1, "sign count")
eq(at(MAIN + 442), 6, "sign y")
eq(at(MAIN + 443), 4, "sign x")
eq(at(MAIN + 474), 0x0D, "sign text id")
eq(at(MAIN + 490), 2, "people count")
eq(at(MAIN + 493), 0x01, "NPC movement byte 2")
eq(at(MAIN + 494), 0x05, "NPC text id (flags stripped)")
eq(at(MAIN + 495), 0x02, "trainer movement byte 2")
eq(at(MAIN + 496), 0x07, "trainer text id (trainer bit stripped)")
eq(at(MAIN + 525), 0, "NPC extra byte 0 zeroed")
eq(at(MAIN + 527), 0x22, "trainer class in extra data")
eq(at(MAIN + 528), 0x03, "trainer number in extra data")

-- sprite-state expansion (sav 0x2D2C mirrors C100)
local S1, S2 = 11564, 11564 + 256
eq(at(S1 + 16 + 0), 0x2A, "slot 1 picture id")
eq(at(S2 + 16 + 4), 8, "slot 1 map y")
eq(at(S2 + 16 + 5), 9, "slot 1 map x")
eq(at(S2 + 16 + 6), 0xFE, "slot 1 movement byte 1")
eq(at(S1 + 32 + 0), 0x1C, "slot 2 picture id (trainer)")
eq(at(S1 + 48 + 0), 0, "slot 3 empty: pic id zeroed")
eq(at(S1 + 48 + 2), 0xFF, "slot 3 empty: image index disabled")
eq(at(S1 + 15 * 16 + 0), 0xAA, "slot 15 (Pikachu) keeps template bytes")

-- tileset header, music, wilds
eq(at(MAIN + 564), 0x60, "tileset header byte 0 (bank)")
eq(at(MAIN + 574), 0x6A, "tileset header byte 10 (grass tile)")
eq(at(MAIN + 100), 0x1D, "map music sound id")
eq(at(MAIN + 101), 0x02, "map music bank")
eq(at(MAIN + 1424), 25, "grass encounter rate")
eq(at(MAIN + 1425), 0x80, "grass slot 0")
eq(at(MAIN + 1444), 0x93, "grass slot 19")
eq(at(MAIN + 1453), 0, "water rate zero")
eq(at(MAIN + 1454), 0xAA, "water mons untouched on zero rate")

-- ------------------------------------------------------------ refusals
local buf2 = {}
for i = 1, SAVE_SIZE do buf2[i] = "\170" end
check(GenSave.deriveMapMachineWindow(buf2, save, cw, nil) == false,
      "no ROM -> declines, template stands")
eq(buf2[MAIN + 119 + 1]:byte(), 0xAA, "no ROM -> script pointer untouched")

check(GenSave.deriveMapMachineWindow(buf2, { player = {} }, cw, romArg) == false,
      "no modeled map -> declines")

-- header pointer outside the banked window -> declines rather than derives
-- garbage
local badRom = { bytes = romArg.bytes, pointers = BANKS_OFF, banks = BANKS_OFF }
check(GenSave.deriveMapMachineWindow(buf2, save, cw, badRom) == false,
      "implausible header pointer -> declines")

print(failures == 0 and "ALL OK" or (failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)
