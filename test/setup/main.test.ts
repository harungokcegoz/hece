import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { runWizard, runPrefsEdit, type SetupDeps } from '../../src/setup/main.js'
import { SCREENS } from '../../src/setup/screens.js'
import { resolvePrefs } from '../../src/prefs/schema.js'
import { stripAnsi } from '../../src/panels/color.js'
import { runCli, tmpProject } from '../helpers.js'
import type { Key } from '../../src/setup/tui.js'

const enter: Key = { name: 'return' }
const k = (name: string): Key => ({ name, sequence: name })
const esc: Key = { name: 'escape' }
const ctrlC: Key = { name: 'c', ctrl: true }

function setup(keys: Key[], content?: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-setup-')), 'preferences.yaml')
  if (content !== undefined) fs.writeFileSync(file, content)
  const writes: string[] = []
  const outs: string[] = []
  let closed = 0
  const d: SetupDeps = {
    io: { keys: (async function* () { yield* keys })(), write: (s) => writes.push(s), width: () => 40, close: () => closed++ },
    file,
    ctx: { onPath: () => true, plugins: new Set(['superpowers', 'ponytail', 'caveman']), fileErrors: [] },
    doctor: () => [{ ok: true, label: 'node' }],
    out: (s) => outs.push(s),
  }
  return { d, file, writes, outs, closed: () => closed }
}
const read = (f: string) => YAML.parse(fs.readFileSync(f, 'utf8'))
const enters = (n: number) => Array.from({ length: n }, () => enter)
// intro, agent, preset, skills, 6 model/effort, 2 guards, 2 layout, summary, doctor
const THROUGH = 4 + 6 + 2 + 2 + 2

describe('runWizard', () => {
  it('Enter through everything writes preset involved', async () => {
    const t = setup(enters(THROUGH))
    expect(await runWizard(t.d, { firstRun: true })).toBe('saved')
    expect(read(t.file)).toEqual({ preset: 'involved' })
    expect(t.closed()).toBe(1)
  })
  it('picking caveman writes only optimize', async () => {
    const keys = [enter, enter, enter, k('down'), ...enters(THROUGH - 3)]
    const t = setup(keys)
    expect(await runWizard(t.d, { firstRun: false })).toBe('saved')
    expect(read(t.file)).toEqual({ preset: 'involved', optimize: 'caveman' })
  })
  it('b returns to the previous screen with its answer preselected', async () => {
    // intro, agent, preset(down = learning), then back to preset and Enter keeps learning
    const t = setup([enter, enter, k('down'), enter, enter, k('b'), k('b'), enter, ...enters(THROUGH)])
    await runWizard(t.d, { firstRun: false })
    expect(read(t.file).preset).toBe('learning')
  })
  it('b on the first screen stays put', async () => {
    const t = setup([k('b'), esc])
    await runWizard(t.d, { firstRun: false })
    const titles = t.writes.filter((w) => stripAnsi(w).includes('keeps you in the loop'))
    expect(titles.length).toBe(2)
  })
  it('Esc mid-wizard (not first run) cancels without a file', async () => {
    const t = setup([enter, esc])
    expect(await runWizard(t.d, { firstRun: false })).toBe('cancelled')
    expect(fs.existsSync(t.file)).toBe(false)
  })
  it('Esc on first run saves defaults', async () => {
    const t = setup([enter, esc])
    expect(await runWizard(t.d, { firstRun: true })).toBe('skipped')
    expect(read(t.file)).toEqual({ preset: 'involved' })
    expect(t.outs.join()).toContain('Defaults saved. Change them any time with `hece prefs`.')
  })
  it('Ctrl-C aborts and closes', async () => {
    const t = setup([enter, ctrlC])
    expect(await runWizard(t.d, { firstRun: true })).toBe('aborted')
    expect(fs.existsSync(t.file)).toBe(false)
    expect(t.closed()).toBe(1)
  })
  it('summary shows YAML, path and the comments note', async () => {
    const t = setup(enters(THROUGH), '# mine\npreset: involved\n')
    await runWizard(t.d, { firstRun: false })
    const all = stripAnsi(t.writes.join(''))
    expect(all).toContain('preset: involved')
    expect(all).toContain(t.file)
    expect(all).toContain('Comments in this file will be lost')
  })
  it('a broken file is never written', async () => {
    const t = setup([enter], 'preset: [oops\n')
    expect(await runWizard(t.d, { firstRun: true })).toBe('cancelled')
    expect(stripAnsi(t.writes.join('')).replace(/\s+/g, ' ')).toContain(`Fix or delete ${t.file}`)
    expect(fs.readFileSync(t.file, 'utf8')).toBe('preset: [oops\n')
  })
  it('sanity: wizard screen count matches', () => {
    expect(SCREENS.filter((s) => !s.when).length).toBe(THROUGH - 2)
  })
})

