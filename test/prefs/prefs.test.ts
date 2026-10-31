import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { presetDefaults, resolvePrefs, validatePrefs } from '../../src/prefs/schema.js'
import { loadPrefs, prefsFiles } from '../../src/prefs/load.js'

let root: string
let home: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-root-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-home-'))
})
afterEach(() => vi.restoreAllMocks())

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('presets', () => {
  it('defaults to the Involved preset', () => {
    const p = resolvePrefs([]).prefs
    expect(p).toMatchObject({ preset: 'involved', check_questions: 'off', flow_recap: false, guards: { stops: true, files: true } })
    expect(p.review).toEqual({ final: true, reviewer_model: 'opus', show_minor: false })
  })
  it('Learning turns on check questions, minor findings and the recap', () => {
    expect(presetDefaults('learning')).toMatchObject({
      check_questions: 'non-routine', flow_recap: true, review: { show_minor: true },
    })
  })
  it('explicit values beat the preset', () => {
    const p = resolvePrefs([{ raw: { preset: 'learning', check_questions: 'off' }, source: 'g' }]).prefs
    expect(p.check_questions).toBe('off')
    expect(p.flow_recap).toBe(true)
  })
  it('defaults optimize to ponytail and accepts caveman', () => {
    expect(presetDefaults('involved').optimize).toBe('ponytail')
    expect(presetDefaults('learning').optimize).toBe('ponytail')
    expect(validatePrefs({ optimize: 'caveman' }, 'x')).toEqual({ flat: { optimize: 'caveman' }, errors: [] })
    expect(validatePrefs({ optimize: 'grunt' }, 'x').errors[0]).toContain('ponytail | caveman')
  })
})

describe('validation', () => {
  it('treats YAML on/off as booleans', () => {
    const { flat, errors } = validatePrefs({ guards: 'off', review: { final: 'on' } }, 'x')
    expect(errors).toEqual([])
    expect(flat).toEqual({ 'guards.stops': false, 'guards.files': false, 'review.final': true })
  })
  it('legacy guards: off sets both switches', () => {
    expect(validatePrefs({ guards: 'off' }, 'x')).toEqual({ flat: { 'guards.stops': false, 'guards.files': false }, errors: [] })
    expect(resolvePrefs([{ raw: { guards: { files: false } }, source: 'g' }]).prefs.guards).toEqual({ stops: true, files: false })
  })
  it('rejects a junk legacy guards value and keeps both on', () => {
    const r = resolvePrefs([{ raw: { guards: 'maybe' }, source: 'g' }])
    expect(r.errors).toHaveLength(1)
    expect(r.prefs.guards).toEqual({ stops: true, files: true })
  })
  it('rejects a typo key by name and keeps the safe default', () => {
    const { prefs, errors } = resolvePrefs([{ raw: { gaurds: false }, source: 'p.yaml' }])
    expect(errors).toEqual(['p.yaml: unknown key "gaurds"'])
    expect(prefs.guards).toEqual({ stops: true, files: true })
  })
  it.each(['constructor', 'toString', 'hasOwnProperty'])('treats inherited object key "%s" as unknown', key => {
    const { prefs, errors } = resolvePrefs([{ raw: { [key]: 'x' }, source: 'p.yaml' }])
    expect(errors).toEqual([`p.yaml: unknown key "${key}"`])
    expect(prefs.guards).toEqual({ stops: true, files: true })
  })
  it('treats an inherited key inside a group as unknown', () => {
    const { errors } = validatePrefs({ slice_stop: { constructor: 'x' } }, 'p.yaml')
    expect(errors).toEqual(['p.yaml: unknown key "slice_stop.constructor"'])
  })
  it('names the key and the allowed values for a bad value', () => {
    const { errors } = validatePrefs({ slice_stop: { depth: 'huge' } }, 'p.yaml')
    expect(errors).toEqual(['p.yaml: "slice_stop.depth" is "huge"; allowed: line | short | detailed'])
  })
  it('rejects a group that is not a mapping', () => {
    expect(validatePrefs({ review: 'yes' }, 'p.yaml').errors).toEqual(['p.yaml: "review" must be a mapping'])
  })
  it('rejects a non-mapping file', () => {
    expect(validatePrefs(['a'], 'p.yaml').errors).toEqual(['p.yaml: preferences must be a mapping of keys to values'])
  })
})

describe('legacy guards', () => {
  it('a junk scalar error mentions the group form', () => {
    expect(validatePrefs({ guards: 'maybe' }, 'f').errors[0]).toContain('{ stops, files }')
  })
})

describe('loadPrefs', () => {
  it('a file with only effort.build resolves the other efforts to their defaults', () => {
    write(prefsFiles({}, root, home).global, 'effort: { build: high }\n')
    expect(loadPrefs({}, root, home).prefs.effort).toEqual({ orchestrator: 'default', build: 'high', review: 'high' })
  })
  it.each([['global', 'EACCES'], ['project', 'EISDIR']] as const)('reports unreadable %s preferences (%s) while using the other file', (layer, code) => {
    const files = prefsFiles({}, root, home)
    write(files.global, 'preset: learning\n')
    write(files.project, 'slice_stop: { depth: detailed }\n')
    const failure = Object.assign(new Error('preferences unreadable'), { code })
    const read = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync')
    if (layer === 'project') spy.mockImplementationOnce(read)
    spy.mockImplementationOnce(() => { throw failure })
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(files[layer])
    expect(errors[0]).toContain(code)
    expect(prefs.preset).toBe(layer === 'global' ? 'involved' : 'learning')
    expect(prefs.slice_stop.depth).toBe(layer === 'global' ? 'detailed' : 'short')
  })

  it('reads global then project, project winning key by key', () => {
    const files = prefsFiles({}, root, home)
    write(files.global, 'guards: off\nslice_stop: { depth: detailed }\n')
    write(files.project, 'guards: on\n')
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors).toEqual([])
    expect(prefs.guards).toEqual({ stops: true, files: true })
    expect(prefs.slice_stop.depth).toBe('detailed')
  })
  it('honours XDG_CONFIG_HOME', () => {
    expect(prefsFiles({ XDG_CONFIG_HOME: '/x' }, root, home).global).toBe(path.join('/x', 'hece', 'preferences.yaml'))
  })
  it('reports invalid YAML with the file path and falls back to defaults', () => {
    const files = prefsFiles({}, root, home)
    write(files.project, 'guards: [oops\n')
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors[0]).toContain(files.project)
    expect(errors[0]).toContain('invalid YAML')
    expect(prefs.guards).toEqual({ stops: true, files: true })
  })
  it('works with no files at all', () => {
    expect(loadPrefs({}, root, home)).toEqual({ prefs: presetDefaults('involved'), errors: [] })
  })
})

describe('effort and orchestrator', () => {
  it('defaults: orchestrator uses Claude Code\'s own setting', () => {
    const p = presetDefaults('involved')
    expect(p.delegate.orchestrator).toBe('default')
    expect(p.effort).toEqual({ orchestrator: 'default', build: 'medium', review: 'high' })
  })
  it('accepts vendor effort levels and rejects others', () => {
    expect(validatePrefs({ effort: { build: 'xhigh' } }, 'x').errors).toEqual([])
    expect(validatePrefs({ effort: { orchestrator: 'default' } }, 'x').errors).toEqual([])
    expect(validatePrefs({ effort: { build: 'default' } }, 'x').errors[0]).toMatch(/"effort.build"/)
    expect(validatePrefs({ effort: { review: 'huge' } }, 'x').errors[0]).toMatch(/allowed: low \| medium \| high \| xhigh \| max/)
  })
})
