import { FlowState, Phase, PHASES, Slice, SliceInput } from './types.js'

export class FlowError extends Error {}

const clone = (s: FlowState): FlowState => structuredClone(s)

export function setPhase(s: FlowState, phase: Phase, now: number): FlowState {
  if (!PHASES.includes(phase)) throw new FlowError(`unknown phase "${phase}"; valid: ${PHASES.join(', ')}`)
  const next = clone(s)
  next.phase = phase
  next.updatedAt = now
  return next
}

export function addDecision(s: FlowState, d: { title: string; choice: string; why: string }, now: number): FlowState {
  const next = clone(s)
  next.decisions.push({ title: d.title, choice: d.choice, why: d.why, at: now })
  next.updatedAt = now
  return next
}

export function setPlan(s: FlowState, input: SliceInput[], now: number): FlowState {
  if (input.length === 0) throw new FlowError('a plan needs at least one slice')
  const next = clone(s)
  const prev = s.plan
  const slices: Slice[] = input.map((x, i) => {
    const n = i + 1
    const old = prev?.slices.find((p) => p.n === n && p.title === x.title)
    if (old && old.status === 'approved') return { ...old, files: x.files, kind: x.kind, model: x.model }
    return { n, title: x.title, files: x.files, kind: x.kind, model: x.model, status: 'todo' }
  })
  next.plan = { slices, approved: false, changed: prev !== null }
  if (next.currentSlice !== null && next.currentSlice > slices.length) next.currentSlice = null
  if (next.phase === 'idle' || next.phase === 'discuss') next.phase = 'plan'
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
    if (!next.plan!.approved) throw new FlowError('hece: the plan is waiting for the user to approve it')
    const waiting = next.plan!.slices.find((x) => x.status === 'stopped' && x.n !== n)
    if (waiting) throw new FlowError(`hece: slice ${waiting.n} is waiting for the user`)
  }
  if (sl.status === 'approved') throw new FlowError(`slice ${n} is already approved`)
  sl.status = 'working'
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
  sl.summary = info.summary
  sl.connectsTo = info.connectsTo
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

export type Approved = { what: 'plan' } | { what: 'slice'; n: number } | null

// Human-only. Called by hooks when the user approves; never exposed as an MCP tool.
export function approve(s: FlowState, now: number): { state: FlowState; approved: Approved } {
  const next = clone(s)
  if (next.plan && !next.plan.approved) {
    next.plan.approved = true
    next.plan.changed = false
    next.updatedAt = now
    return { state: next, approved: { what: 'plan' } }
  }
  const sl = next.plan?.slices.find((x) => x.status === 'stopped')
  if (sl) {
    sl.status = 'approved'
    next.updatedAt = now
    return { state: next, approved: { what: 'slice', n: sl.n } }
  }
  return { state: s, approved: null }
}
