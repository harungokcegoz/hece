import path from 'node:path'

export interface StatePaths {
  root: string
  heceDir: string
  stateDir: string
  flow: string
  events: string
  sessions: string
  agent: string
  captures: string
}

export function resolveRoot(env: NodeJS.ProcessEnv, payloadCwd?: string): string {
  return env.HECE_ROOT || env.CLAUDE_PROJECT_DIR || payloadCwd || process.cwd()
}

export function statePaths(root: string): StatePaths {
  const heceDir = path.join(root, '.hece')
  const stateDir = path.join(heceDir, 'state')
  return {
    root,
    heceDir,
    stateDir,
    flow: path.join(stateDir, 'flow.json'),
    events: path.join(stateDir, 'events.jsonl'),
    sessions: path.join(stateDir, 'sessions.json'),
    agent: path.join(stateDir, 'agent.json'),
    captures: path.join(stateDir, 'captures'),
  }
}
