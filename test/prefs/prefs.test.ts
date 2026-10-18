import { describe, it, expect, beforeEach } from 'vitest'
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
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('presets', () => {
  it('defaults to the Involved preset', () => {
    const p = resolvePrefs([]).prefs
    expect(p).toMatchObject({ preset: 'involved', check_questions: 'off', flow_recap: false, guards: true })
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
})

describe('validation', () => {
  it('treats YAML on/off as booleans', () => {
    const { flat, errors } = validatePrefs({ guards: 'off', review: { final: 'on' } }, 'x')
    expect(errors).toEqual([])
    expect(flat).toEqual({ guards: false, 'review.final': true })
  })
  it('rejects a typo key by name and keeps the safe default', () => {
    const { prefs, errors } = resolvePrefs([{ raw: { gaurds: false }, source: 'p.yaml' }])
    expect(errors).toEqual(['p.yaml: unknown key "gaurds"'])
    expect(prefs.guards).toBe(true)
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

describe('loadPrefs', () => {
  it('reads global then project, project winning key by key', () => {
    const files = prefsFiles({}, root, home)
    write(files.global, 'guards: off\nslice_stop: { depth: detailed }\n')
    write(files.project, 'guards: on\n')
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors).toEqual([])
    expect(prefs.guards).toBe(true)
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
    expect(prefs.guards).toBe(true)
  })
  it('works with no files at all', () => {
    expect(loadPrefs({}, root, home)).toEqual({ prefs: presetDefaults('involved'), errors: [] })
  })
})
