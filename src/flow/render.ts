import { batchRunning } from './flow.js'
import type { Prefs } from '../prefs/schema.js'
import { FlowState, PHASES, SliceStatus } from './types.js'

const STEPS = [
  ['discuss', 'Discussion'],
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['review', 'Review'],
  ['recap', 'Recap'],
] as const

const SLICE_MARK: Record<SliceStatus, string> = { approved: '✓', working: '▸', stopped: '■', todo: ' ' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function renderFlow(s: FlowState, opts: { guards: Prefs['guards'] }): string {
  const cur = PHASES.indexOf(s.phase)
  const mark = (id: string) => {
    const i = PHASES.indexOf(id as FlowState['phase'])
    return i < cur ? '✓' : i === cur ? '▸' : ' '
  }
  const lines = [`hece · ${s.phase}`]
  for (const [id, label] of STEPS) {
    let text: string = label
    if (id === 'discuss') text += ` (${plural(s.decisions.length, 'decision')})`
    if (id === 'plan' && s.plan) {
      text += ` (${plural(s.plan.slices.length, 'slice')})`
      if (!s.plan.approved) text += s.plan.changed ? ' — changed, waiting for approval' : ' — waiting for approval'
    }
    if (id === 'review' && s.review) text += ` (${s.review.important} important, ${s.review.minor} minor)`
    lines.push(`${mark(id)} ${text}`)
    if (id === 'build' && s.plan) {
      for (const sl of s.plan.slices) {
        const wait = sl.status === 'stopped' ? (batchRunning(s) ? '  ← done' : '  ← waiting for you') : ''
        lines.push(`  ${SLICE_MARK[sl.status]} ${sl.n}. ${sl.title}${wait}`)
      }
    }
  }
  lines.push(`guards: ${opts.guards.stops && opts.guards.files ? 'on' : opts.guards.stops || opts.guards.files ? 'partial' : 'off'}`)
  return lines.join('\n')
}
