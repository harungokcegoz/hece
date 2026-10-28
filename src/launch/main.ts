import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPrefs } from '../prefs/load.js'
import type { Prefs } from '../prefs/schema.js'
import { resolveRoot } from '../state/paths.js'

/** Package root: src/launch/main.ts or dist/launch/main.js → two levels up. */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** Set on the Claude process hece launches (window and --no-frame); the SessionStart hook reads it. */
export const HECE_SESSION_ENV = 'HECE_SESSION'

export function claudeArgs(argv: string[], root: string, prefs?: Pick<Prefs, 'delegate' | 'effort'>): string[] {
  const has = (f: string): boolean => argv.some((a) => a === f || a.startsWith(`${f}=`))
  const flags: string[] = []
  const add = (f: string, v?: string): void => {
    if (v && v !== 'default' && !has(f)) flags.push(f, v)
  }
  add('--model', prefs?.delegate.orchestrator)
  add('--effort', prefs?.effort.orchestrator)
  return ['--plugin-dir', root, ...flags, ...argv]
}

export function runLaunch(argv: string[]): Promise<void> {
  const bin = process.env.HECE_CLAUDE_BIN || 'claude'
  return new Promise((resolve) => {
    const child = spawn(bin, claudeArgs(argv, pluginRoot(), loadPrefs(process.env, resolveRoot(process.env)).prefs), { stdio: 'inherit', env: { ...process.env, [HECE_SESSION_ENV]: '1' } })

    // Ctrl-C reaches the whole foreground process group, so Claude gets it
    // itself. We only need to stay alive until it exits.
    const onInt = (): void => {}
    const onTerm = (): void => void child.kill('SIGTERM')
    const onHup = (): void => void child.kill('SIGHUP')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    process.on('SIGHUP', onHup)
    let done = false
    const cleanup = (): void => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      process.off('SIGHUP', onHup)
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (done) return
      done = true
      cleanup()
      process.stderr.write(
        err.code === 'ENOENT'
          ? 'hece: could not find `claude`. Install Claude Code first: https://claude.com/claude-code\n'
          : `hece: ${err.message}\n`,
      )
      process.exitCode = 1
      resolve()
    })

    child.on('close', (code) => {
      if (done) return // a failed spawn emits both 'error' and 'close'
      done = true
      cleanup()
      process.exitCode = code ?? 1
      resolve()
    })
  })
}
