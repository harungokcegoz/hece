#!/usr/bin/env node
import { runHook } from './hooks/main.js'
import { runLaunch } from './launch/main.js'
import { runMcp } from './mcp/main.js'
import { runStatus } from './status/main.js'

const USAGE = `usage: hece [claude args…]   start Claude Code with hece loaded
       hece status           show where you are in the flow
       hece help             show this help
(hece hook and hece mcp are run by Claude Code itself)
`

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  if (cmd === 'mcp') return runMcp()
  if (cmd === 'status') return runStatus()
  if (cmd === 'help') {
    process.stdout.write(USAGE)
    return
  }
  return runLaunch(argv)
}

await main(process.argv.slice(2))
