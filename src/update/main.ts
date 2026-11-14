import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot } from '../launch/main.js'

export const STEPS: string[][] = [
  ['git', 'pull', '--ff-only'],
  ['npm', 'install'],
  ['npm', 'run', 'build'],
]

export type Run = (cmd: string, args: string[], cwd: string) => number

const run: Run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1

/** Returns the exit code: 0 when every step passed. */
export function update(root: string, exec: Run = run, out: (s: string) => void = (s) => process.stderr.write(s)): number {
  if (!fs.existsSync(path.join(root, '.git'))) {
    out(`hece: ${root} is not a git checkout. Download the latest release:\n  https://github.com/harungokcegoz/hece/releases/latest\n`)
    return 1
  }
  for (const [cmd, ...args] of STEPS) {
    out(`hece: ${cmd} ${args.join(' ')}\n`)
    const code = exec(cmd, args, root)
    if (code !== 0) {
      out(`hece: update stopped, \`${cmd} ${args.join(' ')}\` failed (exit ${code}).\n`)
      return code
    }
  }
  out('hece: updated. Reopen any running hece window to use the new version.\n')
  return 0
}

export function runUpdate(): void {
  process.exitCode = update(pluginRoot())
}
