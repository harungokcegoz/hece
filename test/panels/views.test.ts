import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { fitLine, fitLines, displayWidth, charWidth, isCjkLocale } from '../../src/panels/fit.js'
import { stripAnsi } from '../../src/panels/color.js'
import { flowPanelLines, colorFlowLine, sessionsPanelLines, fitFlowLines, paintFlowLines } from '../../src/panels/views.js'

// Ambiguous width depends on the locale, so every test here starts from a non-CJK one.
const KEYS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('fit', () => {
  it('cuts long lines with an ellipsis and never splits a character', () => {
    expect(fitLine('abcdef', 4)).toBe('abc…')
    expect(fitLine('abc', 4)).toBe('abc')
    expect(fitLine('✓ ◆ ▸ ■ ←', 5)).toBe('✓ ◆ …')
  })
  it('keeps the top or the bottom when there are too many lines', () => {
    expect(fitLines(['1', '2', '3'], 10, 2, 'top')).toEqual(['1', '2'])
    expect(fitLines(['1', '2', '3'], 10, 2, 'bottom')).toEqual(['2', '3'])
  })
})

describe('display width', () => {
  it('measures terminal columns, not code points', () => {
    expect(displayWidth('認証')).toBe(4)
    expect(displayWidth('🚀')).toBe(2)
    expect(displayWidth('e\u0301')).toBe(1)
  })
  it('fits wide text within the pane and keeps clusters whole', () => {
    const cjk = fitLine('  ■ 1. 認証フローを実装する  ← waiting for you', 20)
    expect(displayWidth(cjk)).toBeLessThanOrEqual(20)
    expect(cjk.endsWith('…')).toBe(true)
    expect(displayWidth(fitLine('  ▸ 2. ' + '🚀'.repeat(12), 20))).toBeLessThanOrEqual(20)
    expect(fitLine('e\u0301e\u0301e\u0301e\u0301', 3)).toBe('e\u0301e\u0301…')
    expect(fitLine('éééé', 3)).toBe('éé…')
  })
  it('sanitises escapes and control characters', () => {
    expect(fitLine('a\nb\x1b[31mc', 10)).toBe('a bc')
  })
  it('handles degenerate sizes', () => {
    expect(fitLines(['a', 'b', 'c'], 10, -1, 'top')).toEqual([])
    expect(fitLine('abc', 0)).toBe('')
    expect(fitLine('abc', 1)).toBe('…')
  })
})

