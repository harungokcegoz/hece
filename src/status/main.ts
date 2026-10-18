import fs from 'node:fs'
import { resolveRoot, statePaths } from '../state/paths.js'
import { readJson } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { loadPrefs } from '../prefs/load.js'

export function runStatus(): void {
  const root = resolveRoot(process.env)
  const paths = statePaths(root)
  const { prefs, errors } = loadPrefs(process.env, root)
  if (!fs.existsSync(paths.flow)) {
    process.stdout.write('hece: no flow in this project yet. Ask the agent to build something with hece to start one.\n')
  } else {
    process.stdout.write(renderFlow(readJson<FlowState>(paths.flow, emptyFlow()), { guards: prefs.guards }) + '\n')
  }
  for (const e of errors) process.stderr.write(`warning: ${e}\n`)
}