describe('summary and doctor screens', () => {
  const BEFORE_SUMMARY = THROUGH - 2
  it('b on Summary goes back to the last screen with its answer kept', async () => {
    // layout-right: down (sessions), Enter -> summary, b -> layout-right again, Enter keeps it
    const keys = [...enters(BEFORE_SUMMARY - 1), k('down'), enter, k('b'), enter, enter, enter]
    const t = setup(keys)
    expect(await runWizard(t.d, { firstRun: false })).toBe('saved')
    expect(read(t.file)).toEqual({ preset: 'involved', layout: { right: expect.any(String) } })
  })
  it('first-run Esc on Summary saves defaults', async () => {
    const t = setup([...enters(BEFORE_SUMMARY), esc])
    expect(await runWizard(t.d, { firstRun: true })).toBe('skipped')
    expect(read(t.file)).toEqual({ preset: 'involved' })
    expect(t.outs.join()).toContain('Defaults saved.')
  })
  it('non-first-run Esc on Summary writes nothing', async () => {
    const t = setup([...enters(BEFORE_SUMMARY), esc])
    expect(await runWizard(t.d, { firstRun: false })).toBe('cancelled')
    expect(fs.existsSync(t.file)).toBe(false)
  })
  it('doctor runs after the file is saved', async () => {
    const t = setup([...enters(BEFORE_SUMMARY + 2)])
    let seen: boolean | undefined
    t.d.doctor = () => { seen = fs.existsSync(t.file); return [] }
    await runWizard(t.d, { firstRun: false })
    expect(seen).toBe(true)
  })
  it('Summary Enter saves; Esc on Doctor still returns saved', async () => {
    const t = setup([...enters(BEFORE_SUMMARY + 1), esc])
    expect(await runWizard(t.d, { firstRun: false })).toBe('saved')
    expect(read(t.file)).toEqual({ preset: 'involved' })
  })
})

describe('runPrefsEdit', () => {
  it('preset learning -> custom keeps learning values', async () => {
    const t = setup([k('3'), enter], 'preset: learning\n')
    expect(await runPrefsEdit(t.d, 'preset')).toBe('saved')
    const got = resolvePrefs([{ raw: read(t.file), source: 'x' }]).prefs
    expect(got.preset).toBe('custom')
    expect(got.check_questions).toBe('non-routine')
    expect(got.flow_recap).toBe(true)
    expect(got.review.show_minor).toBe(true)
  })
  it('check-questions under learning promotes to custom', async () => {
    const t = setup([k('3'), enter], 'preset: learning\n')
    expect(await runPrefsEdit(t.d, 'check-questions')).toBe('saved')
    const learning = resolvePrefs([{ raw: { preset: 'learning' }, source: 'x' }]).prefs
    const got = resolvePrefs([{ raw: read(t.file), source: 'x' }]).prefs
    expect(got).toEqual({ ...learning, preset: 'custom', check_questions: 'every' })
  })
  it('unknown name lists valid names', async () => {
    const t = setup([])
    expect(await runPrefsEdit(t.d, 'nope')).toBe('cancelled')
    expect(t.outs.join()).toContain('check-questions')
  })
  it('no name shows the list first', async () => {
    const t = setup([esc])
    expect(await runPrefsEdit(t.d)).toBe('cancelled')
    expect(stripAnsi(t.writes.join(''))).toContain('check-questions')
  })
})

describe('cli', () => {
  it('setup without a terminal exits 1', () => {
    const r = runCli(['setup'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('hece setup needs a terminal')
  })
})
