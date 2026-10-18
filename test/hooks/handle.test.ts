import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow } from '../helpers.js'
import { handleHook, summarizeTool } from '../../src/hooks/handle.js'
import { statePaths } from '../../src/state/paths.js'
import { readJson, readEvents } from '../../src/state/store.js'
import { emptyFlow, FlowState } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'

let root: string
const prefs = presetDefaults('involved')
const ctx = () => ({ root, configDir: path.join(root, '.config-test', 'hece'), prefs, prefsErrors: [] as string[], now: 100 })
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
const stopped = finishSlice(startSlice(approve(plan, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
const events = () => readEvents(statePaths(root).events).map((e) => e.event)
const flow = () => readJson<FlowState>(statePaths(root).flow, emptyFlow())

beforeEach(() => {
  root = tmpProject()
})

describe('handleHook', () => {
  it('does nothing at all in a project without a hece flow', () => {
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 's' }, ctx())
    expect(r).toEqual({ stdout: '' })
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })

  it('records sessions and prefs errors on SessionStart', () => {
    seedFlow(root, emptyFlow())
    handleHook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, { ...ctx(), prefsErrors: ['bad key'] })
    expect(readJson(statePaths(root).sessions, [])).toEqual([{ sessionId: 's1', source: 'startup', at: 100 }])
    expect(events()).toEqual(['session_start', 'prefs_error'])
  })

  it('denies an edit while a slice waits, with the reason, and logs it', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' } }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'hece: slice 1 is waiting for the user',
      },
    })
    expect(events()).toEqual(['blocked'])
  })

  it('denies an edit of hece preferences or state even when no slice is waiting, and logs it', () => {
    seedFlow(root, emptyFlow())
    for (const file of [path.join(root, '.hece', 'preferences.yaml'), path.join(root, '.config-test', 'hece', 'preferences.yaml')]) {
      const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }, ctx())
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason)
        .toBe('hece: preferences and flow state are changed by the user, not the agent')
    }
    expect(events()).toEqual(['blocked', 'blocked'])
  })

  it('allows an ordinary file edit while a slice is working', () => {
    seedFlow(root, startSlice(approve(plan, 2).state, 1, { guards: true }, 3))
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.ts') } }, ctx())
    expect(r.stdout).toBe('')
  })

  it('logs allowed tools as activity and marks the agent busy', () => {
    seedFlow(root, emptyFlow())
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, ctx())
    expect(r.stdout).toBe('')
    expect(readEvents(statePaths(root).events)[0]).toMatchObject({ event: 'tool', tool: 'Bash', target: 'npm test' })
    expect(readJson(statePaths(root).agent, {})).toEqual({ idle: false, at: 100 })
  })

  it('approves on a typed "continue" and tells the agent', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Continue.' }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hece: the user approved slice 1' },
    })
    expect(flow().plan!.slices[0].status).toBe('approved')
  })

  it('does not approve a question', () => {
    seedFlow(root, stopped)
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'ok but why?' }, ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].status).toBe('stopped')
  })

  it('approves the plan from the picker answer', () => {
    seedFlow(root, plan)
    const r = handleHook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_response: { answers: { 'Plan ok?': 'Continue' } } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'hece: the user approved the plan' })
    expect(flow().plan!.approved).toBe(true)
  })

  it('records a typed "redo" without approving, and tells the agent', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Redo.' }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hece: the user asked to redo slice 1' },
    })
    expect(flow().plan!.slices[0]).toMatchObject({ status: 'stopped', redoRequested: true })
    expect(readEvents(statePaths(root).events).find((e) => e.event === 'redo_requested')).toMatchObject({ n: 1, via: 'typed' })
  })

  it('records a picked Redo with via=picker', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_response: { answers: { 'Next?': 'Redo' } } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user asked to redo slice 1')
    expect(readEvents(statePaths(root).events).find((e) => e.event === 'redo_requested')).toMatchObject({ n: 1, via: 'picker' })
  })

  it('ignores redo when no slice is stopped', () => {
    seedFlow(root, plan)
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'redo' }, ctx()).stdout).toBe('')
    expect(events()).not.toContain('redo_requested')
  })

  it('an unreadable flow.json denies edits when guards are on, and logs hook_error', () => {
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'hece: .hece/state/flow.json is unreadable; run hece status',
    })
    expect(events()).toContain('hook_error')
  })

  it.each(['null', '[]', '"text"', '{"phase": 5}', '{}'])('a flow.json containing %s is treated as unreadable', (content) => {
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, content)
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason)
      .toBe('hece: .hece/state/flow.json is unreadable; run hece status')
    expect(events()).toContain('hook_error')
    expect(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx()).stdout).toBe('')
  })

  it('an unreadable flow.json never blocks Bash, and does not block edits with guards off', () => {
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    expect(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, ctx()).stdout).toBe('')
    const off = { ...ctx(), prefs: { ...prefs, guards: false } }
    expect(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write' }, off).stdout).toBe('')
  })

  it('marks the agent idle on Stop', () => {
    seedFlow(root, setPhase(emptyFlow(), 'discuss', { guards: true }, 1))
    handleHook({ hook_event_name: 'Stop' }, ctx())
    expect(readJson(statePaths(root).agent, {})).toEqual({ idle: true, at: 100 })
    expect(events()).toEqual(['turn_done'])
  })
})

describe('summarizeTool', () => {
  it('uses the file path, command, or pattern and truncates long values', () => {
    expect(summarizeTool('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeTool('Bash', { command: 'ls   -la\n&& pwd' })).toBe('ls -la && pwd')
    expect(summarizeTool('Bash', { command: 'x'.repeat(200) })).toHaveLength(120)
    expect(summarizeTool('Read', undefined)).toBe('')
  })
})
