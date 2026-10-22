import os from 'node:os'
import path from 'node:path'
import { withDirLock } from '../util/dirlock.js'

export interface LockOptions {
  /** where the lock lives; defaults to the temp folder */
  dir?: string
  /** how long to wait for a busy lock before giving up */
  timeoutMs?: number
  /** a lock older than this is taken over even if its holder looks alive */
  staleMs?: number
}

export function fitLockPath(name: string, dir: string = os.tmpdir()): string {
  return path.join(dir, `hece-${process.getuid?.() ?? 'u'}-${name}.fitlock`)
}

/**
 * Runs fn while holding a per-window lock, waiting up to timeoutMs for it. A lock whose holder died, or that
 * is older than staleMs, is taken over. When the lock cannot be had, fn is skipped without an error: the next
 * hook event tries again.
 */
export function withFitLock<T>(name: string, fn: () => T, o: LockOptions = {}): { ran: true; value: T } | { ran: false } {
  return withDirLock(fitLockPath(name, o.dir), fn, o)
}
