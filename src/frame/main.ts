import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, runLaunch } from '../launch/main.js'
import { loadPrefs } from '../prefs/load.js'
import { resolveRoot } from '../state/paths.js'
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

const LEFT_WIDTH = 40
const RIGHT_WIDTH = 36
const MIN_CLAUDE_WIDTH = 60
const CLAUDE_SUBCOMMANDS = new Set(['doctor', 'update', 'install', 'config'])
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

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function frameDecision(
  argv: string[],
  o: { stdinTTY: boolean; stdoutTTY: boolean; env: NodeJS.ProcessEnv; tmuxAvailable: boolean; cliBuilt: boolean },
): 'frame' | 'plain' | 'plain-no-tmux' | 'plain-not-built' {
  if (!o.stdinTTY || !o.stdoutTTY || o.env.TMUX || argv.some((a) => PLAIN_FLAGS.has(a))) return 'plain'
  if (argv[0] !== undefined && CLAUDE_SUBCOMMANDS.has(argv[0])) return 'plain'
  if (!o.cliBuilt) return 'plain-not-built'
  return o.tmuxAvailable ? 'frame' : 'plain-no-tmux'
}

export function openFrame(o: FrameOptions, deps: FrameDeps): number {
  const name = frameName(o.root)
  const exact = `=${name}`
  const err = deps.err ?? ((m: string) => void process.stderr.write(m))
  // -f /dev/null: the user's ~/.tmux.conf must not change the layout
  const t = (...args: string[]) => deps.tmux(['-L', name, '-f', '/dev/null', ...args])
  const attach = () => deps.attach(['-L', name, '-f', '/dev/null', 'attach', '-t', exact])
  const hasSession = () => t('has-session', '-t', exact).status === 0
  if (hasSession()) return attach()

  const q = (args: string[]) => args.map(shellQuote).join(' ')
  // when Claude exits, the whole window closes; hece keeps Claude's exit code
  const inner = `${q([o.node, o.cli, '--no-frame', ...o.claudeArgv])}; rc=$?; ${q([o.tmuxBin, '-L', name, '-f', '/dev/null', 'kill-server'])}; exit $rc`
  // tmux runs this via the user's $SHELL -c; fish and tcsh cannot parse `rc=$?`, so pin it to POSIX sh
  const middle = q(['/bin/sh', '-c', inner])
  const panel = (w: Widget) => q([o.node, o.cli, 'panel', w])
  const id = (r: { stdout: string }) => r.stdout.trim()
  // tmux expands #{...} in -c, so a literal # has to be doubled
  const cwd = o.root.replace(/#/g, '##')
  const fail = (what: string, detail: string): number => {
    t('kill-server')
    err(`hece: could not ${what} (${detail})\n`)
    return 1
  }

  // Claude needs room: drop side panels the terminal is too narrow for
  let leftW: Widget = o.layout.left
  let rightW: Widget = o.layout.right
  if (o.columns > 0) {
    const rw = rightW !== 'none' ? RIGHT_WIDTH : 0
    const lw = leftW !== 'none' ? LEFT_WIDTH : 0
    if (o.columns - lw - rw < MIN_CLAUDE_WIDTH) leftW = 'none'
    if (o.columns - rw < MIN_CLAUDE_WIDTH) rightW = 'none'
  }

  const created = t('new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', middle)
  if (created.status !== 0) {
    // a parallel launch may have started the window between our check and now
    if (hasSession()) return attach()
    err(`hece: could not start tmux (${created.stderr.trim() || `exit ${created.status}`})\n`)
    return 1
  }
  const mid = id(created)
  if (!mid) return fail('start tmux', 'no pane id')

  let left: string | undefined
  if (leftW !== 'none') {
    const r = t('split-window', '-hb', '-t', mid, '-l', String(LEFT_WIDTH), '-c', cwd, '-P', '-F', '#{pane_id}', panel(leftW))
    left = id(r)
    if (r.status !== 0 || !left) return fail('open the left panel', r.stderr.trim() || 'no pane id')
  }
  let right: string | undefined
  if (rightW !== 'none') {
    const r = t('split-window', '-h', '-t', mid, '-l', String(RIGHT_WIDTH), '-c', cwd, '-P', '-F', '#{pane_id}', panel(rightW))
    right = id(r)
    if (r.status !== 0 || !right) return fail('open the right panel', r.stderr.trim() || 'no pane id')
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

  t('select-pane', '-t', mid, '-T', 'claude')
  if (left) t('select-pane', '-t', left, '-T', TITLES[leftW])
  if (right) t('select-pane', '-t', right, '-T', TITLES[rightW])

  // keep side panels at a fixed width when the terminal is resized
  const fix = [left && `resize-pane -t ${left} -x ${LEFT_WIDTH}`, right && `resize-pane -t ${right} -x ${RIGHT_WIDTH}`]
    .filter(Boolean)
    .join(' ; ')
  if (fix) {
    t('set-hook', '-g', 'client-resized', fix)
    t('set-hook', '-g', 'client-attached', fix)
  }

  t('bind', '-n', 'F1', 'select-pane', '-t', left ?? mid)
  t('bind', '-n', 'F2', 'select-pane', '-t', mid)
  t('bind', '-n', 'F3', 'select-pane', '-t', right ?? mid)
  t('select-pane', '-t', mid)
  return attach()
}

export async function runFrame(argv: string[]): Promise<void> {
  const env = process.env
  const tmuxBin = env.HECE_TMUX_BIN || 'tmux'
  const tmuxAvailable = () => spawnSync(tmuxBin, ['-V'], { stdio: 'ignore' }).status === 0
  const cli = path.join(pluginRoot(), 'dist', 'cli.js')
  const cliBuilt = fs.existsSync(cli)
  const decision = frameDecision(argv, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env,
    tmuxAvailable: Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.TMUX) && tmuxAvailable(),
    cliBuilt,
  })
  if (decision === 'plain') return runLaunch(argv)
  if (decision === 'plain-not-built') {
    process.stderr.write('hece: not built yet (run npm run build), so starting without panels.\n')
    return runLaunch(argv)
  }
  if (decision === 'plain-no-tmux') {
    process.stderr.write('hece: tmux not found, so starting without panels. Install it for the full window (macOS: brew install tmux).\n')
    return runLaunch(argv)
  }
  const root = resolveRoot(env)
  const { prefs } = loadPrefs(env, root)
  process.exitCode = openFrame(
    { root, claudeArgv: argv, layout: prefs.layout, node: process.execPath, cli, tmuxBin, columns: process.stdout.columns ?? 0 },
    {
      tmux: (args) => {
        const r = spawnSync(tmuxBin, args, { encoding: 'utf8' })
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
      attach: (args) => spawnSync(tmuxBin, args, { stdio: 'inherit' }).status ?? 0,
    },
  )
}
