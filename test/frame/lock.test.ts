import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withFitLock, fitLockPath } from '../../src/frame/lock.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hece-lock-'))

describe('withFitLock', () => {
  it('acquires, runs and releases', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    const r = withFitLock('hece-abc', () => {
      expect(fs.existsSync(lock)).toBe(true)
      expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8')).toBe(String(process.pid))
      return 7
    }, { dir })
    expect(r).toEqual({ ran: true, value: 7 })
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('takes over a lock whose holder is dead', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), '999999999')
    const r = withFitLock('hece-abc', () => 'ok', { dir, timeoutMs: 500 })
    expect(r).toEqual({ ran: true, value: 'ok' })
    expect(fs.existsSync(lock)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('takes over a lock that is older than the limit, even if its holder lives', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    const r = withFitLock('hece-abc', () => 'ok', { dir, timeoutMs: 500 })
    expect(r).toEqual({ ran: true, value: 'ok' })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('releases the lock when the function throws', () => {
    const dir = tmp()
    expect(() => withFitLock('hece-abc', () => { throw new Error('boom') }, { dir })).toThrow('boom')
    expect(fs.existsSync(fitLockPath('hece-abc', dir))).toBe(false)
  })

  it('gives up silently when a live holder keeps the lock', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    let ran = false
    const r = withFitLock('hece-abc', () => { ran = true }, { dir, timeoutMs: 150 })
    expect(r).toEqual({ ran: false })
    expect(ran).toBe(false)
    expect(fs.existsSync(lock)).toBe(true)
  })

  it('names the lock after the user and the window', () => {
    expect(fitLockPath('hece-abc')).toBe(path.join(os.tmpdir(), `hece-${process.getuid?.() ?? 'u'}-hece-abc.fitlock`))
  })
})
