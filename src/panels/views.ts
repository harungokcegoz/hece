import { FlowState, PHASES } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { SessionRecord } from '../hooks/handle.js'
import { color } from './color.js'
import { fitLine } from './fit.js'

export function flowPanelLines(flow: FlowState | null, opts: { guards: boolean; idle: boolean | null; home?: boolean }): string[] {
  if (!flow) {
    const empty = ['No flow yet.', 'Ask Claude to build', 'something to start one.']
    return opts.home ? [...empty, '', "Tip: you're in your home folder."] : empty
  }
  const lines = renderFlow(flow, { guards: opts.guards }).split('\n')
  const status = opts.idle === null ? [] : [opts.idle ? 'Claude: waiting for you' : 'Claude: working…']
  return [...lines.slice(0, -1), '', ...status, lines[lines.length - 1]]
}

// Pick which rows survive in a short pane: the current step (a waiting slice first,
// then the working slice, then the phase) and the Claude/guards footer. Other rows
// fill in from the top.
function selectFlowLines(lines: string[], height: number): string[] {
  const h = Math.max(0, height)
  if (lines.length <= h) return lines
  const isFooter = (l: string) => l.startsWith('Claude:') || l.startsWith('guards:')
  let footerStart = lines.length
  while (footerStart > 0 && isFooter(lines[footerStart - 1])) footerStart--
  const body = (l: string, i: number) => i < footerStart && l.length > 0
  const isSlice = (l: string) => /^\s+\S/.test(l)
  let current = lines.findIndex((l, i) => body(l, i) && (l.trimStart().startsWith('■') || l.includes('← waiting for you')))
  if (current < 0) current = lines.findIndex((l, i) => body(l, i) && isSlice(l) && l.trimStart().startsWith('▸'))
  if (current < 0) current = lines.findIndex((l, i) => body(l, i) && /^[▸■]/.test(l.trimStart()))
  const priority: number[] = []
  if (current >= 0) priority.push(current)
  for (let i = footerStart; i < lines.length; i++) priority.push(i)
  const keep = new Set(priority.slice(0, h))
  for (let i = 0; i < lines.length && keep.size < h; i++) keep.add(i)
  return lines.filter((_, i) => keep.has(i))
}

export function fitFlowLines(lines: string[], width: number, height: number): string[] {
  return selectFlowLines(lines, height).map((l) => fitLine(l, width))
}

// Colour follows what a row means, judged on the full text: a cut line keeps its colour
// at any width. Painting happens after fitting because fitLine strips ANSI.
export function paintFlowLines(lines: string[], width: number, height: number): string[] {
  return selectFlowLines(lines, height).map((l) => colorFlowLine(fitLine(l, width), l))
}

export function colorFlowLine(line: string, source = line): string {
  const t = source.trimStart()
  // a plan waiting for approval is as urgent as a waiting slice
  const planWaits = t.startsWith('▸ Plan') && t.includes(' — ')
  if (source.includes('← waiting for you') || t.startsWith('■') || source.startsWith('Claude: wait') || planWaits) return color.boldRed(line)
  if (t.startsWith('▸')) return color.boldYellow(line)
  if (t.startsWith('✓')) return color.green(line)
  if (source.startsWith('hece')) return color.bold(line)
  if (source.startsWith('guards:') || source.startsWith('Claude:')) return color.dim(line)
  return line
}

export function sessionsPanelLines(sessions: SessionRecord[]): string[] {
  if (sessions.length === 0) return ['none yet']
  return [
    ...sessions.slice(-8).map((s) => `• ${s.source === 'startup' ? 'main' : s.source} ${s.sessionId.slice(0, 8)}`),
  ]
}

// Shape checks for state files that parsed as JSON but may still be the wrong thing.
// Panels only read what they render, so these check just that much.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isFlowState(v: unknown): v is FlowState {
  if (!isObject(v)) return false
  if (typeof v.phase !== 'string' || !(PHASES as readonly string[]).includes(v.phase)) return false
  if (!Array.isArray(v.decisions)) return false
  if (v.currentSlice !== null && v.currentSlice !== undefined && typeof v.currentSlice !== 'number') return false
  if (v.plan !== null && v.plan !== undefined) {
    if (!isObject(v.plan) || !Array.isArray(v.plan.slices)) return false
    const ok = v.plan.slices.every(
      (sl) => isObject(sl) && typeof sl.n === 'number' && typeof sl.title === 'string' && typeof sl.status === 'string' && Array.isArray(sl.files),
    )
    if (!ok) return false
  }
  return true
}

export function isSessionList(v: unknown): v is SessionRecord[] {
  return Array.isArray(v) && v.every((s) => isObject(s) && typeof s.sessionId === 'string' && typeof s.source === 'string')
}

export function isAgentState(v: unknown): v is { idle: boolean } {
  return isObject(v) && typeof v.idle === 'boolean'
}
