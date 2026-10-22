import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, runLaunch } from '../launch/main.js'
import { withFitLock } from './lock.js'
import { loadPrefs } from '../prefs/load.js'
import { resolveRoot, homeDir, isHomeRoot } from '../state/paths.js'
import { Widget } from '../prefs/schema.js'

export interface FrameOptions {
  root: string
  claudeArgv: string[]
  layout: { left: Widget; right: Widget }
  node: string
  cli: string
  tmuxBin: string
  /** terminal width; 0 means unknown, keep both panels */
  columns: number
}

export interface FrameDeps {
  tmux: (args: string[]) => { status: number; stdout: string; stderr: string }
  attach: (args: string[]) => number
  /** where messages for the user go; defaults to stderr */
  err?: (msg: string) => void
}

export { isHomeRoot }

const LEFT_WIDTH = 40
const RIGHT_WIDTH = 36
const MIN_CLAUDE_WIDTH = 60
const CLAUDE_SUBCOMMANDS = new Set(['doctor', 'update', 'install', 'config', 'plugin', 'setup-token', 'migrate-installer', 'mcp'])
const PLAIN_FLAGS = new Set(['-p', '--print', '--version', '-v', '--help', '-h'])
const TITLES: Record<Widget, string> = { flow: 'Flow', activity: 'Activity', sessions: 'Sessions', none: '' }

export function frameName(root: string): string {
  let real = root
  try {
    real = fs.realpathSync(root)
  } catch {
    // keep the path as given
  }
  return 'hece-' + crypto.createHash('sha1').update(real).digest('hex').slice(0, 12)
}

/** Keep the PATH entry (including symlinks), rather than Node's resolved, possibly versioned path. */
function nodeForFrame(env: NodeJS.ProcessEnv): string {
  for (const directory of env.PATH?.split(path.delimiter) ?? []) {
    const candidate = path.resolve(directory, 'node')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Missing or non-executable PATH entries are normal; try the next one.
    }
  }
  return process.execPath
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Wraps s in double quotes so the tmux command parser reads it as one argument. */
export function tmuxQuote(s: string): string {
  return `"${s.replace(/[\\"$]/g, '\\$&')}"`
}

/** Claude needs room: drop the left panel first, then the right, until it fits. 0 columns means unknown. */
export function sidesFor(columns: number, layout: { left: Widget; right: Widget }): { left: Widget; right: Widget } {
  let { left, right } = layout
  if (columns > 0) {
    const rw = right !== 'none' ? RIGHT_WIDTH : 0
    const lw = left !== 'none' ? LEFT_WIDTH : 0
    if (columns - lw - rw < MIN_CLAUDE_WIDTH) left = 'none'
    if (columns - rw < MIN_CLAUDE_WIDTH) right = 'none'
  }
  return { left, right }
}

export function homeNote(root: string, home: string): string {
  return isHomeRoot(root, home)
    ? "hece: you're in your home folder, so flow state will be saved in ~/.hece. Run hece inside a project folder for a per-project flow.\n"
    : ''
}

export function alreadyOpenMessage(name: string): string {
  return `hece: this project's window is already open. Switch to it with: tmux -L ${name} attach -t =${name}\n`
}

/**
 * Inside tmux, hece does not nest a window. Plain mode is right unless this project's window is already
 * open: then a second Claude would run in the same project, so the user is pointed to the first one.
 */
export function frameDecision(
  argv: string[],
  o: {
    stdinTTY: boolean
    stdoutTTY: boolean
    env: NodeJS.ProcessEnv
    tmuxAvailable: boolean
    cliBuilt: boolean
    /** only looked at inside tmux */
    windowOpen?: boolean
  },
): 'frame' | 'plain' | 'plain-no-tmux' | 'plain-not-built' | 'already-open' {
  if (!o.stdinTTY || !o.stdoutTTY || argv.some((a) => PLAIN_FLAGS.has(a))) return 'plain'
  if (argv[0] !== undefined && CLAUDE_SUBCOMMANDS.has(argv[0])) return 'plain'
  if (o.env.TMUX) return o.windowOpen ? 'already-open' : 'plain'
  if (!o.cliBuilt) return 'plain-not-built'
  return o.tmuxAvailable ? 'frame' : 'plain-no-tmux'
}

