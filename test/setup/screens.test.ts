import { describe, it, expect } from 'vitest'
import { SCREENS, PREFS_NAMES, setKey, type SetupContext } from '../../src/setup/screens.js'
import { presetDefaults } from '../../src/prefs/schema.js'
import { VENDORS } from '../../src/prefs/vendors.js'
import { displayWidth } from '../../src/panels/fit.js'

const ctx: SetupContext = { onPath: (b) => b === 'claude', plugins: new Set(['ponytail']), fileErrors: [] }
const p = presetDefaults('involved')
const S = (id: string) => SCREENS.find((s) => s.id === id)!

describe('screens', () => {
  it('intro shows file errors', () => {
    expect(S('intro').lines(p, { ...ctx, fileErrors: ['bad x'] })).toContain('bad x')
  })
  it('agent screen', () => {
    const o = S('agent').options(p, ctx)
    expect(o.map((x) => x.label)).toEqual(['claude ✓', 'codex ✗', 'gemini ✗', 'opencode ✗'])
    expect(o.slice(1).every((x) => x.disabled === 'not supported yet')).toBe(true)
    expect(o[0].disabled).toBeUndefined()
  })
  it('preset previews', () => {
    const o = S('preset').options(p, ctx)
    expect(o).toHaveLength(3)
    for (const x of o) expect(x.preview!.length).toBeGreaterThan(0)
  })
  it('custom-only screens gated on custom', () => {
    const ids = ['discussion-first', 'pushback', 'slice-size', 'stop-depth', 'check-questions', 'side-chats', 'review-final', 'review-minor', 'recap']
    for (const id of ids) {
      expect(S(id).when!(p)).toBe(false)
      expect(S(id).when!({ ...p, preset: 'custom' })).toBe(true)
    }
  })
  it('optimize screen', () => {
    const s = S('optimize')
    expect(s.lines(p, ctx).join('\n')).toContain('/plugin install superpowers@claude-plugins-official')
    expect(s.lines(p, { ...ctx, plugins: null }).join('\n')).toContain("couldn't read Claude Code's plugin list")
  })
  it('model and effort screens', () => {
    const v = VENDORS.claude
    expect(S('orchestrator-model').options(p, ctx).map((o) => o.value)).toEqual(['default', ...v.models])
    expect(S('orchestrator-model').options(p, ctx)[0].label).toBe("Claude Code's own setting")
    expect(S('orchestrator-effort').options(p, ctx).map((o) => o.value)).toEqual(['default', ...v.efforts])
    for (const id of ['build-effort', 'review-effort']) expect(S(id).options(p, ctx).map((o) => o.value)).toEqual(v.efforts)
  })
  it('setKey clones', () => {
    expect(setKey(p, 'guards.files', false).guards).toEqual({ stops: true, files: false })
    expect(p.guards.files).toBe(true)
  })
  it('PREFS_NAMES', () => {
    for (const n of ['agent', 'preset', 'skills', 'models', 'guards', 'layout', 'pushback', 'recap']) expect(PREFS_NAMES).toContain(n)
    expect(PREFS_NAMES).not.toContain('intro')
  })
  it('labels fit 30 columns', () => {
    for (const agent of Object.keys(VENDORS) as (keyof typeof VENDORS)[])
      for (const preset of ['involved', 'learning', 'custom'] as const)
        for (const s of SCREENS) {
          const pr = { ...presetDefaults(preset), agent }
          for (const o of s.options(pr, ctx)) expect(displayWidth(o.label), `${s.id}: ${o.label}`).toBeLessThanOrEqual(30)
        }
  })
})
