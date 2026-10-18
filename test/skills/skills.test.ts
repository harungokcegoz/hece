import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TOOL_NAMES } from '../../src/mcp/server.js'

const DIR = path.resolve('skills')
const EXPECTED = ['check-question', 'communicate', 'flow', 'recap', 'review-findings', 'slice-stop']
const read = (name: string) => fs.readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8')

describe('skills', () => {
  it('has exactly the expected skills', () => {
    expect(fs.readdirSync(DIR).sort()).toEqual(EXPECTED)
  })

  it.each(EXPECTED)('%s has frontmatter with a matching name and a "Use when" description', (name) => {
    const m = read(name).match(/^---\nname: (.+)\ndescription: (.+)\n---\n/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(name)
    expect(m![2]).toMatch(/^Use (when|after|during|in)/)
  })

  it.each(EXPECTED)('%s only references real hece tools and skills', (name) => {
    const text = read(name)
    // flow_recap is a preference key, not a tool
    for (const tool of (text.match(/\b(flow_[a-z_]+|prefs_get)\b/g) ?? []).filter((t) => t !== 'flow_recap')) {
      expect(TOOL_NAMES as readonly string[]).toContain(tool)
    }
    for (const ref of text.match(/hece:([a-z-]+)/g) ?? []) {
      expect(EXPECTED).toContain(ref.slice('hece:'.length))
    }
  })

  it('flow states that hece pacing wins over superpowers handoffs', () => {
    expect(read('flow')).toContain("hece's pacing wins")
    expect(read('flow')).toContain('dispatch exactly one slice at a time')
  })

  it('never offers an approve tool', () => {
    for (const name of EXPECTED) expect(read(name)).not.toMatch(/flow_approve/)
  })
})