export function openFrame(o: FrameOptions, deps: FrameDeps): number {
  const name = frameName(o.root)
  const exact = `=${name}`
  const err = deps.err ?? ((m: string) => void process.stderr.write(m))
  // -f /dev/null: the user's ~/.tmux.conf must not change the layout; -u: UTF-8 even with an empty LANG
  const t = (...args: string[]) => deps.tmux(['-L', name, '-f', '/dev/null', '-u', ...args])
  const attach = () => deps.attach(['-L', name, '-f', '/dev/null', '-u', 'attach', '-t', exact])
  const hasSession = () => t('has-session', '-t', exact).status === 0
  if (hasSession()) return attach()

  const q = (args: string[]) => args.map(shellQuote).join(' ')
  // when Claude exits, the whole window closes (the pane-exited hook below is the backstop).
  // hece itself returns the status of the tmux attach, not Claude's exit code.
  const inner = `${q([o.node, o.cli, '--no-frame', ...o.claudeArgv])}; rc=$?; ${q([o.tmuxBin, '-L', name, '-f', '/dev/null', '-u', 'kill-server'])}; exit $rc`
  // pane commands go to tmux as separate argv items, which it runs directly: no login shell ($SHELL may be
  // fish or tcsh) and no quoting to get wrong. `rc=$?` needs POSIX sh, so the middle pane pins /bin/sh.
  const middle = ['/bin/sh', '-c', inner]
  const id = (r: { stdout: string }) => r.stdout.trim()
  // tmux expands #{...} in -c, so a literal # has to be doubled
  const cwd = o.root.replace(/#/g, '##')
  const fail = (what: string, detail: string): number => {
    t('kill-server')
    err(`hece: could not ${what} (${detail})\n`)
    return 1
  }

  const { left: leftW, right: rightW } = sidesFor(o.columns, o.layout)

  const created = t('new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', ...middle)
  if (created.status !== 0) {
    // a parallel launch may have started the window between our check and now
    if (hasSession()) return attach()
    err(`hece: could not start tmux (${created.stderr.trim() || `exit ${created.status}`})\n`)
    return 1
  }
  const mid = id(created)
  if (!mid) return fail('start tmux', 'no pane id')

  t('set', '-p', '-t', mid, '@hece_role', 'middle')
  const side = (which: 'left' | 'right', w: Widget) => addSide(t, mid, which, w, cwd, [o.node, o.cli, 'panel', w])
  let left: string | undefined
  if (leftW !== 'none') {
    const r = side('left', leftW)
    if (!r.ok) return fail('open the left panel', r.detail)
    left = r.pane
  }
  let right: string | undefined
  if (rightW !== 'none') {
    const r = side('right', rightW)
    if (!r.ok) return fail('open the right panel', r.detail)
    right = r.pane
  }

  for (const [opt, value] of [
    ['mouse', 'on'],
    ['escape-time', '10'],
    ['status-style', 'bg=colour236,fg=white'],
    ['status-left', ' hece '],
    ['status-right', ' F1 left · F2 claude · F3 right · click a pane to focus '],
    ['status-right-length', '80'],
    ['pane-border-status', 'top'],
    ['pane-border-format', ' #{pane_title} '],
    ['pane-active-border-style', 'fg=yellow'],
    ['allow-set-title', 'off'],
    ['automatic-rename', 'off'],
  ]) t('set', '-g', opt, value)

  t('select-pane', '-t', mid, '-T', 'Claude')

  // panels must never outlive Claude, even if the wrapper script dies before its own kill-server
  t('set-hook', '-g', 'pane-exited', `if -F "#{==:#{hook_pane},${mid}}" "kill-server"`)

  // re-check the layout whenever a terminal attaches or resizes: panels come back when there is room
  // (the cd matters: run-shell may not start in the project folder)
  const fit = `cd ${shellQuote(o.root)} && ${q([o.node, o.cli, 'frame-fit'])}`.replace(/#/g, '##')
  const hook = `run-shell -b ${tmuxQuote(fit)}`
  t('set-hook', '-g', 'client-resized', hook)
  t('set-hook', '-g', 'client-attached', hook)

  bindKeys(t, mid, left, right)
  t('select-pane', '-t', mid)
  return attach()
}

type Tmux = (...args: string[]) => { status: number; stdout: string; stderr: string }

function bindKeys(t: Tmux, mid: string, left?: string, right?: string): void {
  t('bind', '-n', 'F1', 'select-pane', '-t', left ?? mid)
  t('bind', '-n', 'F2', 'select-pane', '-t', mid)
  t('bind', '-n', 'F3', 'select-pane', '-t', right ?? mid)
}

// Splits a side panel off the middle pane, labels it and gives it its role.
// -d keeps focus where it was: this also runs from a resize hook.
function addSide(
  t: Tmux,
  mid: string,
  which: 'left' | 'right',
  widget: Widget,
  cwd: string,
  command: string[],
): { ok: true; pane: string } | { ok: false; detail: string } {
  const flag = which === 'left' ? '-hb' : '-h'
  const width = which === 'left' ? LEFT_WIDTH : RIGHT_WIDTH
  const r = t('split-window', '-d', flag, '-t', mid, '-l', String(width), '-c', cwd, '-P', '-F', '#{pane_id}', ...command)
  const pane = r.stdout.trim()
  if (r.status !== 0 || !pane) return { ok: false, detail: r.stderr.trim() || 'no pane id' }
  t('set', '-p', '-t', pane, '@hece_role', which)
  t('select-pane', '-t', pane, '-T', TITLES[widget])
  return { ok: true, pane }
}

/**
 * Brings a running window's side panels in line with its current width. Returns an exit code; never throws.
 * Hooks fire in bursts (attach plus resize, drag-resize), so the whole fit runs under a per-window lock and
 * reads the window only after taking it. When the lock cannot be had in time the fit is skipped.
 */
export function fitFrame(
  o: { root: string; layout: { left: Widget; right: Widget }; node: string; cli: string },
  deps: FrameDeps,
): number {
  try {
    const locked = withFitLock(frameName(o.root), () => fitLocked(o, deps))
    return locked.ran ? locked.value : 0
  } catch {
    return 1
  }
}

function fitLocked(
  o: { root: string; layout: { left: Widget; right: Widget }; node: string; cli: string },
  deps: FrameDeps,
): number {
  const name = frameName(o.root)
  // trailing colon: the session's current window. A bare =name makes `display` answer with an empty string.
  const exact = `=${name}:`
  const t: Tmux = (...args) => deps.tmux(['-L', name, '-f', '/dev/null', '-u', ...args])
  const w = t('display', '-p', '-t', exact, '#{window_width}')
  const width = Number(w.stdout.trim())
  if (w.status !== 0 || !Number.isInteger(width) || width <= 0) return 0
  const listed = t('list-panes', '-t', exact, '-F', '#{pane_id} #{@hece_role}')
  if (listed.status !== 0) return 0
  const panes: Record<string, string | undefined> = {}
  const extras: string[] = []
  for (const line of listed.stdout.split('\n')) {
    const [paneId, role] = line.trim().split(/\s+/)
    if (!paneId || !role) continue
    if (panes[role] === undefined) panes[role] = paneId
    else extras.push(paneId)
  }
  const mid = panes.middle
  if (!mid) return 0

  let failed = false
  // an earlier unlocked race may have left two panes with one role: keep the first, close the rest
  for (const extra of extras) if (t('kill-pane', '-t', extra).status !== 0) failed = true

  const want = sidesFor(width, o.layout)
  const cwd = o.root.replace(/#/g, '##')
  const sides: Array<['left' | 'right', Widget, number]> = [
    ['left', want.left, LEFT_WIDTH],
    ['right', want.right, RIGHT_WIDTH],
  ]
  for (const [which, widget] of sides) {
    const have = panes[which]
    if (widget !== 'none' && !have) {
      const r = addSide(t, mid, which, widget, cwd, [o.node, o.cli, 'panel', widget])
      if (!r.ok) failed = true
      else panes[which] = r.pane
    } else if (widget === 'none' && have) {
      if (t('kill-pane', '-t', have).status === 0) panes[which] = undefined
      else failed = true
    }
  }
  for (const [which, widget, size] of sides) if (widget !== 'none' && panes[which]) t('resize-pane', '-t', panes[which]!, '-x', String(size))
  bindKeys(t, mid, panes.left, panes.right)
  return failed ? 1 : 0
}

export async function runFrame(argv: string[]): Promise<void> {
  const env = process.env
  const tmuxBin = env.HECE_TMUX_BIN || 'tmux'
  const tmuxAvailable = () => spawnSync(tmuxBin, ['-V'], { stdio: 'ignore' }).status === 0
  const cli = path.join(pluginRoot(), 'dist', 'cli.js')
  const cliBuilt = fs.existsSync(cli)
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  // inside tmux: is this project's own window already open on its private socket?
  const windowOpen = () => {
    const name = frameName(resolveRoot(env))
    return spawnSync(tmuxBin, ['-L', name, '-f', '/dev/null', '-u', 'has-session', '-t', `=${name}`], { stdio: 'ignore' }).status === 0
  }
  const decision = frameDecision(argv, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env,
    tmuxAvailable: interactive && !env.TMUX && tmuxAvailable(),
    cliBuilt,
    windowOpen: Boolean(interactive && env.TMUX && !argv.some((a) => PLAIN_FLAGS.has(a)) && tmuxAvailable() && windowOpen()),
  })
  if (decision === 'already-open') {
    process.stderr.write(alreadyOpenMessage(frameName(resolveRoot(env))))
    process.exitCode = 1
    return
  }
  if (decision === 'plain') return runLaunch(argv)
  const printHomeNote = () => {
    const note = homeNote(resolveRoot(env), homeDir(env))
    if (note) process.stderr.write(note)
  }
  if (decision === 'plain-not-built') {
    printHomeNote()
    process.stderr.write('hece: not built yet (run npm run build), so starting without panels.\n')
    return runLaunch(argv)
  }
  if (decision === 'plain-no-tmux') {
    printHomeNote()
    process.stderr.write('hece: tmux not found, so starting without panels. Install it for the full window (macOS: brew install tmux).\n')
    return runLaunch(argv)
  }
  const root = resolveRoot(env)
  printHomeNote()
  const { prefs } = loadPrefs(env, root)
  process.exitCode = openFrame(
    { root, claudeArgv: argv, layout: prefs.layout, node: nodeForFrame(env), cli, tmuxBin, columns: process.stdout.columns ?? 0 },
    {
      tmux: (args) => {
        const r = spawnSync(tmuxBin, args, { encoding: 'utf8' })
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
      attach: (args) => spawnSync(tmuxBin, args, { stdio: 'inherit' }).status ?? 0,
    },
  )
}

// Hidden command run by the tmux hooks: re-fit the window of the project in the current folder.
// Always exits 0: a hook has nowhere useful to show an error, and tmux would put it on the status line.
export async function runFrameFit(): Promise<void> {
  try {
    const env = process.env
    const tmuxBin = env.HECE_TMUX_BIN || 'tmux'
    const root = resolveRoot(env)
    const { prefs } = loadPrefs(env, root)
    fitFrame(
      { root, layout: prefs.layout, node: nodeForFrame(env), cli: path.join(pluginRoot(), 'dist', 'cli.js') },
      {
        tmux: (args) => {
          const r = spawnSync(tmuxBin, args, { encoding: 'utf8' })
          return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
        },
        attach: () => 0,
      },
    )
  } catch {
    // nothing to report to
  }
  process.exitCode = 0
}
