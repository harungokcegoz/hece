import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface LockOptions {
  /** where the lock lives; defaults to the temp folder */
  dir?: string
  /** how long to wait for a busy lock before giving up */
  timeoutMs?: number
  /** a lock older than this is taken over even if its holder looks alive */
  staleMs?: number
}

const TIMEOUT_MS = 3000
const STALE_MS = 10_000

export function fitLockPath(name: string, dir: string = os.tmpdir()): string {
  return path.join(dir, `hece-${process.getuid?.() ?? 'u'}-${name}.fitlock`)
}

const sleep = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function holderPid(lock: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function isStale(lock: string, staleMs: number): boolean {
  let age: number
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs
  } catch {
    return false // gone already: the next mkdir will tell
  }
  if (age > staleMs) return true
  // no pid yet means the holder is between mkdir and writing it: not stale until it is old
  const pid = holderPid(lock)
  return pid !== undefined && isDead(pid)
}

// Moves a stale lock aside and deletes it. Losing the rename means another waiter took it over first.
function takeOver(lock: string): void {
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`
  try {
    fs.renameSync(lock, aside)
  } catch {
    return
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true })
  } catch {
    // leftover under a unique name is harmless
  }
}

/**
 * Runs fn while holding a per-window lock, waiting up to timeoutMs for it. A lock whose holder died, or that
 * is older than staleMs, is taken over. When the lock cannot be had, fn is skipped without an error: the next
 * hook event tries again.
 */
export function withFitLock<T>(name: string, fn: () => T, o: LockOptions = {}): { ran: true; value: T } | { ran: false } {
  const lock = fitLockPath(name, o.dir)
  const deadline = Date.now() + (o.timeoutMs ?? TIMEOUT_MS)
  const staleMs = o.staleMs ?? STALE_MS
  let attempt = 0
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ran: false }
      if (isStale(lock, staleMs)) {
        takeOver(lock)
        continue
      }
      if (Date.now() >= deadline) return { ran: false }
      sleep(25 + (attempt++ % 3) * 12)
    }
  }
  try {
    try {
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
    } catch {
      // without a pid the lock still works; it just goes stale by age
    }
    return { ran: true, value: fn() }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}
