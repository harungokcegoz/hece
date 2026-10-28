import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeArgs, pluginRoot } from '../../src/launch/main.js'
import { tmpProject, runCli } from '../helpers.js'

const REPO_ROOT = path.resolve('.')

let fake: string
let marker: string

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-fake-claude-'))
  fake = path.join(dir, 'claude')
  marker = path.join(dir, 'ran')
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.HECE_SESSION ?? 'unset')
console.log(JSON.stringify(process.argv.slice(2)))
process.exit(Number(process.env.FAKE_EXIT || 0))
`,
  )
  fs.chmodSync(fake, 0o755)
})

function launch(args: string[], env: Record<string, string> = {}) {
  fs.rmSync(marker, { force: true })
  return runCli(args, { root: tmpProject(), env: { HECE_CLAUDE_BIN: fake, ...env } })
}

describe('claudeArgs', () => {
  it('puts --plugin-dir first and passes the rest through', () => {
    expect(claudeArgs(['-c', 'x'], '/r')).toEqual(['--plugin-dir', '/r', '-c', 'x'])
    expect(claudeArgs([], '/r')).toEqual(['--plugin-dir', '/r'])
  })
})

const P = (o: string, e: string) => ({ delegate: { orchestrator: o, build: 'sonnet', review: 'opus' }, effort: { orchestrator: e, build: 'medium', review: 'high' } })
describe('claudeArgs prefs', () => {
  it('adds --model/--effort only when set', () => {
    expect(claudeArgs([], '/r', P('default', 'default'))).toEqual(['--plugin-dir', '/r'])
    expect(claudeArgs([], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--model', 'opus', '--effort', 'high'])
  })
  it("the user's own flags win", () => {
    expect(claudeArgs(['--model', 'haiku'], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--effort', 'high', '--model', 'haiku'])
    expect(claudeArgs(['--effort=low'], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--model', 'opus', '--effort=low'])
  })
  it('launch reads the global prefs file', () => {
    const root = tmpProject()
    fs.mkdirSync(path.join(root, '.config-test', 'hece'), { recursive: true })
    fs.writeFileSync(path.join(root, '.config-test', 'hece', 'preferences.yaml'), 'delegate:\n  orchestrator: sonnet\n')
    const r = runCli(['--no-frame'], { root, env: { HECE_CLAUDE_BIN: fake } })
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toContain('sonnet')
  })
})

describe('pluginRoot', () => {
  it('points at a directory containing .claude-plugin/plugin.json', () => {
    expect(fs.existsSync(path.join(pluginRoot(), '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(pluginRoot()).toBe(REPO_ROOT)
  })
})

describe('hece launch (process)', () => {
  it('runs claude with --plugin-dir and no other args when given none', () => {
    const r = launch([])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT])
  })

  it('passes claude flags straight through', () => {
    const r = launch(['-c', '--model', 'sonnet'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, '-c', '--model', 'sonnet'])
  })

  it('--no-frame runs Claude directly and drops the flag', () => {
    const r = launch(['--no-frame', '-c'])
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, '-c'])
  })

  it('--no-frame is dropped wherever it appears', () => {
    const r = launch(['-c', '--no-frame'])
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, '-c'])
  })

  it('passes a positional prompt through', () => {
    const r = launch(['fix the bug'])
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, 'fix the bug'])
  })

  it('passes an unknown word through to claude', () => {
    const r = launch(['nope'])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, 'nope'])
  })

  it("exits with claude's exit code", () => {
    const r = launch([], { FAKE_EXIT: '3' })
    expect(r.status).toBe(3)
  })

  it('reports a missing claude binary and exits 1', () => {
    const r = launch([], { HECE_CLAUDE_BIN: '/nonexistent/claude-bin' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not find')
  })

  it('marks the Claude process as a hece session (the window runs this same path via --no-frame)', () => {
    launch([], { HECE_SESSION: '' })
    expect(fs.readFileSync(marker, 'utf8')).toBe('1')
    launch(['--no-frame'])
    expect(fs.readFileSync(marker, 'utf8')).toBe('1')
  })

  it('prints usage for help without running claude', () => {
    const r = launch(['help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('usage: hece')
    expect(fs.existsSync(marker)).toBe(false)
  })
})
