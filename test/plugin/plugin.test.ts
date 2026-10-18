import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook'

describe('Claude Code plugin', () => {
  it('has a manifest named hece', () => {
    expect(json('.claude-plugin/plugin.json')).toMatchObject({ name: 'hece', version: '0.1.0' })
  })

  it('wires every hook event hece handles to `hece hook`', () => {
    const hooks = json('hooks/hooks.json').hooks
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    for (const entries of Object.values(hooks) as { hooks: { type: string; command: string }[] }[][]) {
      expect(entries[0].hooks[0]).toEqual({ type: 'command', command: CMD })
    }
    expect(hooks.PreToolUse[0].matcher).toBe('*')
    expect(hooks.PostToolUse[0].matcher).toBe('*')
  })

  it('registers the MCP server as `hece mcp`', () => {
    expect(json('.mcp.json')).toEqual({
      mcpServers: { hece: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', 'mcp'] } },
    })
  })
})
