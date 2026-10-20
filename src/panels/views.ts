import { FlowState } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { SessionRecord } from '../hooks/handle.js'
import { color } from './color.js'

export function flowPanelLines(flow: FlowState | null, opts: { guards: boolean; idle: boolean | null }): string[] {
  if (!flow) return ['hece', '', 'No flow yet.', 'Ask Claude to build', 'something to start one.']
  const lines = renderFlow(flow, { guards: opts.guards }).split('\n')
  const status = opts.idle === null ? [] : [opts.idle ? 'Claude: waiting for you' : 'Claude: working…']
  return [...lines.slice(0, -1), '', ...status, lines[lines.length - 1]]
}

export function colorFlowLine(line: string): string {
  const t = line.trimStart()
  if (line.includes('← waiting for you') || t.startsWith('■') || line.startsWith('Claude: waiting')) return color.boldRed(line)
  if (t.startsWith('▸')) return color.boldYellow(line)
  if (t.startsWith('✓')) return color.green(line)
  if (line.startsWith('hece')) return color.bold(line)
  if (line.startsWith('guards:') || line.startsWith('Claude:')) return color.dim(line)
  return line
}

export function sessionsPanelLines(sessions: SessionRecord[]): string[] {
  if (sessions.length === 0) return ['Sessions', '', 'none yet']
  return [
    'Sessions',
    '',
    ...sessions.slice(-8).map((s) => `• ${s.source === 'startup' ? 'main' : s.source} ${s.sessionId.slice(0, 8)}`),
  ]
}
