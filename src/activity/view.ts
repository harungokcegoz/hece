import { HeceEvent } from '../state/store.js'
import { ActivityLine, DescribeContext, LineKind, describeEvent } from './describe.js'
import { displayWidth, wrapLine } from '../panels/fit.js'

export interface ViewLine {
  kind: LineKind | 'header'
  text: string
}

interface Tagged extends ViewLine {
  slice: number | null
}

const MARK: Record<LineKind, string> = { note: '', action: '· ', alert: '⚠ ', milestone: '◆ ' }

// `max` counts rows: with a finite `width`, a long line wraps and takes several.
export function buildActivity(events: HeceEvent[], ctx: DescribeContext, max: number, width = Infinity): ViewLine[] {
  const lines: (ActivityLine & { count: number })[] = []
  for (const ev of events) {
    const l = describeEvent(ev, ctx)
    if (!l) continue
    const prev = lines[lines.length - 1]
    if (prev && prev.kind === 'action' && l.kind === 'action' && prev.text === l.text && prev.slice === l.slice) prev.count++
    else lines.push({ ...l, count: 1 })
  }

  // Only the newest note is current intent; older ones are history.
  const newestNote = lines.map((l) => l.kind).lastIndexOf('note')

  const header = (n: number): Tagged[] => {
    const title = ctx.flow.plan?.slices.find((s) => s.n === n)?.title ?? ''
    return rows('header', `▸ Slice ${n}${title ? ` · ${title}` : ''}`, 2, n)
  }
  function rows(kind: Tagged['kind'], text: string, indent: number, slice: number | null): Tagged[] {
    const texts = Number.isFinite(width) ? wrapLine(text, width, indent) : [text]
    return texts.map((t) => ({ kind, text: t, slice }))
  }

  const out: Tagged[] = []
  let group: number | null = null
  for (const [i, l] of lines.entries()) {
    if (l.slice !== null && l.slice !== group) out.push(...header(l.slice))
    group = l.slice
    const lead = `${l.slice === null ? '' : '  '}${MARK[l.kind]}`
    const count = l.count > 1 ? ` (×${l.count})` : ''
    out.push(...rows(l.kind, `${lead}${l.kind === 'note' ? (i === newestNote ? 'Now: ' : 'Claude: ') : ''}${l.text}${count}`, displayWidth(lead), l.slice))
  }

  const plain = (ts: Tagged[]): ViewLine[] => ts.map(({ kind, text }) => ({ kind, text }))
  if (out.length <= max) return plain(out)
  let start = out.length - max
  const first = out[start]
  // the oldest rows drop first; a cut slice group gets its header back on top, unless that would hide the newest row
  if (first.slice !== null && !(first.kind === 'header' && out[start - 1]?.slice !== first.slice)) {
    const head = header(first.slice)
    if (head.length < max) {
      start = out.length - (max - head.length)
      while (start < out.length - 1 && out[start].kind === 'header') start++
      return plain([...head, ...out.slice(start)])
    }
  }
  return plain(out.slice(start))
}
