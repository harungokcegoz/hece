import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { readEvents, readJson } from '../../src/state/store.js'
import { emptyFlow, FlowState } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'

const DIR = path.resolve('test/fixtures/claude-code')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
const raw = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 1)
const stopped = finishSlice(startSlice(approve(plan, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
const edit = files.find((f) => f === 'PreToolUse-Write.json' || f === 'PreToolUse-Edit.json')

describe('real Claude Code payloads', () => {
  it('has the core captures', () => {
    for (const f of ['SessionStart.json', 'UserPromptSubmit.json', 'PreToolUse-Bash.json', 'PostToolUse-AskUserQuestion.json', 'Stop.json']) {
      expect(files).toContain(f)
    }
    expect(edit).toBeDefined()
  })

  it.each(files)('%s is handled without a hook_error', (f) => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin: raw(f) })
    expect(r.status).toBe(0)
    expect(readEvents(statePaths(root).events).map((e) => e.event)).not.toContain('hook_error')
  })

  it('a real Write/Edit payload is denied while a slice waits', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw(edit!) })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a real Bash payload is never denied', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    expect(runCli(['hook'], { root, stdin: raw('PreToolUse-Bash.json') }).stdout).toBe('')
  })

  it('the picker answer "Continue" approves the waiting slice', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw('PostToolUse-AskUserQuestion.json') })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })

  it('the picker answer "Redo" does not approve the waiting slice', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw('PostToolUse-AskUserQuestion-redo.json') })
    expect(r.stdout).toBe('')
    const flow = readJson<FlowState>(statePaths(root).flow, emptyFlow())
    expect(flow.plan!.slices[0]!.status).toBe('stopped')
  })

  it('the real typed "continue" approves the waiting slice', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw('UserPromptSubmit.json') })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })
})
