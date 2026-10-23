import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withFitLock, fitLockPath } from '../../src/frame/lock.js'
import { takeOverStale, lockOwner } from '../../src/util/dirlock.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hece-lock-'))

describe('withFitLock', () => {
  it('acquires, runs and releases', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    const r = withFitLock('hece-abc', () => {
      expect(fs.existsSync(lock)).toBe(true)
      expect(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).toMatch(new RegExp(`^${process.pid}:[0-9a-f]{16}$`))
      return 7
    }, { dir })
    expect(r).toEqual({ ran: true, value: 7 })
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('takes over a lock whose holder is dead', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), '999999999:dead')
    const r = withFitLock('hece-abc', () => 'ok', { dir, timeoutMs: 500 })
    expect(r).toEqual({ ran: true, value: 'ok' })
    expect(fs.existsSync(lock)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('takes over a lock that is older than the limit, even if its holder lives', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:live`)
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
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:live`)
    let ran = false
    const r = withFitLock('hece-abc', () => { ran = true }, { dir, timeoutMs: 150 })
    expect(r).toEqual({ ran: false })
    expect(ran).toBe(false)
    expect(fs.existsSync(lock)).toBe(true)
  })

  it('names the lock after the user and the window', () => {
    expect(fitLockPath('hece-abc')).toBe(path.join(os.tmpdir(), `hece-${process.getuid?.() ?? 'u'}-hece-abc.fitlock`))
  })

  it('release leaves a lock that someone else now owns', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    withFitLock('hece-abc', () => {
      // simulate losing the lock by age: a newcomer takes it while we are still running
      fs.rmSync(lock, { recursive: true })
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:newcomer`)
    }, { dir })
    expect(lockOwner(lock)).toBe(`${process.pid}:newcomer`)
  })

  it('takeover with three waiters removes only the stale lock they inspected', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), '999999999:dead')
    // waiters A, B and C all inspected the same stale lock
    expect(takeOverStale(lock, '999999999:dead')).toBe(true)
    // a live holder takes the lock before B and C act on their stale view
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:live`)
    expect(takeOverStale(lock, '999999999:dead')).toBe(false)
    expect(takeOverStale(lock, '999999999:dead')).toBe(false)
    expect(lockOwner(lock)).toBe(`${process.pid}:live`)
    expect(fs.readdirSync(dir)).toEqual([path.basename(lock)])
  })

  it('does not take over while another waiter holds the takeover guard', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), '999999999:dead')
    fs.mkdirSync(`${lock}.takeover`)
    expect(takeOverStale(lock, '999999999:dead')).toBe(false)
    expect(fs.existsSync(lock)).toBe(true)
  })
  it('takeover refuses a fresh ownerless lock a first waiter just acquired', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    // W1 has taken over and mkdir'd; its owner file is not written yet. W2 still holds the stale view ''.
    fs.mkdirSync(lock)
    expect(takeOverStale(lock, '', 10_000)).toBe(false)
    expect(fs.existsSync(lock)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([path.basename(lock)])
  })

  it('takeover still removes an old ownerless lock', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    expect(takeOverStale(lock, '', 10_000)).toBe(true)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('takeover refuses when the owner changed even if the new lock is old', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, 'owner'), '999999999:other')
    expect(takeOverStale(lock, '999999999:dead')).toBe(false)
    expect(fs.existsSync(lock)).toBe(true)
  })

  it('release removes only the lock it owns, through the guard, leaving no leftovers', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    withFitLock('hece-abc', () => 1, { dir })
    expect(fs.readdirSync(dir)).toEqual([])
    // owned by a newcomer at release time while the guard is free
    withFitLock('hece-abc', () => {
      fs.rmSync(lock, { recursive: true })
      fs.mkdirSync(lock)
      fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}:newcomer`)
    }, { dir })
    expect(lockOwner(lock)).toBe(`${process.pid}:newcomer`)
    expect(fs.readdirSync(dir)).toEqual([path.basename(lock)])
  })

  it('cleans stale takeover leftovers older than the stale threshold, keeps fresh ones', () => {
    const dir = tmp()
    const lock = fitLockPath('hece-abc', dir)
    const oldStale = `${lock}.stale-1-aaaa`
    const freshStale = `${lock}.stale-1-bbbb`
    const oldGuard = `${lock}.takeover`
    for (const d of [oldStale, freshStale, oldGuard]) fs.mkdirSync(d)
    const old = new Date(Date.now() - 60_000)
    for (const d of [oldStale, oldGuard]) fs.utimesSync(d, old, old)
    expect(withFitLock('hece-abc', () => 'ok', { dir })).toEqual({ ran: true, value: 'ok' })
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(freshStale)])
  })
})
