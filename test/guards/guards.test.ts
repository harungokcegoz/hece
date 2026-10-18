import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'
import { decideTool, isContinueIntent, isRedoIntent, pickerApproved, pickerRedo } from '../../src/guards/guards.js'

const on = presetDefaults('involved')
const off = { ...on, guards: false }
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
const approved = approve(plan, 2).state
const working = startSlice(approved, 1, { guards: true }, 3)
const stopped = finishSlice(working, 1, { summary: 's', connectsTo: 'c' }, 4)

describe('decideTool', () => {
  it('never interferes before a flow starts', () => {
    expect(decideTool(emptyFlow(), on, 'Write')).toEqual({ allow: true })
  })
  it('does not treat done as a free pass: a stopped slice still blocks edits', () => {
    const done = setPhase(stopped, 'done', { guards: false }, 5)
    expect(decideTool(done, on, 'Write')).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
  it('a finished flow with everything approved allows edits', () => {
    const finished = setPhase(approve(stopped, 5).state, 'done', { guards: true }, 6)
    expect(decideTool(finished, on, 'Write')).toEqual({ allow: true })
  })
  it('a new plan set after done moves to plan and blocks edits until approved', () => {
    const finished = setPhase(approve(stopped, 5).state, 'done', { guards: true }, 6)
    const next = setPlan(finished, [{ title: 'New feature', files: [], kind: 'routine' }], { guards: true }, 7)
    expect(next.phase).toBe('plan')
    expect(decideTool(next, on, 'Write')).toMatchObject({ allow: false })
  })
  it('blocks edits during discussion', () => {
    const d = decideTool(setPhase(emptyFlow(), 'discuss', 1), on, 'Edit')
    expect(d).toEqual({ allow: false, reason: 'hece: no code edits during discussion; agree on a plan first' })
  })
  it('blocks edits before the plan is approved', () => {
    expect(decideTool(plan, on, 'Write')).toEqual({ allow: false, reason: 'hece: no code edits before the user approves the plan' })
  })
  it('blocks edits while a changed plan waits for approval', () => {
    const changed = setPlan(working, [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 5)
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

describe('isRedoIntent', () => {
  it.each(['redo', 'Redo.', ' REDO! '])('detects %j', (t) => {
    expect(isRedoIntent(t)).toBe(true)
  })
  it.each(['redo it please', 'undo', 'continue', '', 'why redo?'])('ignores %j', (t) => {
    expect(isRedoIntent(t)).toBe(false)
  })
})

describe('pickerApproved', () => {
  const question = {
    question: 'Slice 1 done. What next?',
    header: 'Next',
    options: [{ label: 'Continue', description: '' }, { label: 'Redo', description: '' }],
    multiSelect: false,
  }
  const result = (answer: string | string[]) => ({ questions: [question], answers: { [question.question]: answer } })

  it('approves when the chosen answer is Continue', () => {
    expect(pickerApproved(result('Continue'))).toBe(true)
  })
  it('does not approve Redo even though the echoed options contain Continue', () => {
    expect(pickerApproved(result('Redo'))).toBe(false)
  })
  it('reads multiSelect answers given as an array', () => {
    expect(pickerApproved(result(['Continue']))).toBe(true)
    expect(pickerApproved(result(['Redo']))).toBe(false)
  })
  it('does not approve the string form, which question text could imitate', () => {
    expect(pickerApproved('Your questions have been answered: "Slice 1 done. What next?"="Continue".')).toBe(false)
    expect(pickerRedo('"Slice 1 done. What next?"="Redo"')).toBe(false)
  })
  it('pickerRedo is true only when the chosen answer is Redo', () => {
    expect(pickerRedo(result('Redo'))).toBe(true)
    expect(pickerRedo(result(['Redo']))).toBe(true)
    expect(pickerRedo(result('Continue'))).toBe(false)
    expect(pickerRedo({ questions: [question] })).toBe(false)
    expect(pickerRedo(undefined)).toBe(false)
  })
  it('does not approve other answers or question text that merely mentions continue', () => {
    expect(pickerApproved({ answers: { 'Continue or redo?': 'Redo' } })).toBe(false)
    expect(pickerApproved({ answers: { q: 'Continue later' } })).toBe(false)
    expect(pickerApproved(undefined)).toBe(false)
  })
})
