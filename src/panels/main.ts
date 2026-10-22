import fs from 'node:fs'
import { resolveRoot, statePaths, homeDir, isHomeRoot } from '../state/paths.js'
import { readJson, HeceEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { loadPrefs } from '../prefs/load.js'
import { SessionRecord } from '../hooks/handle.js'
import { buildActivity } from '../activity/view.js'
import { fitLine, fitLines, displayWidth } from './fit.js'
import { color } from './color.js'
import { flowPanelLines, paintFlowLines, sessionsPanelLines, isFlowState, isSessionList, isAgentState } from './views.js'

export type PanelWidget = 'flow' | 'activity' | 'sessions'
const WIDGETS: readonly string[] = ['flow', 'activity', 'sessions']

// Reads a state file that must pass `valid`. A missing file is `undefined`; one that is
// invalid JSON or the wrong shape is `'unreadable'`, so the panel can say so plainly.
function readChecked<T>(file: string, valid: (v: unknown) => v is T): T | undefined | 'unreadable' {
  if (!fs.existsSync(file)) return undefined
  try {
    const v = readJson<unknown>(file, undefined)
    return valid(v) ? v : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

const TAIL_BYTES = 256 * 1024
const RESTORE = '\x1b[?25h\x1b[?1049l'

// Only the end of a long log matters to the activity view. Reads the last
// TAIL_BYTES, drops the first line unless the window starts right after a newline, and skips unparsable lines.
export function readEventsTail(file: string, maxBytes = TAIL_BYTES): HeceEvent[] {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    // one extra byte before the window tells whether it starts on a line boundary
    const from = Math.max(0, start - 1)
    const buf = Buffer.alloc(size - from)
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got)
      if (n === 0) break
      got += n
    }
    const lead = start - from
    let text = buf.subarray(lead, got).toString('utf8')
    if (start > 0 && buf[0] !== 0x0a) {
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
  const { width, height } = size
  const clamp = (lines: string[]) => lines.slice(0, Math.max(0, height))
  const warn = (name: string) => {
    const head = `⚠ .hece/state/${name} is unreadable`
    // sessions.json makes this 41 columns: break before "is unreadable" rather than truncate it
    const warning = displayWidth(head) > width ? [`⚠ .hece/state/${name}`, 'is unreadable', 'Fix or delete it to continue.'] : [head, 'Fix or delete it to continue.']
    return clamp(fitLines(warning, width, warning.length, 'top').map((l) => color.red(l)))
  }

  if (widget === 'sessions') {
    const sessions = readChecked(paths.sessions, isSessionList)
    if (sessions === 'unreadable') return warn('sessions.json')
    return clamp(fitLines(sessionsPanelLines(sessions ?? []), width, height, 'top'))
  }

  const flowRead = readChecked(paths.flow, isFlowState)
  if (flowRead === 'unreadable') return warn('flow.json')
  const flow: FlowState | null = flowRead ?? null

  if (widget === 'flow') {
    const { prefs } = loadPrefs(env, root)
    const agent = flow ? readChecked(paths.agent, isAgentState) : undefined
    if (agent === 'unreadable') return warn('agent.json')
    const lines = flowPanelLines(flow, {
      guards: prefs.guards,
      idle: flow && agent ? agent.idle : null,
      home: !flow && isHomeRoot(root, homeDir(env)),
    })
    return clamp(paintFlowLines(lines, width, height))
  }

  const view = buildActivity(recentEvents(paths.events).slice(-500), { root, flow: flow ?? emptyFlow() }, Math.max(1, height))
  if (view.length === 0) {
    return clamp(fitLines(["Nothing yet. Claude's steps", 'show up here in plain words.'], width, height, 'top').map((l) => color.dim(l)))
  }
  const paint = { header: color.boldCyan, note: color.yellow, action: (s: string) => s, alert: color.red, milestone: color.green }
  return clamp(view.map((v) => paint[v.kind](fitLine(v.text, width))))
}

// Each row is erased before it is drawn, never after: a clear-to-end sent once the row is
// written would wipe the last column on terminals that hold a pending wrap there. The same goes
// for the erase below the frame: it starts on a fresh row, and is skipped when the frame fills the pane.
export function frameText(lines: string[], rows: number): string {
  const body = lines.map((l) => '\x1b[2K' + l).join('\r\n')
  return lines.length < rows ? body + '\r\n\x1b[J' : body
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
    const text = frameText(frame(), size().height)
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
