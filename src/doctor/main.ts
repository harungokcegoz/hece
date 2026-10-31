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

export function runChecks(d: DoctorDeps): Check[] {
  const pluginCheck = (name: string, label: string): Check => {
    const ok = d.plugins?.has(name) ?? false
    return { ok, label, ...(ok ? {} : { fix: d.plugins === null ? "couldn't read Claude Code's plugin list" : INSTALL[name] }) }
  }
  const node = Number(d.nodeVersion.replace(/^v/, '').split('.')[0])
  const tmux = d.onPath('tmux')
  const built = d.exists(path.join(d.pkgRoot, 'dist', 'cli.js'))
  const claude = d.onPath('claude')
  const wired = d.exists(path.join(d.pkgRoot, '.claude-plugin', 'plugin.json')) && d.exists(path.join(d.pkgRoot, 'hooks', 'hooks.json'))
  return [
    { ok: node >= 20, label: `Node ${d.nodeVersion} (need 20 or newer)`, ...(node >= 20 ? {} : { fix: 'install Node 20 or newer' }) },
    { ok: tmux, label: 'tmux', optional: true, ...(tmux ? {} : { fix: 'install tmux for the three-pane window' }) },
    { ok: built, label: 'hece is built', ...(built ? {} : { fix: 'run npm run build' }) },
    { ok: claude, label: 'claude on PATH', ...(claude ? {} : { fix: 'install Claude Code' }) },
    pluginCheck('superpowers', 'superpowers plugin'),
    pluginCheck(d.optimize, `${d.optimize} plugin`),
    { ok: d.prefsErrors.length === 0, label: 'preferences', ...(d.prefsErrors.length ? { fix: d.prefsErrors.join('; ') } : {}) },
    { ok: wired, label: 'plugin wiring', ...(wired ? {} : { fix: 'reinstall hece (plugin.json or hooks.json missing)' }) },
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
    return new Set(Object.keys(json.plugins).map((k) => k.split('@')[0]))
  } catch {
    return null
  }
}

export function systemChecks(optimize: Prefs['optimize'], prefsErrors: string[]): Check[] {
  return runChecks({
    nodeVersion: process.version,
    onPath: systemOnPath,
    exists: fs.existsSync,
    plugins: installedPlugins(process.env),
    prefsErrors,
    pkgRoot: pluginRoot(),
    optimize,
  })
}

export function systemOnPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';')] : ['']
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => dir && exts.some((e) => {
    try { fs.accessSync(path.join(dir, bin + e), fs.constants.X_OK); return fs.statSync(path.join(dir, bin + e)).isFile() } catch { return false }
  }))
}

export async function runDoctor(): Promise<void> {
  const { prefs, errors } = loadPrefs(process.env, resolveRoot(process.env))
  const checks = systemChecks(prefs.optimize, errors)
  process.stdout.write(formatChecks(checks))
  if (failed(checks)) process.exitCode = 1
}
