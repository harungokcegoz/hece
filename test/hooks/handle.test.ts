import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow } from '../helpers.js'
import { handleHook, summarizeTool } from '../../src/hooks/handle.js'
import { statePaths } from '../../src/state/paths.js'
import { readJson, readEvents, writeJsonAtomic } from '../../src/state/store.js'
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

  it('keeps only the last 50 sessions, newest last', () => {
    seedFlow(root, emptyFlow())
    for (let i = 0; i < 60; i++) {
      handleHook({ hook_event_name: 'SessionStart', session_id: `s${i}`, source: 'startup' }, { ...ctx(), now: i })
    }
    const recorded = readJson<{ sessionId: string }[]>(statePaths(root).sessions, [])
    expect(recorded).toHaveLength(50)
    expect(recorded[0].sessionId).toBe('s10')
    expect(recorded[49].sessionId).toBe('s59')
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

  it('describes the whole Bash command, not the 120 characters kept as the target', () => {
    seedFlow(root, emptyFlow())
    const command = `${'echo building the thing && '.repeat(11)}git push --force origin main`
    expect(command.length).toBeGreaterThan(300)
    handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, ctx())
    const ev = readEvents(statePaths(root).events)[0]
    expect(ev).toMatchObject({ event: 'tool', tool: 'Bash' })
    expect(String(ev.target).length).toBeLessThanOrEqual(120)
    expect(ev.desc).toContain('force-pushing to a remote')
    expect(String(ev.desc)).not.toContain('echo')
  })

  it('keeps no desc for tools other than Bash', () => {
    seedFlow(root, emptyFlow())
    handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } }, ctx())
    expect(readEvents(statePaths(root).events)[0]).not.toHaveProperty('desc')
  })

  it('approves on a typed "continue" and tells the agent', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    const r = handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'main', prompt: 'Continue.' }, ctx())
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
    seedFlow(root, { ...plan, mainSessionId: 'main' })
    const r = handleHook({ hook_event_name: 'PostToolUse', session_id: 'main', tool_name: 'AskUserQuestion', tool_response: { questions: [{ question: 'Plan ok?', header: 'h', options: [{ label: 'Continue', description: '' }, { label: 'Redo', description: '' }], multiSelect: false }], answers: { 'Plan ok?': 'Continue' } } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'hece: the user approved the plan' })
    expect(flow().plan!.approved).toBe(true)
  })

  it('records a typed "redo" without approving, and tells the agent', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    const r = handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'main', prompt: 'Redo.' }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hece: the user asked to redo slice 1' },
    })
    expect(flow().plan!.slices[0]).toMatchObject({ status: 'stopped', redoRequested: true })
    expect(readEvents(statePaths(root).events).find((e) => e.event === 'redo_requested')).toMatchObject({ n: 1, via: 'typed' })
  })

  it('records a picked Redo with via=picker', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    const r = handleHook({ hook_event_name: 'PostToolUse', session_id: 'main', tool_name: 'AskUserQuestion', tool_response: { questions: [{ question: 'Next?', header: 'h', options: [{ label: 'Continue', description: '' }, { label: 'Redo', description: '' }], multiSelect: false }], answers: { 'Next?': 'Redo' } } }, ctx())
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


describe('main-session approvals', () => {
  const typed = (session_id?: string) => ({ hook_event_name: 'UserPromptSubmit', session_id, prompt: 'ok' })
  const picked = (session_id?: string) => ({ hook_event_name: 'PostToolUse', session_id, tool_name: 'AskUserQuestion', tool_response: { questions: [{ question: 'Plan?', header: 'h', options: [{ label: 'Continue', description: '' }, { label: 'Redo', description: '' }], multiSelect: false }], answers: { 'Plan?': 'Continue' } } })

  it('records the first explicit non-fork SessionStart as owner and never replaces it', () => {
    seedFlow(root, emptyFlow())
    handleHook({ hook_event_name: 'SessionStart', session_id: 'fork', source: 'fork' }, ctx())
    expect(flow().mainSessionId).toBeFalsy()
    handleHook({ hook_event_name: 'SessionStart', session_id: 'main', source: 'startup' }, ctx())
    expect(flow().mainSessionId).toBe('main')
    handleHook({ hook_event_name: 'SessionStart', session_id: 'other', source: 'resume' }, ctx())
    expect(flow().mainSessionId).toBe('main')
  })

  it.each([undefined, 'unknown', 'future-source'])('does not guess ownership from SessionStart source %s', source => {
    seedFlow(root, plan)
    handleHook({ hook_event_name: 'SessionStart', session_id: 'unknown', source }, ctx())
    expect(flow().mainSessionId).toBeFalsy()
    expect(handleHook(typed('unknown'), ctx()).stdout).toBe('')
    expect(flow().plan!.approved).toBe(false)
  })

  it('keeps a recorded fork ineligible after resume and selects a later true main', () => {
    seedFlow(root, plan)
    handleHook({ hook_event_name: 'SessionStart', session_id: 'fork', source: 'fork' }, ctx())
    handleHook({ hook_event_name: 'SessionStart', session_id: 'fork', source: 'resume' }, ctx())
    expect(flow().mainSessionId).toBeFalsy()
    handleHook({ hook_event_name: 'SessionStart', session_id: 'main', source: 'startup' }, ctx())
    expect(flow().mainSessionId).toBe('main')
    expect(handleHook(typed('fork'), ctx()).stdout).toBe('')
    expect(flow().plan!.approved).toBe(false)
  })

  it.each([typed, picked])('ignores a fork approval without changing the main flow', approval => {
    const owned = { ...plan, mainSessionId: 'main' }
    seedFlow(root, owned)
    handleHook({ hook_event_name: 'SessionStart', session_id: 'side', source: 'fork' }, ctx())
    const result = handleHook(approval('side'), ctx())
    expect(result.stdout).toBe('')
    expect(flow()).toEqual(owned)
    expect(readEvents(statePaths(root).events).filter(e => e.event === 'ignored_approval')).toEqual([
      expect.objectContaining({ event: 'ignored_approval', session: 'side', reason: 'not_main_session' }),
    ])
    expect(events()).not.toContain('approved')
  })

  it.each([typed, picked])('allows an approval from the recorded main session', approval => {
    seedFlow(root, { ...plan, mainSessionId: 'main' })
    const result = handleHook(approval('main'), ctx())
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved the plan')
    expect(flow().plan!.approved).toBe(true)
  })

  it.each([undefined, '', 'other'])('rejects approval with missing or different session id %s', session => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    expect(handleHook(typed(session), ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].status).toBe('stopped')
    expect(events()).toContain('ignored_approval')
  })

  it('never claims an unowned legacy flow from an approval payload', () => {
    const { mainSessionId, ...legacy } = plan
    seedFlow(root, legacy)
    expect(handleHook(typed('unrecorded'), ctx()).stdout).toBe('')
    expect(flow().mainSessionId).toBeFalsy()
    expect(flow().plan!.approved).toBe(false)
    expect(readEvents(statePaths(root).events).find(e => e.event === 'ignored_approval')).toMatchObject({ reason: 'missing_main_session' })
  })

  it('migrates an unowned legacy flow from the earliest trusted recorded non-fork session', () => {
    const { mainSessionId, ...legacy } = plan
    seedFlow(root, legacy)
    writeJsonAtomic(statePaths(root).sessions, [
      { sessionId: 'side', source: 'fork', at: 1 },
      { sessionId: 'unknown', source: 'unknown', at: 2 },
      { sessionId: 'main', source: 'resume', at: 3 },
      { sessionId: 'later', source: 'startup', at: 4 },
    ])
    expect(handleHook(typed('side'), ctx()).stdout).toBe('')
    expect(flow().mainSessionId).toBe('main')
    expect(flow().plan!.approved).toBe(false)
    expect(JSON.parse(handleHook(typed('main'), ctx()).stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved the plan')
  })

  it.each(['typed', 'picker'])('ignores a side-session redo via %s rather than unlocking the main slice', via => {
    const owned = { ...stopped, mainSessionId: 'main' }
    seedFlow(root, owned)
    const payload = via === 'typed'
      ? { ...typed('side'), prompt: 'redo' }
      : { ...picked('side'), tool_response: { ...picked('side').tool_response, answers: { 'Plan?': 'Redo' } } }
    expect(handleHook(payload, ctx()).stdout).toBe('')
    expect(flow()).toEqual(owned)
    expect(events()).toContain('ignored_approval')
    expect(events()).not.toContain('redo_requested')
  })

  it.each(['startup', 'fork'])('SessionStart %s still writes nothing without a flow', source => {
    expect(handleHook({ hook_event_name: 'SessionStart', session_id: 's', source }, ctx())).toEqual({ stdout: '' })
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })
})


describe('first-flow creator ownership', () => {
  const discussText = 'hece · discuss\n▸ Discussion (0 decisions)\n  Plan\n  Build\n  Review\n  Recap\nguards: on'
  const created = () => ({
    hook_event_name: 'PostToolUse', session_id: 'creator', tool_name: 'mcp__plugin_hece_hece__flow_set_phase',
    tool_input: { phase: 'discuss' }, tool_response: [{ type: 'text', text: discussText }],
  })
  const fresh = () => setPhase(emptyFlow(), 'discuss', { guards: true }, 1)

  it('binds only the successful creator result after pre-flow SessionStart wrote nothing', () => {
    handleHook({ hook_event_name: 'SessionStart', session_id: 'creator', source: 'startup' }, ctx())
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
    seedFlow(root, fresh())
    handleHook(created(), ctx())
    expect(flow().mainSessionId).toBe('creator')
    seedFlow(root, setPlan(flow(), [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 2))
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'side', prompt: 'ok' }, ctx()).stdout).toBe('')
    expect(flow().plan!.approved).toBe(false)
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'creator', prompt: 'ok' }, ctx()).stdout).toContain('approved the plan')
  })

  it.each([
    { tool_name: 'mcp__other__flow_set_phase' },
    { tool_name: 'Read' },
    { hook_event_name: 'PreToolUse' },
    { tool_input: { phase: 'plan' } },
    { tool_response: [{ type: 'text', text: 'hece: failed' }] },
    { tool_response: { isError: true, content: [{ type: 'text', text: discussText }] } },
    { tool_response: [{ type: 'text', text: discussText }, { type: 'text', text: 'error' }] },
    { tool_response: undefined },
    { session_id: undefined },
    { session_id: '' },
    { source: 'fork' },
  ])('rejects an unverified creator payload %j', patch => {
    seedFlow(root, fresh())
    handleHook({ ...created(), ...patch }, ctx())
    expect(flow().mainSessionId).toBeFalsy()
  })

  it('does not infer creation from a response that differs from the current flow', () => {
    seedFlow(root, setPlan(fresh(), [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 2))
    handleHook(created(), ctx())
    expect(flow().mainSessionId).toBeFalsy()
  })

  it('does not bind an explicitly recorded fork even when it creates a pristine discussion', () => {
    seedFlow(root, fresh())
    handleHook({ hook_event_name: 'SessionStart', session_id: 'creator', source: 'fork' }, ctx())
    handleHook(created(), ctx())
    expect(flow().mainSessionId).toBeFalsy()
  })

  it('does not bootstrap a recorded fork after it resumes', () => {
    seedFlow(root, fresh())
    handleHook({ hook_event_name: 'SessionStart', session_id: 'creator', source: 'fork' }, ctx())
    handleHook({ hook_event_name: 'SessionStart', session_id: 'creator', source: 'resume' }, ctx())
    handleHook(created(), ctx())
    expect(flow().mainSessionId).toBeFalsy()
  })

  it('never replaces an existing owner from another creator result', () => {
    seedFlow(root, { ...fresh(), mainSessionId: 'main' })
    handleHook(created(), ctx())
    expect(flow().mainSessionId).toBe('main')
  })
})


