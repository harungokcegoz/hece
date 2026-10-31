import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve, chooseMode } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'
import { decideTool, isContinueIntent, isRedoIntent, parseRedo, pickerMode, pickerApproved, pickerRedo } from '../../src/guards/guards.js'

const on = presetDefaults('involved')
const protect = { root: '/proj', configDir: '/home/u/.config/hece' }
const off = { ...on, guards: { stops: false, files: false } }
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
const approved = approve(plan, 2).state
const working = startSlice(approved, 1, { guards: true }, 3)
const stopped = finishSlice(working, 1, { summary: 's', connectsTo: 'c' }, 4)

describe('decideTool', () => {
  it('never interferes before a flow starts', () => {
    expect(decideTool(emptyFlow(), on, { name: 'Write' }, protect)).toEqual({ allow: true })
  })
  it('does not treat done as a free pass: a stopped slice still blocks edits', () => {
    const done = setPhase(stopped, 'done', { guards: false }, 5)
    expect(decideTool(done, on, { name: 'Write' }, protect)).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
  it('a finished flow with everything approved allows edits', () => {
    const finished = setPhase(approve(stopped, 5).state, 'done', { guards: true }, 6)
    expect(decideTool(finished, on, { name: 'Write' }, protect)).toEqual({ allow: true })
  })
  it('a new plan set after done moves to plan and blocks edits until approved', () => {
    const finished = setPhase(approve(stopped, 5).state, 'done', { guards: true }, 6)
    const next = setPlan(finished, [{ title: 'New feature', files: [], kind: 'routine' }], { guards: true }, 7)
    expect(next.phase).toBe('plan')
    expect(decideTool(next, on, { name: 'Write' }, protect)).toMatchObject({ allow: false })
  })
  it('blocks edits during discussion', () => {
    const d = decideTool(setPhase(emptyFlow(), 'discuss', { guards: true }, 1), on, { name: 'Edit' }, protect)
    expect(d).toEqual({ allow: false, reason: 'hece: no code edits during discussion; agree on a plan first' })
  })
  it('blocks edits before the plan is approved', () => {
    expect(decideTool(plan, on, { name: 'Write' }, protect)).toEqual({ allow: false, reason: 'hece: no code edits before the user approves the plan' })
  })
  it('blocks edits while a changed plan waits for approval', () => {
    const changed = setPlan(working, [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 5)
    expect(decideTool(changed, on, { name: 'Edit' }, protect)).toEqual({ allow: false, reason: 'hece: the changed plan is waiting for the user to approve it' })
  })
  it('blocks edits while a slice is waiting for the user', () => {
    expect(decideTool(stopped, on, { name: 'MultiEdit' }, protect)).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
  it('allows edits while a slice is in progress', () => {
    expect(decideTool(working, on, { name: 'Write' }, protect)).toEqual({ allow: true })
  })
  it('never blocks non-edit tools such as Bash or Read', () => {
    expect(decideTool(stopped, on, { name: 'Bash' }, protect)).toEqual({ allow: true })
    expect(decideTool(stopped, on, { name: 'Read' }, protect)).toEqual({ allow: true })
  })
  it('allows everything when guards are off', () => {
    expect(decideTool(stopped, off, { name: 'Write' }, protect)).toEqual({ allow: true })
  })
})

describe('split guards', () => {
  const discuss = setPhase(emptyFlow(), 'discuss', { guards: true }, 1)
  const filesOnly = { ...on, guards: { stops: false, files: true } }
  const stopsOnly = { ...on, guards: { stops: true, files: false } }
  const edit = (p: string) => ({ name: 'Edit', input: { file_path: p } })
  it('files guard alone blocks .hece edits but not code edits during discuss', () => {
    expect(decideTool(discuss, filesOnly, edit('/proj/.hece/preferences.yaml'), protect).allow).toBe(false)
    expect(decideTool(discuss, filesOnly, edit('/proj/src/a.ts'), protect)).toEqual({ allow: true })
  })
  it('stops guard alone blocks code edits in discuss', () => {
    expect(decideTool(discuss, stopsOnly, edit('/proj/src/a.ts'), protect).allow).toBe(false)
  })
  it('files: false skips the hece-path check (a slice in progress allows the edit, files: true denies it)', () => {
    const f = edit('/proj/.hece/preferences.yaml')
    expect(decideTool(working, stopsOnly, f, protect)).toEqual({ allow: true })
    expect(decideTool(working, on, f, protect).allow).toBe(false)
  })
})

describe('decideTool: hece-owned files', () => {
  const write = (file: string, name = 'Write', prefs = on, flow = working) =>
    decideTool(flow, prefs, { name, input: { file_path: file } }, protect)
  const reason = 'hece: preferences and flow state are changed by the user, not the agent'

  it('denies writing the project preferences', () => {
    expect(write('/proj/.hece/preferences.yaml')).toEqual({ allow: false, reason })
  })
  it('denies editing flow state, including through a relative path', () => {
    expect(write('/proj/.hece/state/flow.json', 'Edit')).toEqual({ allow: false, reason })
    expect(write('.hece/state/flow.json', 'Edit')).toEqual({ allow: false, reason })
    expect(write('src/../.hece/preferences.yaml')).toEqual({ allow: false, reason })
  })
  it('denies writing inside the global config dir', () => {
    expect(write('/home/u/.config/hece/preferences.yaml')).toEqual({ allow: false, reason })
  })
  it('denies notebook edits of hece files', () => {
    expect(decideTool(working, on, { name: 'NotebookEdit', input: { notebook_path: '/proj/.hece/n.ipynb' } }, protect))
      .toEqual({ allow: false, reason })
  })
  it('applies in every phase, even before a flow starts', () => {
    expect(write('/proj/.hece/preferences.yaml', 'Write', on, emptyFlow())).toEqual({ allow: false, reason })
  })
  it('allows ordinary project files while a slice is working', () => {
    expect(write('/proj/src/a.ts')).toEqual({ allow: true })
    expect(write('/proj/.hecefile')).toEqual({ allow: true })
    expect(write('/proj/.hece-other/x')).toEqual({ allow: true })
  })
  it('sees through a symlink that points into .hece', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-guard-'))
    fs.mkdirSync(path.join(dir, '.hece'))
    fs.symlinkSync(path.join(dir, '.hece'), path.join(dir, 'link'))
    const d = decideTool(working, on, { name: 'Write', input: { file_path: 'link/preferences.yaml' } }, { root: dir, configDir: path.join(dir, 'cfg') })
    expect(d).toEqual({ allow: false, reason })
  })
  const caseInsensitiveFs = process.platform === 'darwin' || process.platform === 'win32'
  it.runIf(caseInsensitiveFs)('denies case variants of .hece on a case-insensitive filesystem', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-case-')))
    fs.mkdirSync(path.join(dir, '.hece', 'state'), { recursive: true })
    const p2 = { root: dir, configDir: path.join(dir, 'cfg', 'hece') }
    for (const file of [path.join(dir, '.HECE', 'state', 'flow.json'), path.join(dir, '.Hece', 'preferences.yaml')]) {
      expect(decideTool(working, on, { name: 'Write', input: { file_path: file } }, p2)).toEqual({ allow: false, reason })
    }
  })
  it.runIf(caseInsensitiveFs)('denies a case-changed configDir', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-case-')))
    fs.mkdirSync(path.join(dir, 'cfg', 'hece'), { recursive: true })
    const p2 = { root: dir, configDir: path.join(dir, 'cfg', 'hece') }
    const file = path.join(dir, 'CFG', 'Hece', 'preferences.yaml')
    expect(decideTool(working, on, { name: 'Write', input: { file_path: file } }, p2)).toEqual({ allow: false, reason })
  })
  it('expands ~ to the home directory before checking the configDir', () => {
    const p2 = { root: '/proj', configDir: path.join(os.homedir(), '.config', 'hece') }
    for (const file of ['~/.config/hece/preferences.yaml', '~/.config/hece']) {
      expect(decideTool(working, on, { name: 'Write', input: { file_path: file } }, p2)).toEqual({ allow: false, reason })
    }
    expect(decideTool(working, on, { name: 'Write', input: { file_path: '~/other/a.ts' } }, p2)).toEqual({ allow: true })
  })
  it('allows everything when guards are off', () => {
    expect(write('/proj/.hece/preferences.yaml', 'Write', off)).toEqual({ allow: true })
  })
  it('never denies Bash, whatever it touches', () => {
    expect(decideTool(working, on, { name: 'Bash', input: { command: 'rm .hece/state/flow.json', file_path: '/proj/.hece/x' } }, protect))
      .toEqual({ allow: true })
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
  describe('multi-question pickers', () => {
    const q = (text: string, first: string) => ({ question: text, header: 'h', options: [{ label: first, description: '' }, { label: 'Other', description: '' }], multiSelect: false })
    const picker = (qs: ReturnType<typeof q>[], answers: Record<string, string>) => ({ questions: qs, answers })

    it('approves from the question whose first option is Continue, ignoring other answers', () => {
      const r = picker([q('Which db?', 'Postgres'), q('Next?', 'Continue')], { 'Which db?': 'Other', 'Next?': 'Continue' })
      expect(pickerApproved(r)).toBe(true)
    })
    it('does not approve when only another question was answered Continue', () => {
      const r = picker([q('Which?', 'Continue-ish'), q('Next?', 'Continue')], { 'Which?': 'Continue', 'Next?': 'Other' })
      expect(pickerApproved(r)).toBe(false)
    })
    it('does not approve when a question whose first option is not Continue is answered Continue', () => {
      const r = picker([q('Which?', 'Alpha')], { 'Which?': 'Continue' })
      expect(pickerApproved(r)).toBe(false)
    })
    it('does not approve when more than one question has Continue as its first option', () => {
      const r = picker([q('A?', 'Continue'), q('B?', 'Continue')], { 'A?': 'Continue', 'B?': 'Continue' })
      expect(pickerApproved(r)).toBe(false)
    })
    it('does not approve without the questions echo', () => {
      expect(pickerApproved({ answers: { 'Next?': 'Continue' } })).toBe(false)
    })
    it('pickerRedo reads only the approval question, like pickerApproved', () => {
      expect(pickerRedo(picker([q('A?', 'Continue'), q('B?', 'X')], { 'A?': 'Redo', 'B?': 'Other' }))).toBe(true)
      expect(pickerRedo(picker([q('A?', 'Continue'), q('B?', 'X')], { 'A?': 'Other', 'B?': 'Redo' }))).toBe(false)
      expect(pickerRedo(picker([q('A?', 'Continue'), q('B?', 'Continue')], { 'A?': 'Redo', 'B?': 'Redo' }))).toBe(false)
      expect(pickerRedo(picker([q('A?', 'Alpha')], { 'A?': 'Redo' }))).toBe(false)
      expect(pickerRedo({ answers: { 'Next?': 'Redo' } })).toBe(false)
    })
  })

  it('does not approve other answers or question text that merely mentions continue', () => {
    expect(pickerApproved({ answers: { 'Continue or redo?': 'Redo' } })).toBe(false)
    expect(pickerApproved({ answers: { q: 'Continue later' } })).toBe(false)
    expect(pickerApproved(undefined)).toBe(false)
  })
})

const par = chooseMode(approved, 'parallel', 3)!
const par2 = startSlice(startSlice(par, 1, { guards: true }, 4), 2, { guards: true }, 5)
const parallelOneStoppedOneWorking = finishSlice(par2, 1, { summary: 's', connectsTo: 'c' }, 6)
const parallelAllStopped = finishSlice(parallelOneStoppedOneWorking, 2, { summary: 's', connectsTo: 'c' }, 7)
const edit = { name: 'Edit' }

describe('parallel guards', () => {
  it('lets edits run while a parallel batch still has working slices', () => {
    expect(decideTool(parallelOneStoppedOneWorking, on, edit, protect)).toEqual({ allow: true })
  })
  it('blocks edits once the whole parallel batch is waiting', () => {
    expect(decideTool(parallelAllStopped, on, edit, protect)).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
})
describe('parseRedo', () => {
  it.each([['redo', []], ['Redo 2 4', [2, 4]], ['redo 2, 4.', [2, 4]]])('%s', (t, ns) => expect(parseRedo(t as string)).toEqual(ns))
  it.each(['redo it', 'please redo', 'redo 0'])('rejects %s', (t) => expect(parseRedo(t)).toBeNull())
})
describe('pickerMode', () => {
  const pick = (labels: string[], answer: string) => ({
    questions: [{ question: 'How should slices run?', options: labels.map((label) => ({ label })) }],
    answers: { 'How should slices run?': answer },
  })
  it('reads the answer to the One by one question', () => {
    expect(pickerMode(pick(['One by one', 'Parallel'], 'Parallel'))).toBe('parallel')
    expect(pickerMode(pick(['One by one', 'Parallel'], 'One by one'))).toBe('one-by-one')
  })
  it('ignores pickers that put Parallel first or offer only Parallel', () => {
    expect(pickerMode(pick(['Parallel', 'One by one'], 'Parallel'))).toBeNull()
    expect(pickerMode(pick(['Parallel'], 'Parallel'))).toBeNull()
  })
  it('ignores agent-shaped strings', () => expect(pickerMode('Parallel')).toBeNull())
})
