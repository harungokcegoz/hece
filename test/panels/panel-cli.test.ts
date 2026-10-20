import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { appendEvent } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, approve } from '../../src/flow/flow.js'
import { stripAnsi } from '../../src/panels/color.js'

const size = { HECE_PANEL_WIDTH: '40', HECE_PANEL_HEIGHT: '20' }
const panel = (root: string, widget: string) => {
  const r = runCli(['panel', widget, '--once'], { root, env: size })
  return { ...r, text: stripAnsi(r.stdout) }
}

describe('hece panel --once', () => {
  it('flow panel shows the real flow', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    const r = panel(root, 'flow')
    expect(r.status).toBe(0)
    expect(r.text).toContain('▸ Build')
    expect(r.text).toContain('▸ 1. Token model')
  })

  it('flow panel explains an empty project', () => {
    expect(panel(tmpProject(), 'flow').text).toContain('No flow yet.')
  })

  it('activity panel speaks plain language and hides raw commands', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    const ev = statePaths(root).events
    appendEvent(ev, { at: 1, event: 'note', text: 'saving only a hash of the token', slice: 1 })
    appendEvent(ev, { at: 2, event: 'tool', tool: 'Bash', target: 'ls -la && find . -maxdepth 3', slice: 1 })
    appendEvent(ev, { at: 3, event: 'tool', tool: 'mcp__plugin_hece_hece__flow_get', target: '', slice: 1 })
    const r = panel(root, 'activity')
    expect(r.text).toContain('▸ Slice 1 · Token model')
    expect(r.text).toContain('Now: saving only a hash of the token')
    expect(r.text).toContain('· looking around the files')
    expect(r.text).not.toContain('maxdepth')
    expect(r.text).not.toContain('mcp__')
  })

  it('shows a message instead of crashing on a corrupt flow.json', () => {
    const root = tmpProject()
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    const r = panel(root, 'flow')
    expect(r.status).toBe(0)
    expect(r.text).toContain('⚠')
  })

  it('rejects an unknown widget', () => {
    const r = runCli(['panel', 'nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece panel')
  })
})
