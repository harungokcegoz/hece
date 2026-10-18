import { describe, it, expect } from 'vitest'
import { emptyFlow, SliceInput } from '../../src/flow/types.js'
import {
  setPhase, addDecision, setPlan, startSlice, finishSlice, reportReview, approve, FlowError,
} from '../../src/flow/flow.js'

const slices: SliceInput[] = [
  { title: 'Token model', files: ['src/token.ts'], kind: 'teaching', model: 'sonnet' },
  { title: 'Login endpoint', files: ['src/login.ts'], kind: 'routine' },
]
const planned = () => setPlan(setPhase(emptyFlow(), 'discuss', 1), slices, 2)
const approvedPlan = () => approve(planned(), 3).state

describe('flow', () => {
  it('starts idle and moves phases', () => {
    expect(emptyFlow().phase).toBe('idle')
    expect(setPhase(emptyFlow(), 'discuss', 5)).toMatchObject({ phase: 'discuss', updatedAt: 5 })
  })

  it('rejects unknown phases', () => {
    expect(() => setPhase(emptyFlow(), 'ship' as never, 1)).toThrow(FlowError)
  })

  it('does not mutate its input', () => {
    const s = emptyFlow()
    addDecision(s, { title: 'Auth', choice: 'JWT', why: 'stateless' }, 1)
    expect(s.decisions).toEqual([])
  })

  it('records decisions', () => {
    const s = addDecision(emptyFlow(), { title: 'Auth', choice: 'JWT', why: 'stateless' }, 9)
    expect(s.decisions).toEqual([{ title: 'Auth', choice: 'JWT', why: 'stateless', at: 9 }])
  })

  it('sets a plan that needs approval and moves to the plan phase', () => {
    const s = planned()
    expect(s.phase).toBe('plan')
    expect(s.plan).toMatchObject({ approved: false, changed: false })
    expect(s.plan!.slices.map((x) => [x.n, x.status])).toEqual([[1, 'todo'], [2, 'todo']])
  })

  it('rejects an empty plan', () => {
    expect(() => setPlan(emptyFlow(), [], 1)).toThrow('at least one slice')
  })

  it('approve() approves a pending plan first', () => {
    const { state, approved } = approve(planned(), 3)
    expect(approved).toEqual({ what: 'plan' })
    expect(state.plan!.approved).toBe(true)
  })

  it('approve() returns null when nothing is waiting', () => {
    expect(approve(emptyFlow(), 1).approved).toBeNull()
  })

  it('with guards, refuses to start a slice before the plan is approved', () => {
    expect(() => startSlice(planned(), 1, { guards: true }, 4)).toThrow('plan is waiting')
  })

  it('without guards, allows starting before approval', () => {
    expect(startSlice(planned(), 1, { guards: false }, 4).plan!.slices[0].status).toBe('working')
  })

  it('runs a slice: start → finish (stopped) → approve', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    expect(s).toMatchObject({ phase: 'build', currentSlice: 1 })
    s = finishSlice(s, 1, { summary: 'added Token', connectsTo: 'used by login' }, 5)
    expect(s.plan!.slices[0]).toMatchObject({ status: 'stopped', summary: 'added Token', connectsTo: 'used by login' })
    const r = approve(s, 6)
    expect(r.approved).toEqual({ what: 'slice', n: 1 })
    expect(r.state.plan!.slices[0].status).toBe('approved')
  })

  it('with guards, refuses the next slice while one is waiting for the user', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    expect(() => startSlice(s, 2, { guards: true }, 6)).toThrow('slice 1 is waiting for the user')
  })

  it('allows redoing the stopped slice itself', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    expect(startSlice(s, 1, { guards: true }, 6).plan!.slices[0].status).toBe('working')
  })

  it('refuses to finish a slice that is not in progress', () => {
    expect(() => finishSlice(approvedPlan(), 1, { summary: 'x', connectsTo: 'y' }, 5)).toThrow('not in progress')
  })

  it('refuses unknown slices with a helpful message', () => {
    expect(() => startSlice(approvedPlan(), 7, { guards: true }, 4)).toThrow('no slice 7; the plan has 2')
    expect(() => startSlice(emptyFlow(), 1, { guards: true }, 4)).toThrow('no plan yet')
  })

  it('a changed plan needs approval again and keeps approved slices', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    s = approve(s, 6).state
    s = setPlan(s, [...slices, { title: 'Logout', files: ['src/logout.ts'], kind: 'routine' }], 7)
    expect(s.plan).toMatchObject({ approved: false, changed: true })
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['approved', 'todo', 'todo'])
    expect(s.phase).toBe('build')
  })

  it('a changed plan keeps a stopped slice stopped, so the stop cannot be bypassed', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    s = setPlan(s, slices, 6)
    expect(s.plan!.slices[0]).toMatchObject({ status: 'stopped', summary: 'x', connectsTo: 'y' })
    s = approve(s, 7).state
    expect(s.plan!.approved).toBe(true)
    expect(() => startSlice(s, 2, { guards: true }, 8)).toThrow('slice 1 is waiting for the user')
  })

  it('a changed plan keeps a working slice working', () => {
    const s = setPlan(startSlice(approvedPlan(), 1, { guards: true }, 4), slices, 5)
    expect(s.plan!.slices[0].status).toBe('working')
    expect(s.currentSlice).toBe(1)
  })

  it('reports review counts and enters the review phase', () => {
    expect(reportReview(emptyFlow(), { important: 2, minor: 3 }, 8)).toMatchObject({
      phase: 'review',
      review: { important: 2, minor: 3, at: 8 },
    })
  })
})
