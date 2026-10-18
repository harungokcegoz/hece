import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'
import { decideTool, isContinueIntent, pickerApproved } from '../../src/guards/guards.js'

const on = presetDefaults('involved')
const off = { ...on, guards: false }
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 1)
const approved = approve(plan, 2).state
const working = startSlice(approved, 1, { guards: true }, 3)
const stopped = finishSlice(working, 1, { summary: 's', connectsTo: 'c' }, 4)

describe('decideTool', () => {
  it('never interferes before a flow starts or after it is done', () => {
    expect(decideTool(emptyFlow(), on, 'Write')).toEqual({ allow: true })
    expect(decideTool(setPhase(stopped, 'done', 5), on, 'Write')).toEqual({ allow: true })
  })
  it('blocks edits during discussion', () => {
    const d = decideTool(setPhase(emptyFlow(), 'discuss', 1), on, 'Edit')
    expect(d).toEqual({ allow: false, reason: 'hece: no code edits during discussion; agree on a plan first' })
  })
  it('blocks edits before the plan is approved', () => {
    expect(decideTool(plan, on, 'Write')).toEqual({ allow: false, reason: 'hece: no code edits before the user approves the plan' })
  })
  it('blocks edits while a changed plan waits for approval', () => {
    const changed = setPlan(stopped, [{ title: 'A', files: [], kind: 'routine' }], 5)
    expect(decideTool(changed, on, 'Edit')).toEqual({ allow: false, reason: 'hece: the changed plan is waiting for the user to approve it' })
  })
  it('blocks edits while a slice is waiting for the user', () => {
    expect(decideTool(stopped, on, 'MultiEdit')).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
  it('allows edits while a slice is in progress', () => {
    expect(decideTool(working, on, 'Write')).toEqual({ allow: true })
  })
  it('never blocks non-edit tools such as Bash or Read', () => {
    expect(decideTool(stopped, on, 'Bash')).toEqual({ allow: true })
    expect(decideTool(stopped, on, 'Read')).toEqual({ allow: true })
  })
  it('allows everything when guards are off', () => {
    expect(decideTool(stopped, off, 'Write')).toEqual({ allow: true })
  })
})

describe('isContinueIntent', () => {
  it.each(['continue', 'Continue.', ' OK ', 'GO!', 'next', 'approve'])('approves %j', (t) => {
    expect(isContinueIntent(t)).toBe(true)
  })
  it.each(['ok but why X?', 'continue with the tests first', 'okay', 'yes', '', 'why?'])('does not approve %j', (t) => {
    expect(isContinueIntent(t)).toBe(false)
  })
})

describe('pickerApproved', () => {
  it('approves when an answer is exactly Continue', () => {
    expect(pickerApproved({ answers: { 'Slice 1 done. Next?': 'Continue' } })).toBe(true)
  })
  it('approves the text form Claude shows the model', () => {
    expect(pickerApproved('User has answered your questions: "Slice 1 done. Next?"="Continue".')).toBe(true)
  })
  it('does not approve other answers or question text that merely mentions continue', () => {
    expect(pickerApproved({ answers: { 'Continue or redo?': 'Redo' } })).toBe(false)
    expect(pickerApproved({ answers: { q: 'Continue later' } })).toBe(false)
    expect(pickerApproved(undefined)).toBe(false)
  })
})
