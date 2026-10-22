import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { fitLine, fitLines, displayWidth } from '../../src/panels/fit.js'
import { stripAnsi } from '../../src/panels/color.js'
import { flowPanelLines, colorFlowLine, sessionsPanelLines, fitFlowLines } from '../../src/panels/views.js'

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
