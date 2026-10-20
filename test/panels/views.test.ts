import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { fitLine, fitLines } from '../../src/panels/fit.js'
import { stripAnsi } from '../../src/panels/color.js'
import { flowPanelLines, colorFlowLine, sessionsPanelLines } from '../../src/panels/views.js'

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

describe('flowPanelLines', () => {
  it('explains what to do when there is no flow yet', () => {
    expect(flowPanelLines(null, { guards: true, idle: null })).toEqual(['hece', '', 'No flow yet.', 'Ask Claude to build', 'something to start one.'])
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
    expect(stripAnsi(colorFlowLine('✓ Plan (2 slices)'))).toBe('✓ Plan (2 slices)')
  })
})

describe('sessionsPanelLines', () => {
  it('lists the most recent sessions', () => {
    expect(sessionsPanelLines([])).toEqual(['Sessions', '', 'none yet'])
    expect(sessionsPanelLines([{ sessionId: 'abcdef1234', source: 'startup', at: 1 }])).toEqual(['Sessions', '', '• main abcdef12'])
  })
})
