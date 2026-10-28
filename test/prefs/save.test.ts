import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { presetDefaults, resolvePrefs } from '../../src/prefs/schema.js'
import { nextRaw, promoteToCustom, readGlobal, saveGlobal } from '../../src/prefs/save.js'

const tmp = (text: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-save-')), 'preferences.yaml')
  fs.writeFileSync(f, text)
  return f
}

describe('nextRaw', () => {
  it('writes only what differs from the preset, plus preset', () => {
    const p = { ...presetDefaults('involved'), optimize: 'caveman' as const }
    expect(nextRaw({}, p, ['optimize', 'layout.left'])).toEqual({ preset: 'involved', optimize: 'caveman' })
  })
  it('a touched key set back to the default is removed', () => {
    expect(nextRaw({ optimize: 'caveman' }, presetDefaults('involved'), ['optimize'])).toEqual({ preset: 'involved' })
  })
  it('keeps untouched and unknown keys', () => {
    expect(nextRaw({ layout: { left: 'none' }, mystery: 1 }, presetDefaults('involved'), ['optimize']))
      .toEqual({ preset: 'involved', layout: { left: 'none' }, mystery: 1 })
  })
  it('a non-custom preset removes custom-only keys', () => {
    expect(nextRaw({ check_questions: 'every', plan: { slice_size: 'medium' } }, presetDefaults('learning'), ['preset'])).toEqual({ preset: 'learning' })
  })
  it('legacy guards scalar is expanded, so the untouched guard keeps its old value', () => {
    const p = presetDefaults('involved'); p.guards = { stops: false, files: false }
    expect(nextRaw({ guards: 'off' }, p, ['guards.stops'])).toEqual({ preset: 'involved', guards: { stops: false, files: false } })
  })
  it('legacy guards scalar: turning one back on keeps the other off', () => {
    const p = presetDefaults('involved'); p.guards = { stops: true, files: false }
    expect(nextRaw({ guards: 'off' }, p, ['guards.stops'])).toEqual({ preset: 'involved', guards: { files: false } })
  })
  it('an invalid legacy guards scalar is dropped, not read as off', () => {
    const p = presetDefaults('involved'); p.guards = { stops: false, files: true }
    expect(nextRaw({ guards: 'maybe' }, p, ['guards.stops'])).toEqual({ preset: 'involved', guards: { stops: false } })
  })
  it('editing a custom key under a preset switches to custom and keeps the old values', () => {
    const p = presetDefaults('learning'); p.check_questions = 'every'
    const r = promoteToCustom(p, ['check_questions'])
    expect(r.prefs.preset).toBe('custom')
    expect(resolvePrefs([{ raw: nextRaw({}, r.prefs, r.touched), source: 'g' }]).prefs)
      .toMatchObject({ preset: 'custom', check_questions: 'every', flow_recap: true, review: { show_minor: true } })
  })
})

describe('global file', () => {
  it('refuses to save over a file that does not parse', () => {
    const f = tmp('a: [')
    const g = readGlobal(f)
    expect(g.error).toMatch(/invalid YAML/)
    expect(() => saveGlobal(g, {})).toThrow()
    expect(fs.readFileSync(f, 'utf8')).toBe('a: [')
  })
  it('notices comments', () => {
    const g = readGlobal(tmp('# mine\npreset: learning\n'))
    expect(g.hadComments).toBe(true)
    expect(g.raw).toEqual({ preset: 'learning' })
  })
  it('a missing file is empty, and save creates it', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-save-')), 'sub', 'p.yaml')
    const g = readGlobal(f)
    expect(g).toMatchObject({ raw: {}, hadComments: false })
    expect(g.error).toBeUndefined()
    saveGlobal(g, { preset: 'learning' })
    expect(readGlobal(f).raw).toEqual({ preset: 'learning' })
  })
})
