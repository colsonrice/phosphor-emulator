package.path = './?.lua;./?/init.lua;' .. package.path
local f = assert(io.open('main.lua')); local src = f:read('*a'); f:close()
local draw = assert(src:match('(function love%.draw%(%).-\n)function love%.keypressed'))
draw = draw:gsub('\nfunction love%.keypressed$', '')
for _, name in ipairs({ 'Importer', 'EditorApp', 'TouchEditor', 'Studio', 'Prelaunch' }) do
  local rendered, cleared = false, false
  love = { _phosphorEmbedded = true, graphics = { clear = function() cleared = true end } }
  GameViewport = { reset = function() end }
  HostDisplay = { beginFrame = function() end, endFrame = function() end }
  local prefix = 'local Game, Importer, EditorApp, TouchEditor, Studio, Prelaunch; local editorMode = false; '
  prefix = prefix .. name .. ' = ...; ' .. (name == 'EditorApp' and 'editorMode = true; ' or '')
  assert(loadstring(prefix .. draw))({ draw = function() rendered = true end })
  love.draw()
  assert(not rendered and cleared, name .. ' must never draw over Phosphor')
end
local rendered = false
love = { _phosphorEmbedded = true, graphics = { clear = function() error('game hidden') end } }
assert(loadstring('local Game = ...; ' .. draw))({ draw = function() rendered = true end })
love.draw(); assert(rendered, 'the actual game must draw')
love._phosphorEmbedded = false
rendered = false
assert(loadstring('local Importer = ...; ' .. draw))({ draw = function() rendered = true end })
love.draw(); assert(rendered, 'standalone launcher remains available')
assert(src:find('if love._phosphorEmbedded then return love.event.quit() end', 1, true), 'embedded return goes to Phosphor')
assert(src:find('Phosphor could not prepare this game. Return to the library and try again.', 1, true), 'missing directive fails to native UI')
print('host shell: 7 behavior checks and 2 wiring checks passed')
