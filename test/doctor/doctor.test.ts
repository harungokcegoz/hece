import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runChecks, formatChecks, failed, installedPlugins, type DoctorDeps } from '../../src/doctor/main.js'
import { runCli, tmpProject } from '../helpers.js'

const good = (o: Partial<DoctorDeps> = {}): DoctorDeps => ({
  nodeVersion: 'v22.1.0', onPath: () => true, exists: () => true,
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
