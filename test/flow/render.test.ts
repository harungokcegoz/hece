import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, addDecision, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { renderFlow } from '../../src/flow/render.js'

describe('renderFlow', () => {
  it('renders an idle flow', () => {
    expect(renderFlow(emptyFlow(), { guards: true })).toBe(
      [
        'hece · idle',
        '  Discussion (0 decisions)',
        '  Plan',
        '  Build',
        '  Review',
        '  Recap',
        'guards: on',
      ].join('\n'),
    )
  })

  it('renders a build in progress with a slice waiting for the user', () => {
    let s = addDecision(setPhase(emptyFlow(), 'discuss', 1), { title: 'Auth', choice: 'JWT', why: 'x' }, 2)
    s = setPlan(s, [
      { title: 'Token model', files: [], kind: 'teaching' },
      { title: 'Login endpoint', files: [], kind: 'routine' },
      { title: 'Refresh', files: [], kind: 'routine' },
    ], 3)
    s = approve(s, 4).state
    s = startSlice(s, 1, { guards: true }, 5)
    s = finishSlice(s, 1, { summary: 'a', connectsTo: 'b' }, 6)
    s = approve(s, 7).state
    s = startSlice(s, 2, { guards: true }, 8)
    s = finishSlice(s, 2, { summary: 'a', connectsTo: 'b' }, 9)
    expect(renderFlow(s, { guards: false })).toBe(
      [
        'hece · build',
        '✓ Discussion (1 decision)',
        '✓ Plan (3 slices)',
        '▸ Build',
        '  ✓ 1. Token model',
        '  ■ 2. Login endpoint  ← waiting for you',
        '    3. Refresh',
        '  Review',
        '  Recap',
        'guards: off',
      ].join('\n'),
    )
  })

  it('flags a changed plan waiting for approval', () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }], 1)
    s = setPlan(s, [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 2)
    expect(renderFlow(s, { guards: true })).toContain('▸ Plan (2 slices) — changed, waiting for approval')
  })

  it('shows review counts and marks everything done at the end', () => {
    const s = { ...setPhase(emptyFlow(), 'done', 1), review: { important: 2, minor: 3, at: 1 } }
    const out = renderFlow(s, { guards: true })
    expect(out).toContain('✓ Review (2 important, 3 minor)')
    expect(out).toContain('✓ Recap')
  })
})
