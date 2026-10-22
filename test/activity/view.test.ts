import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan } from '../../src/flow/flow.js'
import { buildActivity } from '../../src/activity/view.js'
import { HeceEvent } from '../../src/state/store.js'

const flow = setPlan(emptyFlow(), [
  { title: 'Token model', files: [], kind: 'teaching' },
  { title: 'Login', files: [], kind: 'routine' },
], { guards: false }, 1)
const ctx = { root: '/p', flow }
const e = (event: string, extra: Record<string, unknown> = {}): HeceEvent => ({ at: 1, event, ...extra })

const events: HeceEvent[] = [
  e('flow', { tool: 'flow_set_phase', phase: 'build' }),
  e('flow', { tool: 'flow_start_slice', n: 1 }),
  e('note', { text: 'adding the token table', slice: 1 }),
  e('tool', { tool: 'Read', target: '/p/src/db.ts', slice: 1 }),
  e('tool', { tool: 'Read', target: '/p/src/db.ts', slice: 1 }),
  e('tool', { tool: 'mcp__hece__flow_get', target: '', slice: 1 }),
  e('tool', { tool: 'Edit', target: '/p/src/token.ts', slice: 1 }),
  e('approved', { what: 'slice', n: 1 }),
  e('flow', { tool: 'flow_start_slice', n: 2 }),
  e('tool', { tool: 'Bash', target: 'npm test', slice: 2 }),
]

describe('buildActivity', () => {
  it('groups by slice, indents, collapses repeats and hides bookkeeping', () => {
    expect(buildActivity(events, ctx, 50).map((l) => l.text)).toEqual([
      '◆ phase: build',
      '▸ Slice 1 · Token model',
      '  ◆ started slice 1: Token model',
      '  Now: adding the token table',
      '  · reading src/db.ts (×2)',
      '  · changing src/token.ts',
      '  ◆ you approved slice 1',
      '▸ Slice 2 · Login',
      '  ◆ started slice 2: Login',
      '  · running the tests',
    ])
  })

  it('keeps the last lines and re-adds the slice header at the top', () => {
    expect(buildActivity(events, ctx, 3).map((l) => l.text)).toEqual([
      '▸ Slice 2 · Login',
      '  ◆ started slice 2: Login',
      '  · running the tests',
    ])
    expect(buildActivity(events, ctx, 2).map((l) => l.text)).toEqual(['▸ Slice 2 · Login', '  · running the tests'])
  })

  it('returns kinds for colouring', () => {
    expect(buildActivity(events, ctx, 50).map((l) => l.kind).slice(0, 4)).toEqual(['milestone', 'header', 'milestone', 'note'])
  })

  it('is empty when nothing readable happened', () => {
    expect(buildActivity([e('prompt'), e('turn_done')], ctx, 10)).toEqual([])
  })
})
