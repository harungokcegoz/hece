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

  it.each(['null', '[]', '"text"'])('exits 0 and logs hook_error for non-object JSON %s', (stdin) => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(readEvents(statePaths(root).events).map((e) => e.event)).toEqual(['hook_error'])
  })

  it('exits 0 when cwd is not a string', () => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: 5 }) })
    expect(r.status).toBe(0)
    expect(readEvents(statePaths(root).events).map((e) => e.event)).toEqual(['turn_done'])
  })

  it('exits 0 and denies an edit when flow.json is unreadable; Bash gets no output', () => {
    const root = tmpProject()
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    const write = runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts' } }) })
    expect(write.status).toBe(0)
    expect(JSON.parse(write.stdout).hookSpecificOutput.permissionDecisionReason).toBe('hece: .hece/state/flow.json is unreadable; run hece status')
    const bash = runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }) })
    expect(bash.status).toBe(0)
    expect(bash.stdout).toBe('')
  })

  it('prints usage and exits 1 for an unknown command', () => {
    const r = runCli(['nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece')
  })
})
