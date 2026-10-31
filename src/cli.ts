#!/usr/bin/env node
import { runDoctor } from './doctor/main.js'
import { runFrame, runFrameFit } from './frame/main.js'
import { runHook } from './hooks/main.js'
import { runLaunch } from './launch/main.js'
import { runMcp } from './mcp/main.js'
import { runPanel } from './panels/main.js'
import { runPrefs, runSetup } from './setup/main.js'
import { runStatus } from './status/main.js'

const USAGE = `usage: hece [claude args…]          open the hece window: Activity · Claude · Flow
       hece --no-frame [claude args…]   Claude Code with hece loaded, no panels
       hece status                      show where you are in the flow
       hece panel <flow|activity|sessions>   run one panel (used by the window)
       hece setup                       choose your preferences
       hece prefs [name]                change one preference group
       hece doctor                      check the install
       hece help                        show this help
(hece hook and hece mcp are run by Claude Code itself)
`

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  if (cmd === 'mcp') return runMcp()
  if (cmd === 'doctor') return runDoctor()
  if (cmd === 'setup') return runSetup(argv.slice(1))
  if (cmd === 'prefs') return runPrefs(argv.slice(1))
  if (cmd === 'status') return runStatus()
  if (cmd === 'frame-fit') return runFrameFit()
  if (cmd === 'panel') return runPanel(argv.slice(1))
  if (cmd === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (argv.includes('--no-frame')) return runLaunch(argv.filter((a) => a !== '--no-frame'))
  return runFrame(argv)
}

await main(process.argv.slice(2))
