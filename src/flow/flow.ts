import { BuildMode, FlowState, Phase, PHASES, Slice, SliceInput, emptyFlow } from './types.js'

export class FlowError extends Error {}

const clone = (s: FlowState): FlowState => structuredClone(s)

const PLAN_WAITING = 'hece: the plan is waiting for the user to approve it'
const sliceWaiting = (n: number) => `hece: slice ${n} is waiting for the user`

export function setPhase(s: FlowState, phase: Phase, opts: { guards: boolean }, now: number): FlowState {
  if (!PHASES.includes(phase)) throw new FlowError(`unknown phase "${phase}"; valid: ${PHASES.join(', ')}`)
  if (opts.guards) {
    const waiting = s.plan?.slices.find((x) => x.status === 'stopped')
    if (phase === 'done') {
      if (waiting) throw new FlowError(sliceWaiting(waiting.n))
      if (s.plan && !s.plan.approved) throw new FlowError(PLAN_WAITING)
    }
    if (phase === 'build') {
      if (!s.plan) throw new FlowError('hece: no plan yet; call flow_set_plan first')
      if (!s.plan.approved) throw new FlowError(PLAN_WAITING)
    }
  }
  // A new discussion clears the work, while the bound main session keeps ownership.
  if (phase === 'discuss' && (s.phase === 'idle' || s.phase === 'done')) {
    return { ...emptyFlow(), mainSessionId: s.mainSessionId ?? null, phase: 'discuss', updatedAt: now }
  }
  const next = clone(s)
  next.phase = phase
  next.updatedAt = now
  return next
}

export function addDecision(s: FlowState, d: { title: string; choice: string; why: string }, now: number): FlowState {
  const next = clone(s)
  next.decisions.push({ title: d.title, choice: d.choice, why: d.why, at: now })
  if (next.phase === 'idle') next.phase = 'discuss'
  next.updatedAt = now
  return next
}

export function setPlan(s: FlowState, input: SliceInput[], opts: { guards: boolean }, now: number): FlowState {
  if (input.length === 0) throw new FlowError('a plan needs at least one slice')
  if (opts.guards) {
    const waiting = s.plan?.slices.find((x) => x.status === 'stopped')
    if (waiting) throw new FlowError(`${sliceWaiting(waiting.n)}; propose the plan change after they respond`)
  }
  // A plan after done clears the finished work, but keeps the same main session.
  const base = s.phase === 'done' ? { ...emptyFlow(), mainSessionId: s.mainSessionId ?? null } : s
  const next = clone(base)
  const prev = base.plan
  const slices: Slice[] = input.map((x, i) => {
    const n = i + 1
    const old = prev?.slices.find((p) => p.n === n && p.title === x.title)
    if (old && old.status !== 'todo') return { ...old, files: x.files, kind: x.kind, model: x.model }
    return { n, title: x.title, files: x.files, kind: x.kind, model: x.model, status: 'todo' }
  })
  next.plan = { slices, approved: false, changed: prev !== null }
  if (prev?.mode) next.plan.mode = prev.mode
  if (next.currentSlice !== null && next.currentSlice > slices.length) next.currentSlice = null
  if (next.phase === 'idle' || next.phase === 'discuss' || next.phase === 'done') next.phase = 'plan'
  next.updatedAt = now
  return next
}

function findSlice(s: FlowState, n: number): Slice {
  if (!s.plan) throw new FlowError('no plan yet; call flow_set_plan first')
  const sl = s.plan.slices.find((x) => x.n === n)
  if (!sl) throw new FlowError(`no slice ${n}; the plan has ${s.plan.slices.length}`)
  return sl
}

export function startSlice(s: FlowState, n: number, opts: { guards: boolean }, now: number): FlowState {
  const next = clone(s)
  const sl = findSlice(next, n)
  if (opts.guards) {
    if (!next.plan!.approved) throw new FlowError(PLAN_WAITING)
    const parallel = next.plan!.mode === 'parallel'
    // in parallel mode other stopped slices don't block; only restarting this one needs a redo
    const waiting = next.plan!.slices.find(
      (x) => x.status === 'stopped' && (parallel ? x.n === n && !x.redoRequested : x.n !== n || !x.redoRequested),
    )
    if (waiting) throw new FlowError(sliceWaiting(waiting.n))
    const busy = parallel ? undefined : next.plan!.slices.find((x) => x.status === 'working' && x.n !== n)
    if (busy) throw new FlowError(`hece: slice ${busy.n} is still in progress; finish it first`)
  }
  if (sl.status === 'approved') throw new FlowError(`slice ${n} is already approved`)
  sl.status = 'working'
  delete sl.redoRequested
  delete next.checkPending
  next.currentSlice = n
  next.phase = 'build'
  next.updatedAt = now
  return next
}

