import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { statePaths } from '../src/state/paths.js'
import { writeJsonAtomic } from '../src/state/store.js'
import { FlowState } from '../src/flow/types.js'

export const CLI = path.resolve('src/cli.ts')

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hece-proj-'))
}

export function seedFlow(root: string, state: FlowState): void {
  writeJsonAtomic(statePaths(root).flow, state)
}

export function testEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.CLAUDE_PROJECT_DIR
  return { ...env, HECE_ROOT: root, XDG_CONFIG_HOME: path.join(root, '.config-test'), ...extra }
}

export function runCli(args: string[], opts: { root: string; stdin?: string; env?: Record<string, string>; cwd?: string }) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    input: opts.stdin ?? '',
    encoding: 'utf8',
    cwd: opts.cwd,
    env: testEnv(opts.root, opts.env),
  })
}
