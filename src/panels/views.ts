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

// Fit to a short pane without losing what matters: the current step (a waiting
// step first) and the Claude/guards footer. Other rows fill in from the top.
export function fitFlowLines(lines: string[], width: number, height: number): string[] {
  const h = Math.max(0, height)
  if (lines.length <= h) return lines.map((l) => fitLine(l, width))
  const isFooter = (l: string) => l.startsWith('Claude:') || l.startsWith('guards:')
  let footerStart = lines.length
  while (footerStart > 0 && isFooter(lines[footerStart - 1])) footerStart--
  const marked = (l: string) => /^[▸■]/.test(l.trimStart())
  let current = lines.findIndex((l, i) => i < footerStart && (l.trimStart().startsWith('■') || l.includes('← waiting for you')))
  if (current < 0) current = lines.findIndex((l, i) => i < footerStart && marked(l))
  const priority: number[] = []
  if (current >= 0) priority.push(current)
  for (let i = footerStart; i < lines.length; i++) priority.push(i)
  const keep = new Set(priority.slice(0, h))
  for (let i = 0; i < lines.length && keep.size < h; i++) keep.add(i)
  return lines.filter((_, i) => keep.has(i)).map((l) => fitLine(l, width))
}

export function colorFlowLine(line: string): string {
  const t = line.trimStart()
  // a plan waiting for approval is as urgent as a waiting slice (the ' — ' suffix survives a cut line)
  const planWaits = t.startsWith('▸ Plan') && t.includes(' — ')
  if (line.includes('← waiting for you') || t.startsWith('■') || line.startsWith('Claude: wait') || planWaits) return color.boldRed(line)
  if (t.startsWith('▸')) return color.boldYellow(line)
  if (t.startsWith('✓')) return color.green(line)
  if (line.startsWith('hece')) return color.bold(line)
  if (line.startsWith('guards:') || line.startsWith('Claude:')) return color.dim(line)
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
