import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase } from '../../src/flow/flow.js'

describe('hece status', () => {
  it('explains when there is no flow yet', () => {
    const r = runCli(['status'], { root: tmpProject() })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no flow in this project yet')
  })

  it('prints the flow and warns about preference errors', () => {
    const root = tmpProject()
    seedFlow(root, setPhase(emptyFlow(), 'discuss', 1))
    fs.writeFileSync(path.join(root, '.hece', 'preferences.yaml'), 'gaurds: off\n')
    const r = runCli(['status'], { root })
    expect(r.stdout).toContain('▸ Discussion (0 decisions)')
    expect(r.stdout).toContain('guards: on')
    expect(r.stderr).toContain('unknown key "gaurds"')
  })
})
