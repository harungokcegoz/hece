import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginRoot } from '../launch/main.js'
import { loadPrefs } from '../prefs/load.js'
import type { Prefs } from '../prefs/schema.js'
import { resolveRoot } from '../state/paths.js'

export interface Check { ok: boolean; label: string; fix?: string; optional?: boolean }

export interface DoctorDeps {
  nodeVersion: string
  onPath(bin: string): boolean
  exists(file: string): boolean
  read(file: string): string
  plugins: Set<string> | null
  prefsErrors: string[]
  pkgRoot: string
  optimize: Prefs['optimize']
}

const INSTALL: Record<string, string> = {
  superpowers: '/plugin install superpowers@claude-plugins-official',
  ponytail: '/plugin marketplace add DietrichGebert/ponytail, then /plugin install ponytail@ponytail',
  caveman: '/plugin marketplace add JuliusBrussee/caveman, then /plugin install caveman@caveman',
}

/** What is wrong with the plugin files, or undefined when plugin.json and hooks.json point at dist/cli.js. */
function wiringProblem(d: DoctorDeps): string | undefined {
  const parts = [
    { file: path.join(d.pkgRoot, '.claude-plugin', 'plugin.json'), part: (j: { mcpServers?: unknown }) => j.mcpServers },
    { file: path.join(d.pkgRoot, 'hooks', 'hooks.json'), part: (j: { hooks?: unknown }) => j.hooks },
  ]
  for (const { file, part } of parts) {
    const name = path.basename(file)
    if (!d.exists(file)) return `reinstall hece (${name} missing)`
    try {
      if (!JSON.stringify(part(JSON.parse(d.read(file))) ?? null).includes('dist/cli.js')) return `reinstall hece (${name} does not run dist/cli.js)`
    } catch {
      return `reinstall hece (${name} is not valid JSON)`
    }
  }
}

export function runChecks(d: DoctorDeps): Check[] {
  const pluginCheck = (name: string, label: string): Check => {
    const ok = d.plugins?.has(name) ?? false
    return { ok, label, ...(ok ? {} : { fix: d.plugins === null ? "couldn't read Claude Code's plugin list" : INSTALL[name] }) }
  }
  const node = Number(d.nodeVersion.replace(/^v/, '').split('.')[0])
  const tmux = d.onPath('tmux')
  const built = d.exists(path.join(d.pkgRoot, 'dist', 'cli.js'))
  const claude = d.onPath('claude')
  const wiring = wiringProblem(d)
  return [
    { ok: node >= 20, label: `Node ${d.nodeVersion} (need 20 or newer)`, ...(node >= 20 ? {} : { fix: 'install Node 20 or newer' }) },
    { ok: tmux, label: 'tmux', optional: true, ...(tmux ? {} : { fix: 'install tmux for the three-pane window' }) },
    { ok: built, label: 'hece is built', ...(built ? {} : { fix: 'run npm run build' }) },
    { ok: claude, label: 'claude on PATH', ...(claude ? {} : { fix: 'install Claude Code' }) },
    pluginCheck('superpowers', 'superpowers plugin'),
    pluginCheck(d.optimize, `${d.optimize} plugin`),
    { ok: d.prefsErrors.length === 0, label: 'preferences', ...(d.prefsErrors.length ? { fix: d.prefsErrors.join('\n  ') } : {}) },
    { ok: !wiring, label: 'plugin wiring', ...(wiring ? { fix: wiring } : {}) },
  ]
}

export function formatChecks(c: Check[]): string {
  const lines = c.flatMap((x) => [`${x.ok ? '✓' : '✗'} ${x.label}`, ...(!x.ok && x.fix ? [`  ${x.fix}`] : [])])
  return [...lines, "Claude Code's own check: claude doctor"].join('\n') + '\n'
}

export const failed = (c: Check[]): boolean => c.some((x) => !x.ok && !x.optional)

export function installedPlugins(env: NodeJS.ProcessEnv, home: string = os.homedir()): Set<string> | null {
  try {
    const file = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json')
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    // readable but an unexpected shape: nothing installed, not "couldn't read"
    return new Set(Object.keys(json?.plugins ?? {}).map((k) => k.split('@')[0]))
  } catch {
    return null
  }
}

export function systemChecks(optimize: Prefs['optimize'], prefsErrors: string[]): Check[] {
  return runChecks({
    nodeVersion: process.version,
    onPath: systemOnPath,
    exists: fs.existsSync,
    read: (f) => fs.readFileSync(f, 'utf8'),
    plugins: installedPlugins(process.env),
    prefsErrors,
    pkgRoot: pluginRoot(),
    optimize,
  })
}

export function systemOnPath(rawBin: string): boolean {
  // launch and frame honour these overrides, so the check must too
  const bin = (rawBin === 'claude' ? process.env.HECE_CLAUDE_BIN : rawBin === 'tmux' ? process.env.HECE_TMUX_BIN : '') || rawBin
  const isExe = (file: string) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false } }
  if (bin.includes('/') || bin.includes(path.sep)) return isExe(bin)
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : ['']
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && exts.some((e) => isExe(path.join(dir, bin + e))))
}

export async function runDoctor(): Promise<void> {
  const { prefs, errors } = loadPrefs(process.env, resolveRoot(process.env))
  const checks = systemChecks(prefs.optimize, errors)
  process.stdout.write(formatChecks(checks))
  if (failed(checks)) process.exitCode = 1
}
