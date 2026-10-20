import { HeceEvent } from '../state/store.js'
import { ActivityLine, DescribeContext, LineKind, describeEvent } from './describe.js'

export interface ViewLine {
  kind: LineKind | 'header'
  text: string
}

interface Tagged extends ViewLine {
  slice: number | null
}

const MARK: Record<LineKind, string> = { note: '', action: '· ', alert: '⚠ ', milestone: '◆ ' }

export function buildActivity(events: HeceEvent[], ctx: DescribeContext, max: number): ViewLine[] {
  const lines: (ActivityLine & { count: number })[] = []
  for (const ev of events) {
    const l = describeEvent(ev, ctx)
    if (!l) continue
    const prev = lines[lines.length - 1]
    if (prev && prev.kind === 'action' && l.kind === 'action' && prev.text === l.text && prev.slice === l.slice) prev.count++
    else lines.push({ ...l, count: 1 })
  }

  const header = (n: number): Tagged => {
    const title = ctx.flow.plan?.slices.find((s) => s.n === n)?.title ?? ''
    return { kind: 'header', text: `▸ Slice ${n}${title ? ` · ${title}` : ''}`, slice: n }
  }

  const out: Tagged[] = []
  let group: number | null = null
  for (const l of lines) {
    if (l.slice !== null && l.slice !== group) out.push(header(l.slice))
    group = l.slice
    const indent = l.slice === null ? '' : '  '
    const count = l.count > 1 ? ` (×${l.count})` : ''
    out.push({ kind: l.kind, text: `${indent}${MARK[l.kind]}${l.text}${count}`, slice: l.slice })
  }

  if (out.length <= max) return out.map(({ kind, text }) => ({ kind, text }))
  let kept = out.slice(out.length - max)
  const first = kept[0]
  if (first && first.kind !== 'header' && first.slice !== null) kept = [header(first.slice), ...out.slice(out.length - max + 1)]
  return kept.map(({ kind, text }) => ({ kind, text }))
}
