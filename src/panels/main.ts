import fs from 'node:fs'
import { resolveRoot, statePaths } from '../state/paths.js'
import { readJson, readEvents } from '../state/store.js'
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
    } catch (err) {
      problem = `⚠ ${(err as Error).message}`
    }
  }
  const { width, height } = size

  if (widget === 'flow') {
    const { prefs } = loadPrefs(env, root)
    const agent = safeJson<{ idle?: boolean }>(paths.agent)
    const lines = flowPanelLines(flow, { guards: prefs.guards, idle: flow && agent ? Boolean(agent.idle) : null })
    if (problem) lines.unshift(problem, '')
    return fitFlowLines(lines, width, height).map(colorFlowLine)
  }

  if (widget === 'sessions') {
    const lines = sessionsPanelLines(safeJson<SessionRecord[]>(paths.sessions) ?? [])
    return fitLines(lines, width, height, 'top').map((l, i) => (i === 0 ? color.bold(l) : l))
  }

  const view = buildActivity(readEvents(paths.events).slice(-500), { root, flow: flow ?? emptyFlow() }, Math.max(1, height - 2))
  const head = [color.bold(fitLine('Activity', width)), '']
  if (problem) return [...head, color.red(fitLine(problem, width))]
  if (view.length === 0) {
    return [
      ...head,
      ...fitLines(["Nothing yet. Claude's steps", 'show up here in plain words.'], width, height - 2, 'top').map((l) => color.dim(l)),
    ]
  }
  const paint = { header: color.boldCyan, note: color.yellow, action: (s: string) => s, alert: color.red, milestone: color.green }
  return [...head, ...view.map((v) => paint[v.kind](fitLine(v.text, width)))]
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
  out.write('\x1b[?1049h\x1b[?25l') // alternate screen, hide cursor
  let last = ''
  const draw = (force = false) => {
    const text = frame().map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J'
    if (force || text !== last) {
      out.write('\x1b[H' + text) // overwrite in place: no clear, no flicker
      last = text
    }
  }
  draw(true)
  const timer = setInterval(() => draw(), 300)
  out.on('resize', () => draw(true))
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer)
      out.write('\x1b[?25h\x1b[?1049l')
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
  })
}
