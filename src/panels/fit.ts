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
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
  // Emoji presentation by default (Unicode Emoji_Presentation). The rest of these blocks
  // (✓ ✔ ★ ⌘ …) is text presentation and stays one column, as the panels draw them.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x1f7e0, 0x1f7eb],
]

// East Asian Ambiguous: one column in most terminals, two in a CJK locale. Whole arrow and
// geometric-shape blocks are listed (a little more than Unicode's Ambiguous set), because
// over-measuring only cuts a line early, while under-measuring wraps the pane.
const AMBIGUOUS: Array<[number, number]> = [
  [0x00a1, 0x00a1],
  [0x00a4, 0x00a4],
  [0x00a7, 0x00a8],
  [0x00b0, 0x00b4],
  [0x00b6, 0x00b7],
  [0x00d7, 0x00d7],
  [0x00f7, 0x00f7],
  [0x2010, 0x2016],
  [0x2018, 0x201d],
  [0x2020, 0x2022],
  [0x2026, 0x2027],
  [0x2190, 0x21ff],
  [0x2460, 0x24ff],
  [0x2500, 0x257f],
  [0x2580, 0x259f],
  [0x25a0, 0x25ff],
  [0x2605, 0x2606],
  [0x2660, 0x266f],
]

const inRanges = (cp: number, ranges: Array<[number, number]>) => ranges.some(([a, b]) => cp >= a && cp <= b)

// Ambiguous-width glyphs are doubled when the locale is Chinese, Japanese or Korean.
// Precedence follows POSIX: LC_ALL, then LC_CTYPE, then LANG.
export function isCjkLocale(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /^(zh|ja|ko)([_.@-]|$)/i.test(locale)
}

export function charWidth(cp: number, ambiguousWide = false): 0 | 1 | 2 {
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  if (ambiguousWide && inRanges(cp, AMBIGUOUS)) return 2
  return 1
}

// C0 controls become spaces; C1 controls (0x80-0x9F, including 8-bit CSI) are dropped.
const sanitise = (text: string): string => stripAnsi(text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\x80-\x9f]/g, '')

// A base character plus any zero-width characters that follow it, kept or dropped together.
// VS16 (U+FE0F) after a one-column base turns it into a two-column emoji.
function clusters(text: string, ambiguousWide: boolean): Array<{ text: string; width: number }> {
  const out: Array<{ text: string; width: number }> = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const w = charWidth(cp, ambiguousWide)
    if (w === 0 && out.length > 0) {
      const last = out[out.length - 1]
      last.text += ch
      if (cp === 0xfe0f) last.width = 2
    } else out.push({ text: ch, width: w })
  }
  return out
}

export function displayWidth(text: string): number {
  const ambiguousWide = isCjkLocale()
  let w = 0
  for (const c of clusters(text, ambiguousWide)) w += c.width
  return w
}

export function fitLine(text: string, width: number): string {
  const clean = sanitise(text)
  if (displayWidth(clean) <= width) return clean
  if (width <= 0) return ''
  const ambiguousWide = isCjkLocale()
  const ellipsis = charWidth(0x2026, ambiguousWide)
  if (width < ellipsis) return ''
  let used = 0
  let kept = ''
  for (const c of clusters(clean, ambiguousWide)) {
    if (used + c.width > width - ellipsis) break
    used += c.width
    kept += c.text
  }
  return kept + '…'
}

// Continuation rows start with `indent` spaces; breaks go at the last space past the indent, or mid-word if there is none.
export function wrapLine(text: string, width: number, indent = 0): string[] {
  if (width <= 0) return ['']
  const ambiguousWide = isCjkLocale()
  const pad = indent < width ? ' '.repeat(indent) : ''
  const join = (cs: Array<{ text: string }>) => cs.map((c) => c.text).join('')
  let cs = clusters(sanitise(text), ambiguousWide)
  const rows: string[] = []
  let prefix = ''
  let room = width
  let minBreak = indent
  for (;;) {
    let used = 0
    let cut = 0
    let space = -1
    for (; cut < cs.length && used + cs[cut].width <= room; cut++) {
      if (cs[cut].text === ' ' && used > minBreak) space = cut
      used += cs[cut].width
    }
    if (cut === cs.length) return [...rows, prefix + join(cs)]
    if (cs[cut].text === ' ') space = cut
    const end = space > 0 ? space : cut
    // a two-column character in a one-column row can never fit: drop it, as fitLine would
    if (end === 0) {
      cs = cs.slice(1)
      continue
    }
    rows.push(prefix + join(cs.slice(0, end)).trimEnd())
    cs = cs.slice(end)
    while (cs[0]?.text === ' ') cs = cs.slice(1)
    prefix = pad
    room = width - pad.length
    minBreak = 0
  }
}

export function fitLines(lines: string[], width: number, height: number, keep: 'top' | 'bottom'): string[] {
  const h = Math.max(0, height)
  const fitted = lines.map((l) => fitLine(l, width))
  if (fitted.length <= h) return fitted
  return keep === 'top' ? fitted.slice(0, h) : fitted.slice(fitted.length - h)
}
