import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson, writeJsonAtomic, appendEvent, readEvents, StateError } from '../../src/state/store.js'
import { statePaths, resolveRoot } from '../../src/state/paths.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-'))
})

afterEach(() => vi.restoreAllMocks())

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
  it.each(['write', 'rename'])('removes the temporary file after %s fails and preserves existing state', stage => {
    const file = path.join(dir, 'state.json')
    writeJsonAtomic(file, { existing: true })
    const failure = Object.assign(new Error('state write denied'), { code: 'EACCES' })
    if (stage === 'write') {
      const write = fs.writeFileSync
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(temp => {
        write(temp, 'partial JSON')
        throw failure
      })
    } else {
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw failure })
    }
    expect(() => writeJsonAtomic(file, { replacement: true })).toThrow(failure)
    expect(readJson(file, null)).toEqual({ existing: true })
    expect(fs.readdirSync(dir)).toEqual(['state.json'])
  })

  it('reports the original write error even when temp cleanup also fails', () => {
    const file = path.join(dir, 'state.json')
    const failure = Object.assign(new Error('state write denied'), { code: 'EACCES' })
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw failure })
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('cleanup denied') })
    expect(() => writeJsonAtomic(file, { replacement: true })).toThrow(failure)
  })

  it('creates parent dirs, writes JSON, and leaves no temp files', () => {
    const f = path.join(dir, 'a', 'b', 'x.json')
    writeJsonAtomic(f, { n: 1 })
    expect(readJson(f, null)).toEqual({ n: 1 })
    expect(fs.readdirSync(path.dirname(f))).toEqual(['x.json'])
  })
})

describe('events', () => {
  it.each(['EACCES', 'EISDIR'])('surfaces %s instead of treating the event log as missing', code => {
    const failure = Object.assign(new Error('event log unreadable'), { code })
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw failure })
    expect(() => readEvents(path.join(dir, 'events.jsonl'))).toThrow(failure)
  })

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