export function finishSlice(
  s: FlowState,
  n: number,
  info: { summary: string; connectsTo: string },
  now: number,
): FlowState {
  const next = clone(s)
  const sl = findSlice(next, n)
  if (sl.status !== 'working') throw new FlowError(`slice ${n} is not in progress (status: ${sl.status})`)
  sl.status = 'stopped'
  delete next.checkPending
  sl.summary = info.summary
  sl.connectsTo = info.connectsTo
  next.updatedAt = now
  return next
}

// Called by the agent just before it asks a check question. The hook clears it on the user's next answer.
export function markCheckPending(s: FlowState, now: number): FlowState {
  if (!s.plan?.slices.some((x) => x.status === 'stopped')) {
    throw new FlowError('hece: no slice is waiting for the user, so there is no check question to mark')
  }
  if (batchRunning(s)) throw new FlowError('hece: slices are still running; ask the check question once the batch is done')
  const next = clone(s)
  next.checkPending = true
  next.updatedAt = now
  return next
}

// Human-only, like approve(). Called by hooks when the user answers while a check question is open.
export function clearCheckPending(s: FlowState, now: number): FlowState {
  const next = clone(s)
  delete next.checkPending
  next.updatedAt = now
  return next
}

export function reportReview(s: FlowState, r: { important: number; minor: number }, now: number): FlowState {
  const next = clone(s)
  next.review = { important: r.important, minor: r.minor, at: now }
  next.phase = 'review'
  next.updatedAt = now
  return next
}

// Human-only, like approve(). Called by hooks when the user picks the build mode, before any slice starts.
export function chooseMode(s: FlowState, mode: BuildMode, now: number): FlowState | null {
  if (!s.plan?.approved || s.plan.slices.some((x) => x.status !== 'todo')) return null
  const next = clone(s)
  next.plan!.mode = mode
  next.updatedAt = now
  return next
}

// A parallel batch is running while some slices are still going and others already stopped.
export function batchRunning(s: FlowState): boolean {
  const sl = s.plan?.slices ?? []
  return s.plan?.mode === 'parallel' && sl.some((x) => x.status === 'todo' || x.status === 'working') && sl.some((x) => x.status === 'stopped')
}

// Human-only, like approve(). Called by hooks when the user asks to redo waiting slices.
// With ns, marks the stopped slices among them; without, marks the only stopped slice (if exactly one).
export function requestRedo(
  s: FlowState,
  now: number,
  ns: number[] = [],
): { state: FlowState; requested: number[]; waiting: number[] } {
  const next = clone(s)
  const stopped = next.plan?.slices.filter((x) => x.status === 'stopped') ?? []
  const waiting = stopped.map((x) => x.n)
  const picked = ns.length > 0 ? stopped.filter((x) => ns.includes(x.n)) : stopped.length === 1 ? stopped : []
  if (picked.length === 0) return { state: s, requested: [], waiting }
  for (const sl of picked) sl.redoRequested = true
  next.updatedAt = now
  return { state: next, requested: picked.map((x) => x.n), waiting }
}

export type Approved = { what: 'plan' } | { what: 'slice'; n: number } | { what: 'slices'; ns: number[] } | null

// Human-only. Called by hooks when the user approves; never exposed as an MCP tool.
export function approve(s: FlowState, now: number): { state: FlowState; approved: Approved } {
  const next = clone(s)
  if (next.plan && !next.plan.approved) {
    next.plan.approved = true
    next.plan.changed = false
    next.updatedAt = now
    return { state: next, approved: { what: 'plan' } }
  }
  if (next.plan?.mode === 'parallel') {
    if (next.plan.slices.some((x) => x.status === 'todo' || x.status === 'working')) return { state: s, approved: null }
    const done = next.plan.slices.filter((x) => x.status === 'stopped')
    if (done.length === 0) return { state: s, approved: null }
    for (const sl of done) {
      sl.status = 'approved'
      delete sl.redoRequested
    }
    next.updatedAt = now
    return { state: next, approved: { what: 'slices', ns: done.map((x) => x.n) } }
  }
  const sl = next.plan?.slices.find((x) => x.status === 'stopped')
  if (sl) {
    sl.status = 'approved'
    delete sl.redoRequested
    next.updatedAt = now
    return { state: next, approved: { what: 'slice', n: sl.n } }
  }
  return { state: s, approved: null }
}
