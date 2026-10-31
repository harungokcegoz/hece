import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { systemOnPath, runChecks, formatChecks, failed, installedPlugins, type DoctorDeps } from '../../src/doctor/main.js'
import { runCli, tmpProject } from '../helpers.js'

const HOOKS = '{"hooks":{"Stop":[{"hooks":[{"command":"node \\"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\\" hook"}]}]}}'
const PLUGIN = '{"mcpServers":{"hece":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/cli.js","mcp"]}}}'
const good = (o: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v22.1.0', onPath: () => true, exists: () => true,
  read: (f) => (f.endsWith('hooks.json') ? HOOKS : PLUGIN),
  plugins: new Set(['superpowers', 'ponytail']), prefsErrors: [], pkgRoot: '/p', optimize: 'ponytail', ...o,
})

describe('runChecks', () => {
  it('all green gives eight ok checks', () => {
    const c = runChecks(good())
    expect(c).toHaveLength(8)
    expect(c.every((x) => x.ok)).toBe(true)
  })
  it('missing superpowers', () => {
    const c = runChecks(good({ plugins: new Set(['ponytail']) }))
    expect(c[4]).toMatchObject({ ok: false, fix: '/plugin install superpowers@claude-plugins-official' })
  })
  it('caveman not installed', () => {
    const c = runChecks(good({ optimize: 'caveman' }))
    expect(c[5].ok).toBe(false)
    expect(c[5].fix).toContain('/plugin install caveman@caveman')
  })
  it('unreadable plugin list', () => {
    expect(runChecks(good({ plugins: null }))[4].fix).toContain("couldn't read Claude Code's plugin list")
  })
  it('each prefs error gets its own indented line', () => {
    const c = runChecks(good({ prefsErrors: ['one', 'two'] }))
    expect(formatChecks(c)).toContain('✗ preferences\n  one\n  two\n')
  })
  it('plugin wiring must point at dist/cli.js and parse', () => {
    const wiring = (o: Partial<DoctorDeps>) => runChecks(good(o))[7]
    expect(wiring({}).ok).toBe(true)
    expect(wiring({ read: (f) => (f.endsWith('hooks.json') ? '{"hooks":{}}' : PLUGIN) }).ok).toBe(false)
    expect(wiring({ read: (f) => (f.endsWith('hooks.json') ? HOOKS : '{"mcpServers":{}}') }).ok).toBe(false)
    const bad = wiring({ read: (f) => (f.endsWith('hooks.json') ? '{oops' : PLUGIN) })
    expect(bad.ok).toBe(false)
    expect(bad.fix).toContain('hooks.json')
  })
  it('plugin wiring on real temp dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-wire-'))
    fs.mkdirSync(path.join(root, '.claude-plugin'))
    fs.mkdirSync(path.join(root, 'hooks'))
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), PLUGIN)
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{nope')
    const real = { exists: fs.existsSync, read: (f: string) => fs.readFileSync(f, 'utf8'), pkgRoot: root }
    expect(runChecks(good(real))[7]).toMatchObject({ ok: false, fix: expect.stringContaining('not valid JSON') })
    fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), HOOKS)
    expect(runChecks(good(real))[7].ok).toBe(true)
  })
  it('old node fails', () => {
    expect(runChecks(good({ nodeVersion: 'v18.20.0' }))[0].ok).toBe(false)
  })
  it('tmux is optional', () => {
    const c = runChecks(good({ onPath: (b) => b !== 'tmux' }))
    expect(c[1]).toMatchObject({ ok: false, optional: true })
  })
})

describe('formatChecks', () => {
  it('marks and indents fixes', () => {
    const out = formatChecks([{ ok: true, label: 'a' }, { ok: false, label: 'b', fix: 'do x' }])
    expect(out).toBe("✓ a\n✗ b\n  do x\nClaude Code's own check: claude doctor\n")
  })
})

describe('failed', () => {
  it('ignores optional checks', () => {
    expect(failed(runChecks(good({ onPath: (b) => b !== 'tmux' })))).toBe(false)
    expect(failed(runChecks(good({ nodeVersion: 'v18.0.0' })))).toBe(true)
  })
})

describe('installedPlugins', () => {
  it('reads names before @', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-cc-'))
    fs.mkdirSync(path.join(dir, 'plugins'))
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'ponytail@ponytail': {} } }))
    expect(installedPlugins({ CLAUDE_CONFIG_DIR: dir })).toEqual(new Set(['ponytail']))
    expect(installedPlugins({ CLAUDE_CONFIG_DIR: path.join(dir, 'nope') })).toBeNull()
  })
  it('a readable file of the wrong shape is an empty set, not unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-cc-'))
    fs.mkdirSync(path.join(dir, 'plugins'))
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), '{"version":2}')
    expect(installedPlugins({ CLAUDE_CONFIG_DIR: dir })).toEqual(new Set())
  })
})

describe('hece doctor', () => {
  it('marks tmux and ends with the claude doctor line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-doc-'))
    const fake = path.join(dir, 'claude')
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(fake, 0o755)
    fs.mkdirSync(path.join(dir, 'plugins'))
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'superpowers@x': {}, 'ponytail@ponytail': {} } }))
    const r = runCli(['doctor'], { root: tmpProject(), env: { PATH: dir, CLAUDE_CONFIG_DIR: dir } })
    expect(r.stdout.endsWith("Claude Code's own check: claude doctor\n")).toBe(true)
    expect(r.stdout).toContain('✗ tmux')
  })
})

describe('systemOnPath', () => {
  it('finds an executable on PATH without running it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-path-'))
    fs.writeFileSync(path.join(dir, 'fakebin-x'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'plain-x'), '', { mode: 0o644 })
    const old = process.env.PATH
    process.env.PATH = dir
    try {
      expect(systemOnPath('fakebin-x')).toBe(true)
      expect(systemOnPath('plain-x')).toBe(false)
      expect(systemOnPath('nope-x')).toBe(false)
    } finally { process.env.PATH = old }
  })
  it('honours HECE_CLAUDE_BIN and HECE_TMUX_BIN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-path-'))
    const fake = path.join(dir, 'myclaude')
    fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    const old = { ...process.env }
    process.env.PATH = path.join(dir, 'empty')
    try {
      expect(systemOnPath('claude')).toBe(false)
      process.env.HECE_CLAUDE_BIN = fake
      process.env.HECE_TMUX_BIN = fake
      expect(systemOnPath('claude')).toBe(true)
      expect(systemOnPath('tmux')).toBe(true)
      process.env.HECE_TMUX_BIN = path.join(dir, 'nope')
      expect(systemOnPath('tmux')).toBe(false)
    } finally { process.env = old }
  })
})
