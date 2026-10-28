import { describe, it, expect } from 'vitest'
import { emptyFlow, SliceInput } from '../../src/flow/types.js'
import {
  setPhase, addDecision, setPlan, startSlice, finishSlice, reportReview, approve, requestRedo, markCheckPending, chooseMode, batchRunning, FlowError,
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
    expect(requested).toEqual([1])
    expect(state.plan!.slices[0]).toMatchObject({ status: 'stopped', redoRequested: true })
    const s = startSlice(state, 1, { guards: true }, 7)
    expect(s.plan!.slices[0].status).toBe('working')
    expect(s.plan!.slices[0].redoRequested).toBeUndefined()
  })

  it('requestRedo returns nothing when no slice is stopped', () => {
    const s = approvedPlan()
    const r = requestRedo(s, 6)
    expect(r.requested).toEqual([])
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


describe('main session across flow transitions', () => {
  it.each(['idle', 'done'] as const)('preserves main session when starting discussion from %s', phase => {
    const state = { ...emptyFlow(), phase, mainSessionId: 'main' }
    const fresh = setPhase(state, 'discuss', { guards: true }, 10)
    expect(fresh.mainSessionId).toBe('main')
    expect(fresh.phase).toBe('discuss')
    expect(state.phase).toBe(phase)
  })

  it('preserves main session when a plan starts after done', () => {
    const state = { ...emptyFlow(), phase: 'done' as const, mainSessionId: 'main' }
    const fresh = setPlan(state, slices, { guards: true }, 10)
    expect(fresh.mainSessionId).toBe('main')
    expect(fresh.plan!.approved).toBe(false)
  })
})

describe('check question marker', () => {
  const waiting = () => finishSlice(startSlice(approvedPlan(), 1, { guards: true }, 4), 1, { summary: 's', connectsTo: 'c' }, 5)

  it('is set while a slice waits for the user', () => {
    expect(markCheckPending(waiting(), 6).checkPending).toBe(true)
  })
  it.each([
    ['no plan', () => emptyFlow()],
    ['a working slice', () => startSlice(approvedPlan(), 1, { guards: true }, 4)],
  ])('is refused with %s', (_n, make) => {
    expect(() => markCheckPending(make(), 6)).toThrow(FlowError)
  })
  it('does not survive starting a slice again', () => {
    const redo = requestRedo(markCheckPending(waiting(), 6), 7).state
    expect(startSlice(redo, 1, { guards: true }, 8).checkPending).toBeFalsy()
  })
})

const threeSlices: SliceInput[] = [...slices, { title: 'Refresh', files: ['src/refresh.ts'], kind: 'routine' }]
const G = { guards: true }
const info = { summary: 'a', connectsTo: 'b' }
const unapprovedPlan = () => setPlan(setPhase(emptyFlow(), 'discuss', G, 1), threeSlices, G, 2)
const approvedThree = () => approve(unapprovedPlan(), 3).state
const parallelPlan = () => chooseMode(approvedThree(), 'parallel', 4)!
const allStopped = () =>
  [1, 2, 3].reduce((s, n) => finishSlice(startSlice(s, n, G, 5 + n), n, info, 9 + n), parallelPlan())

describe('parallel mode', () => {
  it('chooseMode records the mode only after approval and before any slice starts', () => {
    expect(chooseMode(unapprovedPlan(), 'parallel', 5)).toBeNull()
    expect(chooseMode(approvedThree(), 'parallel', 5)!.plan!.mode).toBe('parallel')
    expect(chooseMode(startSlice(parallelPlan(), 1, G, 5), 'one-by-one', 6)).toBeNull()
  })
  it('lets several slices work at once, but not restart a stopped one without redo', () => {
    const s = startSlice(startSlice(parallelPlan(), 1, G, 5), 2, G, 6)
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['working', 'working', 'todo'])
    const stopped = finishSlice(s, 1, info, 7)
    expect(() => startSlice(stopped, 1, G, 8)).toThrow('slice 1 is waiting')
    expect(startSlice(stopped, 3, G, 8).plan!.slices[2].status).toBe('working')
  })
  it('approves nothing while the batch runs, then every stopped slice at once', () => {
    const mid = finishSlice(startSlice(startSlice(parallelPlan(), 1, G, 5), 2, G, 6), 1, info, 7)
    expect(batchRunning(mid)).toBe(true)
    expect(approve(mid, 8).approved).toBeNull()
    const done = finishSlice(startSlice(finishSlice(mid, 2, info, 8), 3, G, 9), 3, info, 10)
    const r = approve(done, 11)
    expect(r.approved).toEqual({ what: 'slices', ns: [1, 2, 3] })
    expect(r.state.plan!.slices.every((x) => x.status === 'approved')).toBe(true)
  })
  it('redoes exactly the named stopped slices', () => {
    const r = requestRedo(allStopped(), 12, [2, 9])
    expect(r.requested).toEqual([2])
    expect(r.state.plan!.slices.map((x) => !!x.redoRequested)).toEqual([false, true, false])
    expect(requestRedo(allStopped(), 12).requested).toEqual([]) // several stopped, none named
    expect(requestRedo(allStopped(), 12).waiting).toEqual([1, 2, 3])
  })
  it('restarts a stopped slice after a redo request in parallel mode', () => {
    const s = startSlice(requestRedo(allStopped(), 12, [2]).state, 2, G, 13)
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['stopped', 'working', 'stopped'])
    expect(s.plan!.slices[1].redoRequested).toBeFalsy()
  })
  it('refuses a check question while the batch runs', () => {
    const mid = finishSlice(startSlice(startSlice(parallelPlan(), 1, G, 5), 2, G, 6), 1, info, 7)
    expect(() => markCheckPending(mid, 8)).toThrow('hece: slices are still running; ask the check question once the batch is done')
    expect(markCheckPending(allStopped(), 13).checkPending).toBe(true)
  })
  it('keeps the mode across a plan change', () => {
    const changed = setPlan(startSlice(parallelPlan(), 1, G, 5), threeSlices, G, 6)
    expect(changed.plan!.mode).toBe('parallel')
  })
})
