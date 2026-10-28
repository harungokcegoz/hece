import fs from 'node:fs'
import YAML from 'yaml'
import { presetDefaults, resolvePrefs, validatePrefs } from './schema.js'
import type { Prefs } from './schema.js'
import { readYaml } from './load.js'
import { writeFileAtomic } from '../state/store.js'

export const CUSTOM_KEYS: readonly string[] = [
  'discussion.first',
  'discussion.pushback',
  'plan.slice_size',
  'slice_stop.depth',
  'check_questions',
  'side_chats.open_in',
  'review.final',
  'review.show_minor',
  'flow_recap',
]

export interface GlobalFile {
  path: string
  raw: Record<string, unknown>
  hadComments: boolean
  error?: string
  errors: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export function flatten(p: Prefs): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(p)) {
    if (isObj(v)) for (const [l, w] of Object.entries(v)) out[`${k}.${l}`] = w as string | boolean
    else out[k] = v as string | boolean
  }
  return out
}

export function readGlobal(file: string): GlobalFile {
  const { raw, error } = readYaml(file)
  const g: GlobalFile = { path: file, raw: {}, hadComments: false, errors: [] }
  if (error) return { ...g, error }
  if (raw !== undefined && raw !== null) {
    if (!isObj(raw)) return { ...g, error: `${file}: preferences must be a mapping of keys to values` }
    g.raw = raw
  }
  try {
    g.hadComments = /^\s*#|\s#/m.test(fs.readFileSync(file, 'utf8'))
  } catch {
    // missing file: nothing to keep
  }
  g.errors = validatePrefs(g.raw, file).errors
  return g
}

export function startPrefs(g: GlobalFile): Prefs {
  return resolvePrefs([{ raw: g.raw, source: g.path }]).prefs
}

function dropKey(o: Obj, key: string): void {
  const [a, b] = key.split('.')
  if (b === undefined) delete o[a]
  else if (isObj(o[a])) delete (o[a] as Obj)[b]
}

export function nextRaw(raw: Obj, next: Prefs, touched: readonly string[]): Obj {
  const out = structuredClone(raw)
  out.preset = next.preset
  const g = out.guards
  if (touched.some((k) => k.startsWith('guards.')) && !isObj(g)) {
    const v = typeof g === 'string' ? ['on', 'yes', 'true'].includes(g.toLowerCase()) : g
    if (typeof v === 'boolean') out.guards = { stops: v, files: v }
  }
  const want = flatten(next)
  const base = flatten(presetDefaults(next.preset))
  for (const key of touched) {
    if (key === 'preset') continue
    if (want[key] === base[key]) dropKey(out, key)
    else {
      const [a, b] = key.split('.')
      if (b === undefined) out[a] = want[key]
      else {
        if (!isObj(out[a])) out[a] = {}
        ;(out[a] as Obj)[b] = want[key]
      }
    }
  }
  if (next.preset !== 'custom') for (const key of CUSTOM_KEYS) dropKey(out, key)
  for (const [k, v] of Object.entries(out)) if (isObj(v) && Object.keys(v).length === 0) delete out[k]
  return out
}

export function promoteToCustom(p: Prefs, touched: readonly string[]): { prefs: Prefs; touched: string[] } {
  if (p.preset === 'custom' || !touched.some((k) => CUSTOM_KEYS.includes(k))) return { prefs: p, touched: [...touched] }
  // custom starts from the involved defaults, so pin every custom-only value the old preset had
  return { prefs: { ...p, preset: 'custom' }, touched: [...new Set([...touched, ...CUSTOM_KEYS])] }
}

export function saveGlobal(g: GlobalFile, raw: Obj): void {
  if (g.error) throw new Error(`not saving over ${g.path}: ${g.error}`)
  writeFileAtomic(g.path, YAML.stringify(raw))
}
