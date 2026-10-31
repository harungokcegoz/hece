import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { onKey, renderScreen, ask, terminalIo, type Option, type Io, type Key } from '../../src/setup/tui.js'
import { stripAnsi } from '../../src/panels/color.js'
import { color } from '../../src/panels/color.js'
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
    expect(out.at(-1)).toMatch(/↑↓\/jk.*Enter.*b back.*Esc/)
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
  it('keeps every key hint visible at 24 columns', () => {
    const out = renderScreen('T', [], opts, 0, 24).map(stripAnsi)
    const tail = out.slice(out.findIndex((l) => l.includes('jk'))).join(' ')
    for (const w of ['↑↓/jk', 'move', 'Enter', 'back', 'Esc', 'quit']) expect(tail).toContain(w)
    for (const l of out) expect(displayWidth(l)).toBeLessThanOrEqual(24)
  })
  it('dims disabled options and says why', () => {
    const raw = renderScreen('T', [], [opts[0], { ...opts[1], disabled: 'not supported yet' }], 0, 40)
    expect(raw).toContain(color.dim('  2. b — not supported yet'))
  })
  it('the cursor marker stays on the first row of a wrapped option', () => {
    const long: Option[] = [{ label: 'a very long label that has to wrap around', value: 'x' }]
    const out = renderScreen('T', [], long, 0, 20).map(stripAnsi)
    const i = out.findIndex((l) => l.startsWith('› 1. '))
    expect(i).toBeGreaterThan(-1)
    expect(out[i + 1].startsWith('     ')).toBe(true)
    for (const l of out) expect(displayWidth(l)).toBeLessThanOrEqual(20)
  })
})

const fakeIo = (keys: Key[]): Io => ({ keys: (async function* () { yield* keys })(), write: () => {}, width: () => 40, close: () => {} })

describe('ask results', () => {
  it('returns back, quit and abort', async () => {
    expect(await ask(fakeIo([{ name: 'b' }]), 'T', [], opts, 0)).toEqual({ kind: 'back' })
    expect(await ask(fakeIo([{ name: 'escape' }]), 'T', [], opts, 0)).toEqual({ kind: 'quit' })
    expect(await ask(fakeIo([{ name: 'c', ctrl: true }]), 'T', [], opts, 0)).toEqual({ kind: 'abort' })
  })
  it('aborts when the key stream ends', async () => {
    expect(await ask(fakeIo([]), 'T', [], opts, 0)).toEqual({ kind: 'abort' })
  })
  it('starts on the first enabled option when initial is disabled', async () => {
    expect(await ask(fakeIo([{ name: 'return' }]), 'T', [], opts, 1)).toEqual({ kind: 'pick', value: 'a' })
  })
})

describe('terminalIo', () => {
  function streams(isRaw: boolean) {
    const stdin = Object.assign(new EventEmitter(), { isRaw, setRawMode(v: boolean) { this.isRaw = v }, resume() {}, pause() {} })
    const out: string[] = []
    const stdout = Object.assign(new EventEmitter(), { columns: 30, write: (s: string) => (out.push(s), true) })
    return { stdin, stdout, out, io: terminalIo(stdin as never, stdout as never) }
  }
  it('ends the key stream when stdin ends or closes, after queued keys', async () => {
    for (const ev of ['end', 'close']) {
      const t = streams(false)
      t.stdin.emit('keypress', 'x', { name: 'x' })
      t.stdin.emit(ev)
      expect(await t.io.keys.next()).toEqual({ value: { name: 'x' }, done: false })
      expect((await t.io.keys.next()).done).toBe(true)
      t.io.close()
    }
  })
  it('coalesces resize events', async () => {
    const t = streams(false)
    for (let i = 0; i < 3; i++) t.stdout.emit('resize')
    t.stdin.emit('end')
    expect((await t.io.keys.next()).value).toEqual({ name: 'resize' })
    expect((await t.io.keys.next()).done).toBe(true)
    t.io.close()
  })
  it('close restores the previous raw mode, shows the cursor and drops the exit hook', () => {
    const before = process.listenerCount('exit')
    for (const raw of [true, false]) {
      const t = streams(raw)
      expect(process.listenerCount('exit')).toBe(before + 1)
      t.io.close()
      expect(t.stdin.isRaw).toBe(raw)
      expect(t.out).toContain('\x1b[?25h')
      expect(process.listenerCount('exit')).toBe(before)
    }
  })
  it('the exit hook shows the cursor if close was never called', () => {
    const before = new Set(process.listeners('exit'))
    const t = streams(false)
    const hook = process.listeners('exit').find((l) => !before.has(l))!
    t.out.length = 0
    hook(0)
    expect(t.out).toContain('\x1b[?25h')
    t.io.close()
  })
})
