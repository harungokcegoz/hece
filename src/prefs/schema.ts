export type Widget = 'flow' | 'activity' | 'sessions' | 'none'

export interface Prefs {
  preset: 'involved' | 'learning' | 'custom'
  agent: 'claude' | 'codex' | 'gemini' | 'opencode'
  discussion: { first: 'me' | 'agent'; pushback: 'gentle' | 'direct' }
  plan: { slice_size: 'small' | 'medium' }
  slice_stop: { depth: 'line' | 'short' | 'detailed' }
  check_questions: 'off' | 'non-routine' | 'every'
  side_chats: { open_in: 'pane' | 'window' }
  review: { final: boolean; reviewer_model: string; show_minor: boolean }
  flow_recap: boolean
  layout: { left: Widget; right: Widget }
  delegate: { orchestrator: string; build: string; review: string }
  guards: boolean
}

const INVOLVED: Prefs = {
  preset: 'involved',
  agent: 'claude',
  discussion: { first: 'me', pushback: 'direct' },
  plan: { slice_size: 'small' },
  slice_stop: { depth: 'short' },
  check_questions: 'off',
  side_chats: { open_in: 'pane' },
  review: { final: true, reviewer_model: 'opus', show_minor: false },
  flow_recap: false,
  layout: { left: 'activity', right: 'flow' },
  delegate: { orchestrator: 'opus', build: 'sonnet', review: 'opus' },
  guards: true,
}

export function presetDefaults(preset: Prefs['preset']): Prefs {
  const base = structuredClone(INVOLVED)
  base.preset = preset
  if (preset === 'learning') {
    base.check_questions = 'non-routine'
    base.review.show_minor = true
    base.flow_recap = true
  }
  return base
}

type Rule = { kind: 'enum'; values: readonly string[] } | { kind: 'bool' } | { kind: 'string' }
const e = (...values: string[]): Rule => ({ kind: 'enum', values })
const BOOL: Rule = { kind: 'bool' }
const STR: Rule = { kind: 'string' }
const WIDGETS = e('flow', 'activity', 'sessions', 'none')

const RULES: Record<string, Rule> = {
  preset: e('involved', 'learning', 'custom'),
  agent: e('claude', 'codex', 'gemini', 'opencode'),
  'discussion.first': e('me', 'agent'),
  'discussion.pushback': e('gentle', 'direct'),
  'plan.slice_size': e('small', 'medium'),
  'slice_stop.depth': e('line', 'short', 'detailed'),
  check_questions: e('off', 'non-routine', 'every'),
  'side_chats.open_in': e('pane', 'window'),
  'review.final': BOOL,
  'review.reviewer_model': STR,
  'review.show_minor': BOOL,
  flow_recap: BOOL,
  'layout.left': WIDGETS,
  'layout.right': WIDGETS,
  'delegate.orchestrator': STR,
  'delegate.build': STR,
  'delegate.review': STR,
  guards: BOOL,
}

type Check = { ok: true; value: string | boolean } | { ok: false; allowed: string }

function check(rule: Rule, v: unknown): Check {
  if (rule.kind === 'enum') {
    return typeof v === 'string' && rule.values.includes(v)
      ? { ok: true, value: v }
      : { ok: false, allowed: rule.values.join(' | ') }
  }
  if (rule.kind === 'bool') {
    // yaml v2 (YAML 1.2) parses on/off/yes/no as strings, but users mean booleans
    if (typeof v === 'boolean') return { ok: true, value: v }
    if (v === 'on' || v === 'yes') return { ok: true, value: true }
    if (v === 'off' || v === 'no') return { ok: true, value: false }
    return { ok: false, allowed: 'on | off' }
  }
  return typeof v === 'string' && v.trim() !== '' ? { ok: true, value: v } : { ok: false, allowed: 'a non-empty string' }
}

export function validatePrefs(raw: unknown, source: string): { flat: Record<string, string | boolean>; errors: string[] } {
  const flat: Record<string, string | boolean> = {}
  const errors: string[] = []
  if (raw === null || raw === undefined) return { flat, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { flat, errors: [`${source}: preferences must be a mapping of keys to values`] }
  }
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined
      if (!rule) {
        const isGroup = Object.keys(RULES).some((r) => r.startsWith(key + '.'))
        if (isGroup && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          walk(v as Record<string, unknown>, key)
        } else {
          errors.push(isGroup ? `${source}: "${key}" must be a mapping` : `${source}: unknown key "${key}"`)
        }
        continue
      }
      const r = check(rule, v)
      if (r.ok) flat[key] = r.value
      else errors.push(`${source}: "${key}" is ${JSON.stringify(v)}; allowed: ${r.allowed}`)
    }
  }
  walk(raw as Record<string, unknown>, '')
  return { flat, errors }
}

function applyFlat(base: Prefs, flat: Record<string, string | boolean>): Prefs {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>
  for (const [key, value] of Object.entries(flat)) {
    const [group, leaf] = key.split('.')
    if (leaf === undefined) (out as unknown as Record<string, unknown>)[group] = value
    else out[group][leaf] = value
  }
  return out as unknown as Prefs
}

export function resolvePrefs(layers: { raw: unknown; source: string }[]): { prefs: Prefs; errors: string[] } {
  const validated = layers.map((l) => validatePrefs(l.raw, l.source))
  const merged: Record<string, string | boolean> = Object.assign({}, ...validated.map((v) => v.flat))
  const preset = (merged.preset as Prefs['preset'] | undefined) ?? 'involved'
  return { prefs: applyFlat(presetDefaults(preset), merged), errors: validated.flatMap((v) => v.errors) }
}
