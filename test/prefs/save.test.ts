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
  it('a scalar or an array is an error and saveGlobal refuses', () => {
    for (const text of ['just text\n', '- a\n']) {
      const f = tmp(text)
      const g = readGlobal(f)
      expect(g.error).toMatch(/must be a mapping/)
      expect(() => saveGlobal(g, { preset: 'learning' })).toThrow()
      expect(fs.readFileSync(f, 'utf8')).toBe(text)
    }
  })
  it('a # inside a quoted value is not a comment, a trailing comment is', () => {
    expect(readGlobal(tmp('reviewer_model: "x #1"\n')).hadComments).toBe(false)
    expect(readGlobal(tmp("review:\n  reviewer_model: 'x #1'\n")).hadComments).toBe(false)
    expect(readGlobal(tmp('reviewer_model: "x #1" # note\n')).hadComments).toBe(true)
    expect(readGlobal(tmp("a: it's # note 'x'\n")).hadComments).toBe(true)
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

describe('promoteToCustom', () => {
  it('is a no-op for custom, or when no custom-only key was touched', () => {
    const c = { ...presetDefaults('involved'), preset: 'custom' as const }
    expect(promoteToCustom(c, ['check_questions'])).toEqual({ prefs: c, touched: ['check_questions'] })
    const i = presetDefaults('involved')
    expect(promoteToCustom(i, ['optimize'])).toEqual({ prefs: i, touched: ['optimize'] })
  })
})

describe('saveGlobal symlink', () => {
  it('keeps the file mode', () => {
    const f = tmp('preset: involved\n')
    fs.chmodSync(f, 0o600)
    saveGlobal(readGlobal(f), { preset: 'learning' })
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  })
  it('follows a chain of links to a dangling target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-link-'))
    fs.symlinkSync('real/p.yaml', path.join(dir, 'b'))
    fs.symlinkSync('b', path.join(dir, 'a'))
    saveGlobal(readGlobal(path.join(dir, 'a')), { preset: 'learning' })
    expect(fs.lstatSync(path.join(dir, 'a')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(dir, 'b')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'real', 'p.yaml'), 'utf8')).toContain('learning')
  })
  it('writes to the target of a dangling symlink and keeps the link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-link-'))
    const link = path.join(dir, 'preferences.yaml')
    fs.symlinkSync('real/p.yaml', link)
    saveGlobal(readGlobal(link), { preset: 'learning' })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'real', 'p.yaml'), 'utf8')).toContain('learning')
  })
  it('writes through a symlink and keeps it', () => {
    const target = tmp('preset: involved\n')
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hece-link-')), 'preferences.yaml')
    fs.symlinkSync(target, link)
    saveGlobal(readGlobal(link), { preset: 'learning' })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toContain('learning')
  })
})
