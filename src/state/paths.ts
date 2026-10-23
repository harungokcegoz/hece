import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface StatePaths {
  root: string
  heceDir: string
  stateDir: string
  flow: string
  flowLock: string
  events: string
  sessions: string
  agent: string
  captures: string
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Nearest folder at or above `start` that holds a .hece folder; stops after the git root,
 * and below the home folder (an unrelated ~/.hece must not capture loose folders). Falls back to `start`.
 */
function findHeceRoot(start: string, home: string): string {
  let dir = start
  for (;;) {
    if (isDir(path.join(dir, '.hece'))) return dir
    const parent = path.dirname(dir)
    if (fs.existsSync(path.join(dir, '.git')) || parent === dir || parent === home) return start
    dir = parent
  }
}

/**
 * With `walkUp` (status and panel, which run wherever the user is), the working
 * folder is replaced by the nearest project folder above it. The hook gets its
 * cwd from Claude and never walks; an explicit HECE_ROOT or CLAUDE_PROJECT_DIR wins.
 */
export function resolveRoot(env: NodeJS.ProcessEnv, payloadCwd?: string, opts: { walkUp?: boolean; cwd?: string; home?: string } = {}): string {
  const explicit = env.HECE_ROOT || env.CLAUDE_PROJECT_DIR || payloadCwd
  if (explicit) return explicit
  const cwd = opts.cwd ?? process.cwd()
  return opts.walkUp ? findHeceRoot(cwd, opts.home ?? os.homedir()) : cwd
}

export function statePaths(root: string): StatePaths {
  const heceDir = path.join(root, '.hece')
  const stateDir = path.join(heceDir, 'state')
  return {
    root,
    heceDir,
    stateDir,
    flow: path.join(stateDir, 'flow.json'),
    flowLock: path.join(stateDir, 'flow.json.lock'),
    events: path.join(stateDir, 'events.jsonl'),
    sessions: path.join(stateDir, 'sessions.json'),
    agent: path.join(stateDir, 'agent.json'),
    captures: path.join(stateDir, 'captures'),
  }
}

/** The user's home folder; HECE_HOME lets tests pretend. */
export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HECE_HOME || os.homedir()
}

export function isHomeRoot(root: string, home: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  return real(root) === real(home)
}