describe('unreadable session metadata', () => {
  it.each(['{oops', 'null', '{}', '[null]'])('keeps edit guards enforced and rejects approval for %s', content => {
    const owned = { ...stopped, mainSessionId: 'main' }
    seedFlow(root, owned)
    fs.writeFileSync(statePaths(root).sessions, content)
    let edit = { stdout: '' }
    expect(() => {
      edit = handleHook({ hook_event_name: 'PreToolUse', session_id: 'main', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }, ctx())
    }).not.toThrow()
    expect(JSON.parse(edit.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'main', prompt: 'ok' }, ctx()).stdout).toBe('')
    expect(flow()).toEqual(owned)
    expect(events()).toContain('hook_error')
    expect(events()).toContain('ignored_approval')
  })
})


describe('ownership migration I/O', () => {
  it('still denies stopped-flow edits when binding the legacy owner would fail to write', () => {
    const { mainSessionId, ...legacy } = stopped
    seedFlow(root, legacy)
    const paths = statePaths(root)
    writeJsonAtomic(paths.sessions, [{ sessionId: 'main', source: 'startup', at: 1 }])
    const rename = fs.renameSync
    const failFlowWrite = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === paths.flow) throw new Error('test: flow replacement unavailable')
      return rename(from, to)
    })
    try {
      let result = { stdout: '' }
      expect(() => {
        result = handleHook({ hook_event_name: 'PreToolUse', session_id: 'main', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }, ctx())
      }).not.toThrow()
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      expect(flow()).toEqual(legacy)
    } finally {
      failFlowWrite.mockRestore()
    }
  })
})

