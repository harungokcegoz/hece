import { describe, it, expect } from 'vitest'
import { emptyFlow, SliceInput } from '../../src/flow/types.js'
import {
  setPhase, addDecision, setPlan, startSlice, finishSlice, reportReview, approve, requestRedo, FlowError,
} from '../../src/flow/flow.js'

const slices: SliceInput[] = [
  { title: 'Token model', files: ['src/token.ts'], kind: 'teaching', model: 'sonnet' },
  { title: 'Login endpoint', files: ['src/login.ts'], kind: 'routine' },
]
const planned = () => setPlan(setPhase(emptyFlow(), 'discuss', { guards: true }, 1), slices, { guards: true }, 2)
const approvedPlan = () => approve(planned(), 3).state

describe('flow', () => {
  it('starts idle and moves phases', () => {
    expect(emptyFlow().phase).toBe('idle')
    expect(setPhase(emptyFlow(), 'discuss', { guards: true }, 5)).toMatchObject({ phase: 'discuss', updatedAt: 5 })
  })

  it('rejects unknown phases', () => {
    expect(() => setPhase(emptyFlow(), 'ship' as never, { guards: true }, 1)).toThrow(FlowError)
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
    expect(() => setPlan(emptyFlow(), [], { guards: true }, 1)).toThrow('at least one slice')
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

  const stoppedOne = () => finishSlice(startSlice(approvedPlan(), 1, { guards: true }, 4), 1, { summary: 'x', connectsTo: 'y' }, 5)

  it('with guards, refuses restarting the stopped slice without a redo request', () => {
    expect(() => startSlice(stoppedOne(), 1, { guards: true }, 6)).toThrow('hece: slice 1 is waiting for the user')
  })

  it('allows redoing the stopped slice after requestRedo, and clears the request', () => {
    const { state, requested } = requestRedo(stoppedOne(), 6)
    expect(requested).toBe(1)
    expect(state.plan!.slices[0]).toMatchObject({ status: 'stopped', redoRequested: true })
    const s = startSlice(state, 1, { guards: true }, 7)
    expect(s.plan!.slices[0].status).toBe('working')
    expect(s.plan!.slices[0].redoRequested).toBeUndefined()
  })

  it('requestRedo returns null when no slice is stopped', () => {
    const s = approvedPlan()
    const r = requestRedo(s, 6)
    expect(r.requested).toBeNull()
    expect(r.state).toBe(s)
  })

  it('with guards off, restarting a stopped slice needs no redo request', () => {
    expect(startSlice(stoppedOne(), 1, { guards: false }, 6).plan!.slices[0].status).toBe('working')
  })

  it('with guards, refuses starting another slice while one is still in progress', () => {
    const s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    expect(() => startSlice(s, 2, { guards: true }, 5)).toThrow('hece: slice 1 is still in progress; finish it first')
    expect(startSlice(s, 2, { guards: false }, 5).plan!.slices[1].status).toBe('working')
  })

  it('with guards, refuses a plan change while a slice is waiting for the user', () => {
    const renamed = [{ ...slices[0], title: 'Renamed' }, slices[1]]
    expect(() => setPlan(stoppedOne(), renamed, { guards: true }, 6))
      .toThrow('hece: slice 1 is waiting for the user; propose the plan change after they respond')
    expect(setPlan(stoppedOne(), renamed, { guards: false }, 6).plan!.slices[0].status).toBe('todo')
  })

  it('setPhase done with guards refuses while a slice is stopped or the plan is unapproved', () => {
    expect(() => setPhase(stoppedOne(), 'done', { guards: true }, 6)).toThrow('hece: slice 1 is waiting for the user')
    expect(() => setPhase(planned(), 'done', { guards: true }, 6)).toThrow('hece: the plan is waiting for the user to approve it')
    expect(setPhase(stoppedOne(), 'done', { guards: false }, 6).phase).toBe('done')
  })

  it('setPhase build with guards needs an approved plan', () => {
    expect(() => setPhase(emptyFlow(), 'build', { guards: true }, 1)).toThrow('hece: no plan yet; call flow_set_plan first')
    expect(() => setPhase(planned(), 'build', { guards: true }, 1)).toThrow('hece: the plan is waiting for the user to approve it')
    expect(setPhase(approvedPlan(), 'build', { guards: true }, 4).phase).toBe('build')
    expect(setPhase(planned(), 'build', { guards: false }, 4).phase).toBe('build')
  })

  it('a new plan after done moves to the plan phase', () => {
    const done = setPhase(approvedPlan(), 'done', { guards: true }, 4)
    expect(setPlan(done, slices, { guards: true }, 5).phase).toBe('plan')
  })

  it('a plan started after done begins a fresh flow, with nothing carried over', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    s = approve(s, 6).state
    s = reportReview(addDecision(s, { title: 'Auth', choice: 'JWT', why: 'x' }, 11), { important: 1, minor: 0 }, 12)
    expect(s.plan!.slices[0].status).toBe('approved')
    s = setPhase(s, 'done', { guards: true }, 13)
    const fresh = setPlan(s, [slices[0]], { guards: true }, 14)
    expect(fresh.plan!.slices[0]).toMatchObject({ n: 1, title: 'Token model', status: 'todo' })
    expect(fresh.plan).toMatchObject({ approved: false, changed: false })
    expect(fresh).toMatchObject({ phase: 'plan', decisions: [], currentSlice: null, review: null, updatedAt: 14 })
  })

  it('starting a discussion after done (or idle) begins a fresh flow', () => {
    const done = setPhase(addDecision(approvedPlan(), { title: 'Auth', choice: 'JWT', why: 'x' }, 4), 'done', { guards: true }, 5)
    expect(done.decisions).toHaveLength(1)
    const fresh = setPhase(done, 'discuss', { guards: true }, 6)
    expect(fresh).toEqual({ ...emptyFlow(), phase: 'discuss', updatedAt: 6 })
  })

  it('a decision moves an idle flow into discussion', () => {
    expect(addDecision(emptyFlow(), { title: 'A', choice: 'b', why: 'c' }, 3).phase).toBe('discuss')
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
    s = setPlan(s, [...slices, { title: 'Logout', files: ['src/logout.ts'], kind: 'routine' }], { guards: true }, 7)
    expect(s.plan).toMatchObject({ approved: false, changed: true })
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['approved', 'todo', 'todo'])
    expect(s.phase).toBe('build')
  })

  it('with guards off, a changed plan keeps a stopped slice stopped', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    s = setPlan(s, slices, { guards: false }, 6)
    expect(s.plan!.slices[0]).toMatchObject({ status: 'stopped', summary: 'x', connectsTo: 'y' })
    s = approve(s, 7).state
    expect(s.plan!.approved).toBe(true)
    expect(() => startSlice(s, 2, { guards: true }, 8)).toThrow('slice 1 is waiting for the user')
  })

  it('a changed plan keeps a working slice working', () => {
    const s = setPlan(startSlice(approvedPlan(), 1, { guards: true }, 4), slices, { guards: true }, 5)
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
