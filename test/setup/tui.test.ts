import { describe, it, expect } from 'vitest'
import { onKey, renderScreen, ask, type Option, type Io, type Key } from '../../src/setup/tui.js'
import { stripAnsi } from '../../src/panels/color.js'
import { displayWidth } from '../../src/panels/fit.js'

const opts: Option[] = [{ label: 'a', value: 'a' }, { label: 'b', value: 'b', disabled: 'not yet' }, { label: 'c', value: 'c' }]

describe('tui', () => {
  it('down skips disabled, stops at the end', () => {
    expect(onKey(0, opts, { name: 'down' })).toEqual({ kind: 'move', cursor: 2 })
    expect(onKey(2, opts, { name: 'down' })).toEqual({ kind: 'none' })
    expect(onKey(2, opts, { name: 'k' })).toEqual({ kind: 'move', cursor: 0 })
  })
  it('number keys pick directly, not disabled ones', () => {
    expect(onKey(0, opts, { name: '3', sequence: '3' })).toEqual({ kind: 'pick', index: 2 })
    expect(onKey(0, opts, { name: '2', sequence: '2' })).toEqual({ kind: 'none' })
  })
  it('enter, b, escape, ctrl-c, resize', () => {
    expect(onKey(2, opts, { name: 'return' })).toEqual({ kind: 'pick', index: 2 })
    expect(onKey(0, opts, { name: 'b' })).toEqual({ kind: 'back' })
    expect(onKey(0, opts, { name: 'escape' })).toEqual({ kind: 'quit' })
    expect(onKey(0, opts, { name: 'c', ctrl: true })).toEqual({ kind: 'abort' })
    expect(onKey(2, opts, { name: 'resize' })).toEqual({ kind: 'move', cursor: 2 })
  })
  it('renders numbered options, marks the cursor, shows its preview and the key hint', () => {
    const out = renderScreen('Preset', ['pick one'], [{ ...opts[0], preview: ['example'] }, opts[2]], 0, 40).map(stripAnsi)
    expect(out).toEqual(expect.arrayContaining(['› 1. a', '  2. c', 'example']))
    expect(out.at(-1)).toMatch(/↑↓.*Enter.*b back.*Esc/)
  })
  it('fits narrow and CJK widths', () => {
    for (const w of [20, 39]) for (const l of renderScreen('設定 settings', ['長い説明文がここに入ります long text here'], opts, 0, w)) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(w)
  })
  it('ask returns the picked value using a fake io', async () => {
    const seq: Key[] = [{ name: 'down' }, { name: 'return' }]
    const writes: string[] = []
    const io: Io = {
      keys: (async function* () { yield* seq })(),
      write: (s) => writes.push(s),
      width: () => 40,
      close: () => {},
    }
    expect(await ask(io, 'T', [], opts, 0)).toEqual({ kind: 'pick', value: 'c' })
    expect(writes.length).toBe(2)
    expect(writes.every((w) => w.startsWith('\x1b[2J\x1b[H'))).toBe(true)
  })
})
