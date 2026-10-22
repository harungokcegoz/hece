import fs from 'node:fs'
import path from 'node:path'

export class StateError extends Error {}

export interface HeceEvent {
  at: number
  event: string
  [key: string]: unknown
}

export function readJson<T>(file: string, fallback: T): T {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new StateError(`hece: ${file} is not valid JSON`)
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // the write error below is the one to report; a leftover temp file is harmless
    }
    throw err
  }
}

export function appendEvent(file: string, ev: HeceEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(ev) + '\n')
}

export function readEvents(file: string): HeceEvent[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: HeceEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev && typeof ev.event === 'string') out.push(ev)
    } catch {
      // a crash mid-append can leave a truncated last line; skip it
    }
  }
  return out
}
