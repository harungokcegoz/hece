import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson, writeJsonAtomic, appendEvent, readEvents, StateError } from '../../src/state/store.js'
import { statePaths, resolveRoot } from '../../src/state/paths.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-'))
})

describe('readJson', () => {
  it('returns the fallback when the file is missing', () => {
    expect(readJson(path.join(dir, 'nope.json'), { a: 1 })).toEqual({ a: 1 })
  })
  it('throws StateError on invalid JSON instead of silently resetting', () => {
    const f = path.join(dir, 'bad.json')
    fs.writeFileSync(f, '{oops')
    expect(() => readJson(f, {})).toThrow(StateError)
  })
})

describe('writeJsonAtomic', () => {
  it('creates parent dirs, writes JSON, and leaves no temp files', () => {
    const f = path.join(dir, 'a', 'b', 'x.json')
    writeJsonAtomic(f, { n: 1 })
    expect(readJson(f, null)).toEqual({ n: 1 })
    expect(fs.readdirSync(path.dirname(f))).toEqual(['x.json'])
  })
})

describe('events', () => {
  it('appends and reads events, skipping bad and truncated lines', () => {
    const f = path.join(dir, 'events.jsonl')
    appendEvent(f, { at: 1, event: 'a' })
    fs.appendFileSync(f, 'not json\n{"at":2,"event":"b"}\n{"at":3,"ev')
    expect(readEvents(f).map((e) => e.event)).toEqual(['a', 'b'])
  })
  it('returns [] when the log does not exist', () => {
    expect(readEvents(path.join(dir, 'none.jsonl'))).toEqual([])
  })
})

describe('paths', () => {
  it('prefers HECE_ROOT, then CLAUDE_PROJECT_DIR, then the payload cwd', () => {
    expect(resolveRoot({ HECE_ROOT: '/a', CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/a')
    expect(resolveRoot({ CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/b')
    expect(resolveRoot({}, '/c')).toBe('/c')
  })
  it('puts state under .hece/state', () => {
    const p = statePaths('/p')
    expect(p.flow).toBe(path.join('/p', '.hece', 'state', 'flow.json'))
    expect(p.captures).toBe(path.join('/p', '.hece', 'state', 'captures'))
  })
})
