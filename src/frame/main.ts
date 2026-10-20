import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
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
}

export interface FrameDeps {
  tmux: (args: string[]) => { status: number; stdout: string }
  attach: (args: string[]) => number
}

const LEFT_WIDTH = 40
const RIGHT_WIDTH = 36
const PLAIN_FLAGS = new Set(['-p', '--print', '--version', '-v', '--help', '-h'])
const TITLES: Record<Widget, string> = { flow: 'Flow', activity: 'Activity', sessions: 'Sessions', none: '' }

export function frameName(root: string): string {
  return 'hece-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function frameDecision(
  argv: string[],
  o: { stdinTTY: boolean; stdoutTTY: boolean; env: NodeJS.ProcessEnv; tmuxAvailable: boolean },
): 'frame' | 'plain' | 'plain-no-tmux' {
  if (!o.stdinTTY || !o.stdoutTTY || o.env.TMUX || argv.some((a) => PLAIN_FLAGS.has(a))) return 'plain'
  return o.tmuxAvailable ? 'frame' : 'plain-no-tmux'
}

export function openFrame(o: FrameOptions, deps: FrameDeps): number {
  const name = frameName(o.root)
  const t = (...args: string[]) => deps.tmux(['-L', name, ...args])
  const attach = () => deps.attach(['-L', name, 'attach', '-t', name])
  if (t('has-session', '-t', name).status === 0) return attach()

  const q = (args: string[]) => args.map(shellQuote).join(' ')
  // when Claude exits, the whole window closes
  const middle = `${q([o.node, o.cli, '--no-frame', ...o.claudeArgv])}; ${q([o.tmuxBin, '-L', name, 'kill-server'])}`
  const panel = (w: Widget) => q([o.node, o.cli, 'panel', w])
  const id = (r: { stdout: string }) => r.stdout.trim()

  const mid = id(t('new-session', '-d', '-s', name, '-c', o.root, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', middle))
  const left = o.layout.left !== 'none'
    ? id(t('split-window', '-hb', '-t', mid, '-l', String(LEFT_WIDTH), '-c', o.root, '-P', '-F', '#{pane_id}', panel(o.layout.left)))
    : undefined
  const right = o.layout.right !== 'none'
    ? id(t('split-window', '-h', '-t', mid, '-l', String(RIGHT_WIDTH), '-c', o.root, '-P', '-F', '#{pane_id}', panel(o.layout.right)))
    : undefined

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
  ]) t('set', '-g', opt, value)

  t('select-pane', '-t', mid, '-T', 'claude')
  if (left) t('select-pane', '-t', left, '-T', TITLES[o.layout.left])
  if (right) t('select-pane', '-t', right, '-T', TITLES[o.layout.right])

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
  const decision = frameDecision(argv, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env,
    tmuxAvailable: Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.TMUX) && tmuxAvailable(),
  })
  if (decision === 'plain') return runLaunch(argv)
  if (decision === 'plain-no-tmux') {
    process.stderr.write('hece: tmux not found, so starting without panels. Install it for the full window (macOS: brew install tmux).\n')
    return runLaunch(argv)
  }
  const root = resolveRoot(env)
  const { prefs } = loadPrefs(env, root)
  process.exitCode = openFrame(
    { root, claudeArgv: argv, layout: prefs.layout, node: process.execPath, cli: path.join(pluginRoot(), 'dist', 'cli.js'), tmuxBin },
    {
      tmux: (args) => {
        const r = spawnSync(tmuxBin, args, { encoding: 'utf8' })
        return { status: r.status ?? 1, stdout: r.stdout ?? '' }
      },
      attach: (args) => spawnSync(tmuxBin, args, { stdio: 'inherit' }).status ?? 0,
    },
  )
}