describe('check question pending', () => {
  const pending = { ...stopped, mainSessionId: 'main', checkPending: true } as FlowState
  const typed = (prompt: string, session_id = 'main') => ({ hook_event_name: 'UserPromptSubmit', session_id, prompt })
  const opt = (label: string) => ({ label, description: '' })
  const picked = (questions: { question: string; first: string }[], answers: Record<string, string>) => ({
    hook_event_name: 'PostToolUse', session_id: 'main', tool_name: 'AskUserQuestion',
    tool_response: { questions: questions.map(q => ({ question: q.question, header: 'h', options: [opt(q.first), opt('Redo')], multiSelect: false })), answers },
  })

  it.each(['ok', 'go', 'continue'])('treats a typed %s as the check answer, clears the marker and does not approve', word => {
    seedFlow(root, pending)
    expect(handleHook(typed(word), ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].status).toBe('stopped')
    expect(flow().checkPending).toBeFalsy()
    expect(JSON.parse(handleHook(typed(word), ctx()).stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })

  it('treats a picker answer Continue as the check answer while the marker is set', () => {
    seedFlow(root, pending)
    expect(handleHook(picked([{ question: 'Next?', first: 'Continue' }], { 'Next?': 'Continue' }), ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].status).toBe('stopped')
    expect(flow().checkPending).toBeFalsy()
  })

  it('a prompt from a fork neither approves nor clears the marker', () => {
    seedFlow(root, pending)
    handleHook(typed('ok', 'fork'), ctx())
    expect(flow().checkPending).toBe(true)
  })

  it('approves only from the question whose first option is Continue', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    const r = handleHook(picked([{ question: 'Which?', first: 'Alpha' }, { question: 'Next?', first: 'Continue' }], { 'Which?': 'Alpha', 'Next?': 'Continue' }), ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })

  it('does not approve when Continue was answered to a different question', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    handleHook(picked([{ question: 'Which?', first: 'Alpha' }, { question: 'Next?', first: 'Continue' }], { 'Which?': 'Continue', 'Next?': 'Redo' }), ctx())
    expect(flow().plan!.slices[0].status).toBe('stopped')
  })

  it('does not approve an ambiguous picker with two Continue-first questions', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    handleHook(picked([{ question: 'A?', first: 'Continue' }, { question: 'B?', first: 'Continue' }], { 'A?': 'Continue', 'B?': 'Continue' }), ctx())
    expect(flow().plan!.slices[0].status).toBe('stopped')
  })

  it('does not record a redo from an unrelated question that offers Redo', () => {
    seedFlow(root, { ...stopped, mainSessionId: 'main' })
    expect(handleHook(picked([{ question: 'Which?', first: 'Alpha' }], { 'Which?': 'Redo' }), ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].redoRequested).toBeFalsy()
    expect(events()).not.toContain('redo_requested')
  })

  it('a Redo picked on a check question is only the check answer', () => {
    seedFlow(root, pending)
    expect(handleHook(picked([{ question: 'Why?', first: 'Because' }], { 'Why?': 'Redo' }), ctx()).stdout).toBe('')
    expect(flow().checkPending).toBeFalsy()
    expect(flow().plan!.slices[0].redoRequested).toBeFalsy()
  })
})
