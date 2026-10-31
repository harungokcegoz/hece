import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { needsFirstRun } from '../../src/setup/main.js'
import { prefsFiles } from '../../src/prefs/load.js'
import { tmpProject, runCli, testEnv } from '../helpers.js'

describe('first run', () => {
  it('only for an interactive claude session with no global file', () => {
    const tty = { stdinTTY: true, stdoutTTY: true }
    expect(needsFirstRun([], { ...tty, globalExists: false })).toBe(true)
    expect(needsFirstRun(['--no-frame'], { ...tty, globalExists: false })).toBe(true)
    expect(needsFirstRun([], { ...tty, globalExists: true })).toBe(false)
    expect(needsFirstRun(['-p', 'hi'], { ...tty, globalExists: false })).toBe(false)
    expect(needsFirstRun([], { stdinTTY: false, stdoutTTY: true, globalExists: false })).toBe(false)
    expect(needsFirstRun(['update'], { ...tty, globalExists: false })).toBe(false)
  })

  it('piped hece never writes the global file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-fake-claude-'))
    const fake = path.join(dir, 'claude')
    const marker = path.join(dir, 'ran')
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
    fs.chmodSync(fake, 0o755)
    const root = tmpProject()
    const r = runCli(['--no-frame'], { root, stdin: 'x', env: { HECE_CLAUDE_BIN: fake } })
    // without the gate the wizard would find no terminal, refuse and print an error
    expect(fs.existsSync(marker)).toBe(true)
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).not.toMatch(/needs a terminal|setup|Defaults saved/)
    expect(fs.existsSync(prefsFiles(testEnv(root), root).global)).toBe(false)
  })
})