describe('flowPanelLines', () => {
  it('explains what to do when there is no flow yet', () => {
    expect(flowPanelLines(null, { guards: true, idle: null })).toEqual(['No flow yet.', 'Ask Claude to build', 'something to start one.'])
    expect(flowPanelLines(null, { guards: true, idle: null, home: true })).toEqual([
      'No flow yet.',
      'Ask Claude to build',
      'something to start one.',
      '',
      "Tip: you're in your home folder.",
    ])
  })
  it('shows the flow, whether Claude is waiting, and the guards', () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
    s = finishSlice(startSlice(approve(s, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
    const lines = flowPanelLines(s, { guards: true, idle: true })
    expect(lines).toContain('  ■ 1. A  ← waiting for you')
    expect(lines.slice(-2)).toEqual(['Claude: waiting for you', 'guards: on'])
  })
  it('colours waiting lines red and the current step yellow', () => {
    expect(colorFlowLine('  ■ 1. A  ← waiting for you')).toContain('\x1b[1;31m')
    expect(colorFlowLine('▸ Build')).toContain('\x1b[1;33m')
    // a plan waiting for approval is as urgent as a waiting slice
    for (const l of ['▸ Plan (2 slices) — waiting for approval', '▸ Plan (2 slices) — changed, waiting for approval', '▸ Plan (2 slices) — chan…']) {
      expect(colorFlowLine(l)).toContain('\x1b[1;31m')
    }
    expect(stripAnsi(colorFlowLine('✓ Plan (2 slices)'))).toBe('✓ Plan (2 slices)')
  })
  it('keeps a cut status line red', () => {
    expect(stripAnsi(colorFlowLine('Claude: wait…'))).toBe('Claude: wait…')
    expect(colorFlowLine('Claude: wait…')).toContain('\x1b[1;31m')
  })
  it('keeps the waiting line and the status in a short pane', () => {
    const slices = Array.from({ length: 8 }, (_, i) => ({ title: String.fromCharCode(65 + i), files: [], kind: 'routine' as const }))
    let s = setPlan(emptyFlow(), slices, { guards: true }, 1)
    s = finishSlice(startSlice(approve(s, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
    const lines = flowPanelLines(s, { guards: true, idle: true })
    const out = fitFlowLines(lines, 40, 6)
    expect(out.length).toBeLessThanOrEqual(6)
    expect(out).toContain('  ■ 1. A  ← waiting for you')
    expect(out).toContain('Claude: waiting for you')
    expect(out).toContain('guards: on')
    expect(fitFlowLines(lines, 8, 6)).toContain('  ■ 1. …')
    expect(fitFlowLines(lines, 40, 100)).toHaveLength(lines.length)
  })
})

describe('sessionsPanelLines', () => {
  it('lists the most recent sessions', () => {
    expect(sessionsPanelLines([])).toEqual(['none yet'])
    expect(sessionsPanelLines([{ sessionId: 'abcdef1234', source: 'startup', at: 1 }])).toEqual(['• main abcdef12'])
  })
})

describe('display width gaps', () => {
  it('counts the Symbols and Pictographs Extended-A range (🪄 🫠) as 2 columns', () => {
    expect(displayWidth('🪄')).toBe(2)
    expect(displayWidth('🫠')).toBe(2)
    expect(charWidth(0x1fa70)).toBe(2)
    expect(charWidth(0x1faff)).toBe(2)
  })
  it('counts emoji-presentation symbols in 0x2600-27BF as 2 columns (✅ ⭐ ⚡ ❌)', () => {
    for (const ch of ['✅', '⭐', '⚡', '❌', '✨']) expect(displayWidth(ch)).toBe(2)
  })
  it('keeps text-presentation symbols the UI relies on at 1 column', () => {
    for (const ch of ['✓', '✔', '✗', '★', '☐']) expect(displayWidth(ch)).toBe(1)
  })
  it('counts the 0x231A-23FF emoji (⌚ ⏳ ⏩) as 2 columns', () => {
    for (const ch of ['⌚', '⌛', '⏩', '⏳']) expect(displayWidth(ch)).toBe(2)
    expect(displayWidth('⌘')).toBe(1)
  })
  it('counts a VS16 emoji presentation sequence (❤️) as 2 columns', () => {
    expect(displayWidth('❤\ufe0f')).toBe(2)
    expect(displayWidth('❤')).toBe(1)
    expect(displayWidth('☺\ufe0f')).toBe(2)
  })
  it('never lets a line with these emoji overflow the pane', () => {
    for (const text of ['🪄🫠✅⭐⌚❤️'.repeat(6), 'ok ❤️ ❤️ ❤️ ❤️ ❤️ ❤️ ❤️']) {
      for (const w of [3, 4, 7, 10]) expect(displayWidth(fitLine(text, w))).toBeLessThanOrEqual(w)
    }
    expect(fitLine('❤️❤️❤️', 5)).toBe('❤️❤️…')
  })
  it('strips C1 controls (0x80-0x9F)', () => {
    expect(fitLine('a\x9bb\x85c\x80d\x9f', 10)).toBe('abcd')
  })

  describe('ambiguous width', () => {
    it('is narrow in a non-CJK locale', () => {
      process.env.LANG = 'en_US.UTF-8'
      expect(isCjkLocale()).toBe(false)
      for (const ch of ['■', '▸', '←', '◆', '·', '…']) expect(displayWidth(ch)).toBe(1)
    })
    it('is wide in a CJK locale (LANG, LC_CTYPE, LC_ALL precedence)', () => {
      process.env.LANG = 'ja_JP.UTF-8'
      expect(isCjkLocale()).toBe(true)
      for (const ch of ['■', '▸', '←', '◆']) expect(displayWidth(ch)).toBe(2)
      process.env.LC_CTYPE = 'en_US.UTF-8'
      expect(isCjkLocale()).toBe(false)
      process.env.LC_ALL = 'zh_CN.UTF-8'
      expect(isCjkLocale()).toBe(true)
      process.env.LC_ALL = 'ko_KR.eucKR'
      expect(isCjkLocale()).toBe(true)
    })
    it('leaves the ✓ glyph and plain ASCII narrow in a CJK locale', () => {
      process.env.LANG = 'zh_CN.UTF-8'
      expect(displayWidth('✓ab')).toBe(3)
    })
    it('fits lines within the pane in a CJK locale, including the ellipsis', () => {
      process.env.LANG = 'ja_JP.UTF-8'
      for (const w of [2, 3, 5, 9, 20]) {
        expect(displayWidth(fitLine('  ■ 1. ▸▸▸ ← ◆◆◆◆ waiting for you ■■■', w))).toBeLessThanOrEqual(w)
      }
      expect(fitLine('abcdef', 1)).toBe('')
    })
  })
})

describe('Flow on narrow panes', () => {
  const RED = '\x1b[1;31m'
  const waitingFlow = () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
    s = finishSlice(startSlice(approve(s, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
    return flowPanelLines(s, { guards: true, idle: true })
  }
  const workingFlow = () => {
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    return flowPanelLines(s, { guards: true, idle: false })
  }

  for (let w = 8; w <= 14; w++) {
    it(`paints the waiting status and waiting slice red at width ${w}`, () => {
      const out = paintFlowLines(waitingFlow(), w, 100)
      const status = out.find((l) => stripAnsi(l).startsWith('Claude:'))
      const slice = out.find((l) => stripAnsi(l).includes('■'))
      expect(status, 'status line').toBeDefined()
      expect(status!.startsWith(RED)).toBe(true)
      expect(slice, 'waiting slice').toBeDefined()
      expect(slice!.startsWith(RED)).toBe(true)
      for (const l of out) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(w)
    })
    it(`does not paint a working status red at width ${w}`, () => {
      const out = paintFlowLines(workingFlow(), w, 100)
      const status = out.find((l) => stripAnsi(l).startsWith('Claude:'))
      expect(status).toBeDefined()
      expect(status!).not.toContain(RED)
    })
  }

  it('paints a cut plan-waiting line red', () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }], { guards: true }, 1)
    const out = paintFlowLines(flowPanelLines(s, { guards: true, idle: null }), 10, 100)
    const plan = out.find((l) => stripAnsi(l).startsWith('▸ Plan'))
    expect(plan).toBeDefined()
    expect(plan!.startsWith(RED)).toBe(true)
  })

  it('keeps the working slice line over the phase line in a short pane', () => {
    const lines = workingFlow()
    for (const h of [3, 4]) {
      const out = fitFlowLines(lines, 40, h)
      expect(out.length).toBeLessThanOrEqual(h)
      expect(out).toContain('  ▸ 1. Token model')
      expect(out).not.toContain('▸ Build')
      expect(out).toContain('Claude: working…')
      expect(out).toContain('guards: on')
    }
    // with room to spare the phase line comes back
    expect(fitFlowLines(lines, 40, 100)).toContain('▸ Build')
  })
  it('still puts a waiting slice before a working one', () => {
    const lines = ['hece · build', '▸ Build', '  ▸ 1. A', '  ■ 2. B  ← waiting for you', '', 'Claude: waiting for you', 'guards: on']
    expect(fitFlowLines(lines, 40, 3)).toEqual(['  ■ 2. B  ← waiting for you', 'Claude: waiting for you', 'guards: on'])
  })
  it('paintFlowLines paints a working slice yellow after fitting', () => {
    const out = paintFlowLines(workingFlow(), 10, 100)
    expect(out.find((l) => stripAnsi(l).startsWith('  ▸ 1.'))).toContain('\x1b[1;33m')
  })
})
