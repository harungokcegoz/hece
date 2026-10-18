#!/usr/bin/env node
import { runHook } from './hooks/main.js'
import { runMcp } from './mcp/main.js'
import { runStatus } from './status/main.js'

const USAGE = 'usage: hece <hook|mcp|status>'

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  if (cmd === 'mcp') return runMcp()
  if (cmd === 'status') return runStatus()
  process.stderr.write(USAGE + '\n')
  process.exitCode = 1
}

await main(process.argv.slice(2))
