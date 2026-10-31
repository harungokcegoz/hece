import readline from 'node:readline'
import { color } from '../panels/color.js'
import { wrapLine, fitLine } from '../panels/fit.js'

export interface Option { label: string; value: string | boolean; note?: string; disabled?: string; preview?: string[] }
export interface Key { name?: string; sequence?: string; ctrl?: boolean }
export type Step =
  | { kind: 'move'; cursor: number }
  | { kind: 'pick'; index: number }
  | { kind: 'back' }
  | { kind: 'quit' }
  | { kind: 'abort' }
  | { kind: 'none' }
export interface Io { keys: AsyncIterator<Key>; write(s: string): void; width(): number; close(): void }

const none: Step = { kind: 'none' }

function nextEnabled(cursor: number, options: Option[], dir: 1 | -1): Step {
  for (let i = cursor + dir; i >= 0 && i < options.length; i += dir) {
    if (!options[i].disabled) return { kind: 'move', cursor: i }
  }
  return none
}

export function onKey(cursor: number, options: Option[], key: Key): Step {
  if (key.ctrl && key.name === 'c') return { kind: 'abort' }
  switch (key.name) {
    case 'down': case 'j': return nextEnabled(cursor, options, 1)
    case 'up': case 'k': return nextEnabled(cursor, options, -1)
    case 'return': case 'enter': return options[cursor] && !options[cursor].disabled ? { kind: 'pick', index: cursor } : none
    case 'b': return { kind: 'back' }
    case 'escape': return { kind: 'quit' }
    case 'resize': return { kind: 'move', cursor }
  }
  const n = /^[1-9]$/.test(key.sequence ?? '') ? Number(key.sequence) - 1 : -1
  return n >= 0 && n < options.length && !options[n].disabled ? { kind: 'pick', index: n } : none
}

export function renderScreen(title: string, lines: string[], options: Option[], cursor: number, width: number): string[] {
  const out: string[] = [color.bold(fitLine(title, width)), '']
  for (const l of lines) out.push(...wrapLine(l, width))
  if (lines.length) out.push('')
  options.forEach((o, i) => {
    const on = i === cursor
    const text = `${on ? '›' : ' '} ${i + 1}. ${o.label}${o.note ? ` (${o.note})` : ''}${o.disabled ? ` — ${o.disabled}` : ''}`
    const rows = wrapLine(text, width, 5)
    for (const r of rows) out.push(o.disabled ? color.dim(r) : on ? color.cyan(r) : r)
    if (on && o.preview) for (const p of o.preview) for (const r of wrapLine(p, width)) out.push(color.dim(r))
  })
  out.push('', color.dim(fitLine('↑↓/jk move · Enter · b back · Esc quit', width)))
  return out
}

export type AskResult = { kind: 'pick'; value: string | boolean } | { kind: 'back' | 'quit' | 'abort' }

export async function ask(io: Io, title: string, lines: string[], options: Option[], initial: number): Promise<AskResult> {
  let cursor = initial
  const draw = () => io.write('\x1b[2J\x1b[H' + renderScreen(title, lines, options, cursor, io.width()).join('\r\n'))
  draw()
  for (;;) {
    const { value: key, done } = await io.keys.next()
    if (done) return { kind: 'quit' }
    const step = onKey(cursor, options, key)
    if (step.kind === 'pick') return { kind: 'pick', value: options[step.index].value }
    if (step.kind === 'back' || step.kind === 'quit' || step.kind === 'abort') return { kind: step.kind }
    if (step.kind === 'move') { cursor = step.cursor; draw() }
  }
}

export function terminalIo(): Io {
  const { stdin, stdout } = process
  readline.emitKeypressEvents(stdin)
  stdin.setRawMode?.(true)
  stdin.resume()
  stdout.write('\x1b[?25l')
  const queue: Key[] = []
  let wake: (() => void) | undefined
  const push = (k: Key) => { queue.push(k); wake?.() }
  const onKeypress = (_s: string | undefined, key: Key | undefined) => { if (key) push(key) }
  const onResize = () => push({ name: 'resize' })
  stdin.on('keypress', onKeypress)
  stdout.on('resize', onResize)
  let closed = false
  const keys: AsyncIterator<Key> = {
    async next() {
      while (!queue.length) {
        if (closed) return { value: undefined, done: true }
        await new Promise<void>((r) => { wake = r })
      }
      return { value: queue.shift()!, done: false }
    },
  }
  return {
    keys,
    write: (s) => void stdout.write(s),
    width: () => stdout.columns || 40,
    close() {
      if (closed) return
      closed = true
      stdin.off('keypress', onKeypress)
      stdout.off('resize', onResize)
      stdin.setRawMode?.(false)
      stdout.write('\x1b[?25h')
      stdin.pause()
      wake?.()
    },
  }
}
