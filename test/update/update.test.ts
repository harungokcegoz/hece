import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { update, STEPS, type Run } from '../../src/update/main.js'

const tmp = (git: boolean): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-update-'))
  if (git) fs.mkdirSync(path.join(d, '.git'))
  return d
}

describe('update', () => {
  it('runs pull, install, build in order in the package root', () => {
    const root = tmp(true)
    const calls: string[][] = []
    const exec: Run = (cmd, args, cwd) => { calls.push([cwd, cmd, ...args]); return 0 }
    expect(update(root, exec, () => {})).toBe(0)
    expect(calls).toEqual(STEPS.map((s) => [root, ...s]))
  })
  it('stops at the first failing step and returns its code', () => {
    const calls: string[] = []
    const exec: Run = (cmd, args) => { calls.push(args[0]); return args[0] === 'install' ? 7 : 0 }
    let msg = ''
    expect(update(tmp(true), exec, (s) => { msg += s })).toBe(7)
    expect(calls).toEqual(['pull', 'install'])
    expect(msg).toContain('npm install` failed (exit 7)')
  })
  it('points a non-git install at the release page', () => {
    let msg = ''
    expect(update(tmp(false), () => { throw new Error('must not run') }, (s) => { msg += s })).toBe(1)
    expect(msg).toContain('releases/latest')
  })
})
