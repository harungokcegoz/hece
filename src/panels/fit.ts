import { stripAnsi } from './color.js'

const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0x200d, 0x200d],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
]

const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const inRanges = (cp: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => cp >= a && cp <= b)

export function charWidth(cp: number): 0 | 1 | 2 {
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

export function displayWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0)!)
  return w
}

const sanitise = (text: string): string => stripAnsi(text).replace(/[\x00-\x1f\x7f]/g, ' ')

// A base character plus any zero-width characters that follow it, kept or dropped together.
function clusters(text: string): Array<{ text: string; width: number }> {
  const out: Array<{ text: string; width: number }> = []
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!)
    if (w === 0 && out.length > 0) out[out.length - 1].text += ch
    else out.push({ text: ch, width: w })
  }
  return out
}

export function fitLine(text: string, width: number): string {
  const clean = sanitise(text)
  if (displayWidth(clean) <= width) return clean
  if (width <= 0) return ''
  if (width === 1) return '…'
  let used = 0
  let kept = ''
  for (const c of clusters(clean)) {
    if (used + c.width > width - 1) break
    used += c.width
    kept += c.text
  }
  return kept + '…'
}

export function fitLines(lines: string[], width: number, height: number, keep: 'top' | 'bottom'): string[] {
  const h = Math.max(0, height)
  const fitted = lines.map((l) => fitLine(l, width))
  if (fitted.length <= h) return fitted
  return keep === 'top' ? fitted.slice(0, h) : fitted.slice(fitted.length - h)
}
