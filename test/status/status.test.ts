import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { CLI, tmpProject, seedFlow, runCli, testEnv } from '../helpers.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase } from '../../src/flow/flow.js'

describe('hece status', () => {
  it('explains when there is no flow yet', () => {
    const r = runCli(['status'], { root: tmpProject() })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no flow in this project yet')
  })

  it('finds the project .hece from a nested folder', () => {
    const root = fs.realpathSync(tmpProject())
    seedFlow(root, setPhase(emptyFlow(), 'discuss', { guards: false }, 1))
    const nested = path.join(root, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })
    // the child runs from a folder outside the repo, so tsx must be resolved here
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
    const env = testEnv(root)
    delete env.HECE_ROOT
    const r = spawnSync(process.execPath, ['--import', tsx, CLI, 'status'], { cwd: nested, env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('▸ Discussion (0 decisions)')
  })

  it('prints the flow and warns about preference errors', () => {
    const root = tmpProject()
    seedFlow(root, setPhase(emptyFlow(), 'discuss', { guards: false }, 1))
    fs.writeFileSync(path.join(root, '.hece', 'preferences.yaml'), 'gaurds: off\n')
    const r = runCli(['status'], { root })
    expect(r.stdout).toContain('▸ Discussion (0 decisions)')
    expect(r.stdout).toContain('guards: on')
    expect(r.stderr).toContain('unknown key "gaurds"')
  })

  it('warns about preference errors even when there is no flow yet', () => {
    const root = tmpProject()
    fs.mkdirSync(path.join(root, '.hece'), { recursive: true })
    fs.writeFileSync(path.join(root, '.hece', 'preferences.yaml'), 'gaurds: off\n')
    const r = runCli(['status'], { root })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no flow in this project yet')
    expect(r.stderr).toContain('unknown key "gaurds"')
  })
})
