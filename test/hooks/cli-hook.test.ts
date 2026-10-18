import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { readEvents } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'

describe('hece hook (process)', () => {
  it('exits 0 and logs hook_error on malformed stdin', () => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin: '{not json' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(readEvents(statePaths(root).events).map((e) => e.event)).toEqual(['hook_error'])
  })

  it('exits 0 on empty stdin in a project without hece, writing nothing', () => {
    const root = tmpProject()
    const r = runCli(['hook'], { root, stdin: '' })
    expect(r.status).toBe(0)
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })

  it('prints usage and exits 1 for an unknown command', () => {
    const r = runCli(['nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece')
  })
})
