import fs from 'node:fs'
import { resolveRoot, statePaths } from '../state/paths.js'
import { readJson, HeceEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { loadPrefs } from '../prefs/load.js'
import { SessionRecord } from '../hooks/handle.js'
import { buildActivity } from '../activity/view.js'
import { fitLine, fitLines } from './fit.js'
import { color } from './color.js'
import { flowPanelLines, fitFlowLines, colorFlowLine, sessionsPanelLines } from './views.js'

export type PanelWidget = 'flow' | 'activity' | 'sessions'
const WIDGETS: readonly string[] = ['flow', 'activity', 'sessions']

function safeJson<T>(file: string): T | null {
  try {
    return readJson<T | null>(file, null)
  } catch {
    return null
  }
}

const TAIL_BYTES = 256 * 1024
const RESTORE = '\x1b[?25h\x1b[?1049l'

// Only the end of a long log matters to the activity view. Reads the last
// TAIL_BYTES, drops a partial first line, and skips unparsable lines.
export function readEventsTail(file: string, maxBytes = TAIL_BYTES): HeceEvent[] {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const out: HeceEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (ev && typeof ev.event === 'string') out.push(ev)
      } catch {
        // truncated or garbled line: skip it
      }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// Re-read the log only when its size or mtime changed.
let eventsCache: { file: string; size: number; mtimeMs: number; events: HeceEvent[] } | null = null
function recentEvents(file: string): HeceEvent[] {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    eventsCache = null
    return []
  }
  if (eventsCache && eventsCache.file === file && eventsCache.size === st.size && eventsCache.mtimeMs === st.mtimeMs) {
    return eventsCache.events
  }
  const events = readEventsTail(file)
  eventsCache = { file, size: st.size, mtimeMs: st.mtimeMs, events }
  return events
}

// Colour is applied after fitting: fitLine strips ANSI, so painting first would lose it.
export function panelFrame(
  widget: PanelWidget,
  root: string,
  env: NodeJS.ProcessEnv,
  size: { width: number; height: number },
): string[] {
  const paths = statePaths(root)
  let flow: FlowState | null = null
  let problem = ''
  if (fs.existsSync(paths.flow)) {
    try {
      flow = readJson<FlowState>(paths.flow, emptyFlow())
    } catch {
      problem = 'unreadable'
    }
  }
  const { width, height } = size
  const warning = ['⚠ .hece/state/flow.json is unreadable', 'Fix or delete it to continue.']
  const clamp = (lines: string[]) => lines.slice(0, Math.max(0, height))

  if (problem && widget !== 'sessions') {
    const head = widget === 'activity' ? [color.bold(fitLine('Activity', width)), ''] : []
    return clamp([...head, ...fitLines(warning, width, warning.length, 'top').map((l) => color.red(l))])
  }

  if (widget === 'flow') {
    const { prefs } = loadPrefs(env, root)
    const agent = safeJson<{ idle?: boolean }>(paths.agent)
    const lines = flowPanelLines(flow, { guards: prefs.guards, idle: flow && agent ? Boolean(agent.idle) : null })
    return clamp(fitFlowLines(lines, width, height).map(colorFlowLine))
  }

  if (widget === 'sessions') {
    const lines = sessionsPanelLines(safeJson<SessionRecord[]>(paths.sessions) ?? [])
    return clamp(fitLines(lines, width, height, 'top').map((l, i) => (i === 0 ? color.bold(l) : l)))
  }

  const view = buildActivity(recentEvents(paths.events).slice(-500), { root, flow: flow ?? emptyFlow() }, Math.max(1, height - 2))
  const head = [color.bold(fitLine('Activity', width)), '']
  if (view.length === 0) {
    return clamp([
      ...head,
      ...fitLines(["Nothing yet. Claude's steps", 'show up here in plain words.'], width, height - 2, 'top').map((l) => color.dim(l)),
    ])
  }
  const paint = { header: color.boldCyan, note: color.yellow, action: (s: string) => s, alert: color.red, milestone: color.green }
  return clamp([...head, ...view.map((v) => paint[v.kind](fitLine(v.text, width)))])
}

export async function runPanel(argv: string[]): Promise<void> {
  const widget = argv[0]
  if (!widget || !WIDGETS.includes(widget)) {
    process.stderr.write('usage: hece panel <flow|activity|sessions> [--once]\n')
    process.exitCode = 1
    return
  }
  const root = resolveRoot(process.env)
  const size = () => ({
    width: process.stdout.columns || Number(process.env.HECE_PANEL_WIDTH) || 40,
    height: process.stdout.rows || Number(process.env.HECE_PANEL_HEIGHT) || 24,
  })
  const frame = (): string[] => {
    try {
      return panelFrame(widget as PanelWidget, root, process.env, size())
    } catch (err) {
      return [`⚠ ${(err as Error).message}`]
    }
  }

  if (argv.includes('--once')) {
    process.stdout.write(frame().join('\n') + '\n')
    return
  }

  const out = process.stdout
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let last = ''
  let timer: NodeJS.Timeout | undefined
  let beat: NodeJS.Timeout | undefined
  let restored = false
  let stopped = false
  let finish: () => void = () => {}

  // Leave the alternate screen and show the cursor, once, even if the output is already gone.
  const restoreOnce = () => {
    if (restored) return
    restored = true
    try {
      if (out.writable && !out.destroyed) out.write(RESTORE)
    } catch {
      // nothing left to restore on
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearInterval(beat)
    restoreOnce()
    for (const sig of signals) process.off(sig, stop)
    finish()
  }
  const send = (text: string) => {
    if (stopped) return
    if (!out.writable || out.destroyed) return stop()
    try {
      out.write(text)
    } catch {
      stop()
    }
  }

  out.on('error', stop)
  out.on('close', stop)
  process.once('exit', restoreOnce) // an uncaught exception still restores the terminal
  for (const sig of signals) process.once(sig, stop)

  send('\x1b[?1049h\x1b[?25l') // alternate screen, hide cursor
  const draw = (force = false) => {
    const text = frame().map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J'
    if (force || text !== last) {
      send('\x1b[H' + text) // overwrite in place: no clear, no flicker
      last = text
    }
  }
  draw(true)
  timer = setInterval(() => draw(), 300)
  // Nothing is written while the frame is unchanged, so poke the output now and then:
  // a closed pane or pipe shows up as a failed write and ends the loop.
  beat = setInterval(() => send('\x1b[0m'), 2000)
  out.on('resize', () => draw(true))
  await new Promise<void>((resolve) => {
    finish = resolve
    if (stopped) resolve()
  })
}
