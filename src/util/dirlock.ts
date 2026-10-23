import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Synchronous mkdir lock, safe across processes. API:
 *   withDirLock(lockPath, fn, { timeoutMs?, staleMs? }) -> { ran: true, value } | { ran: false }
 * Waits up to timeoutMs for the lock; when it cannot be had, fn is skipped without an error. The lock directory
 * holds an `owner` file "pid:token". A lock is stale when its holder is dead or it is older than staleMs.
 * Takeover and release only remove a lock whose owner is the one inspected or the one we wrote, checked under a
 * guard directory so nobody deletes a lock another process just acquired.
 * Callers must treat `ran: false` as a visible failure (report it); never as "nothing to do".
 */
export interface DirLockOptions {
  /** how long to wait for a busy lock before giving up */
  timeoutMs?: number
  /** a lock older than this is taken over even if its holder looks alive */
  staleMs?: number
}

const TIMEOUT_MS = 3000
const STALE_MS = 10_000

const sleep = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** the raw `pid:token` content of a lock, or undefined when missing or not written yet */
export function lockOwner(lock: string): string | undefined {
  try {
    return fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

function ownerPid(owner: string | undefined): number | undefined {
  const pid = Number(owner?.split(':')[0])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function isOld(p: string, staleMs: number): boolean | undefined {
  try {
    return Date.now() - fs.statSync(p).mtimeMs > staleMs
  } catch {
    return undefined // gone already
  }
}

/** The owner string of the lock when it is stale, or undefined when it is live or gone. '' means stale with no owner yet. */
function staleOwner(lock: string, staleMs: number): string | undefined {
  const old = isOld(lock, staleMs)
  if (old === undefined) return undefined
  const owner = lockOwner(lock)
  if (old) return owner ?? ''
  // no owner yet means the holder is between mkdir and writing it: not stale until it is old
  const pid = ownerPid(owner)
  return pid !== undefined && isDead(pid) ? owner : undefined
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // leftover under a unique name is harmless
  }
}

/**
 * Runs `fn` while holding the short-lived guard directory `${lock}.takeover`. Takeover and release both go
 * through it, so nobody can move or delete a lock while another process is judging it. Returns undefined when
 * the guard is busy (a crashed holder's old guard is cleared for the next pass).
 */
function underGuard<T>(lock: string, staleMs: number, fn: () => T): { value: T } | undefined {
  const guard = `${lock}.takeover`
  try {
    fs.mkdirSync(guard)
  } catch {
    if (isOld(guard, staleMs)) removeDir(guard)
    return undefined
  }
  try {
    return { value: fn() }
  } finally {
    removeDir(guard)
  }
}

/** Renames the lock to a unique name and deletes it. Only call under the guard. */
function removeLock(lock: string): boolean {
  const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(lock, aside)
  } catch {
    return false
  }
  removeDir(aside)
  return true
}

/**
 * Removes the lock only if it is still stale and still has the owner string `expected` inspected earlier
 * ('' for none). Both are re-checked under the guard: an ownerless lock matches '' too, so comparing owner
 * strings alone would let a waiter delete a lock another waiter just acquired. Returns whether it was removed.
 */
export function takeOverStale(lock: string, expected: string, staleMs: number = STALE_MS): boolean {
  const r = underGuard(lock, staleMs, () => staleOwner(lock, staleMs) === expected && removeLock(lock))
  return r?.value === true
}

/** Removes the lock only if `owner` is still the one inside it. Gives up (the lock goes stale by age) if the guard stays busy. */
function releaseLock(lock: string, owner: string, staleMs: number): void {
  const until = Date.now() + 500
  for (;;) {
    const r = underGuard(lock, staleMs, () => {
      if (lockOwner(lock) === owner) removeLock(lock)
    })
    if (r || Date.now() >= until) return
    sleep(10)
  }
}

/** Best-effort removal of `.stale-*` and `.takeover` leftovers from crashed processes, once older than staleMs. */
function cleanLeftovers(lock: string, staleMs: number): void {
  try {
    const dir = path.dirname(lock)
    const base = path.basename(lock)
    for (const name of fs.readdirSync(dir)) {
      if (name === `${base}.takeover` || name.startsWith(`${base}.stale-`)) {
        const p = path.join(dir, name)
        if (isOld(p, staleMs)) removeDir(p)
      }
    }
  } catch {
    // best effort
  }
}

export function withDirLock<T>(lock: string, fn: () => T, o: DirLockOptions = {}): { ran: true; value: T } | { ran: false } {
  const deadline = Date.now() + (o.timeoutMs ?? TIMEOUT_MS)
  const staleMs = o.staleMs ?? STALE_MS
  const mine = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`
  let attempt = 0
  cleanLeftovers(lock, staleMs)
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ran: false }
      const stale = staleOwner(lock, staleMs)
      if (stale !== undefined && takeOverStale(lock, stale, staleMs)) continue
      if (Date.now() >= deadline) return { ran: false }
      sleep(25 + (attempt++ % 3) * 12)
    }
  }
  try {
    try {
      fs.writeFileSync(path.join(lock, 'owner'), mine)
    } catch {
      // without an owner the lock still works; it just goes stale by age
    }
    return { ran: true, value: fn() }
  } finally {
    // a fit that outlived staleMs may have lost its lock to a newcomer: leave theirs alone
    releaseLock(lock, mine, staleMs)
  }
}
