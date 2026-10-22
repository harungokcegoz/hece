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
  describe('walking up from a subfolder', () => {
    const walk = (cwd: string) => resolveRoot({}, undefined, { walkUp: true, cwd })
    it('finds the nearest folder containing .hece', () => {
      const nested = path.join(dir, 'src', 'deep')
      fs.mkdirSync(nested, { recursive: true })
      fs.mkdirSync(path.join(dir, '.hece'))
      expect(walk(nested)).toBe(dir)
      fs.mkdirSync(path.join(dir, 'src', '.hece'))
      expect(walk(nested)).toBe(path.join(dir, 'src'))
    })
    it('stays at cwd when no .hece is found', () => {
      const nested = path.join(dir, 'src')
      fs.mkdirSync(nested)
      expect(walk(nested)).toBe(nested)
    })
    it('stops at the git root, even if an outer folder has .hece', () => {
      const nested = path.join(dir, 'repo', 'src')
      fs.mkdirSync(nested, { recursive: true })
      fs.mkdirSync(path.join(dir, 'repo', '.git'))
      fs.mkdirSync(path.join(dir, '.hece'))
      expect(walk(nested)).toBe(nested)
    })
    it('still finds .hece in the git root itself', () => {
      const nested = path.join(dir, 'src')
      fs.mkdirSync(nested)
      fs.mkdirSync(path.join(dir, '.git'))
      fs.mkdirSync(path.join(dir, '.hece'))
      expect(walk(nested)).toBe(dir)
    })
    it('never climbs to the home folder, which may hold an unrelated .hece', () => {
      const home = path.join(dir, 'home')
      const nested = path.join(home, 'scratch', 'x')
      fs.mkdirSync(nested, { recursive: true })
      fs.mkdirSync(path.join(home, '.hece'))
      expect(resolveRoot({}, undefined, { walkUp: true, cwd: nested, home })).toBe(nested)
      // started in the home folder itself, its own .hece still counts
      expect(resolveRoot({}, undefined, { walkUp: true, cwd: home, home })).toBe(home)
    })
    it('ignores a .hece file that is not a folder', () => {
      const nested = path.join(dir, 'src')
      fs.mkdirSync(nested)
      fs.writeFileSync(path.join(dir, '.hece'), '')
      expect(walk(nested)).toBe(nested)
    })
    it('does not walk when HECE_ROOT or CLAUDE_PROJECT_DIR is set, or without walkUp', () => {
      const nested = path.join(dir, 'src')
      fs.mkdirSync(nested)
      fs.mkdirSync(path.join(dir, '.hece'))
      expect(resolveRoot({ HECE_ROOT: '/a' }, undefined, { walkUp: true, cwd: nested })).toBe('/a')
      expect(resolveRoot({ CLAUDE_PROJECT_DIR: '/b' }, undefined, { walkUp: true, cwd: nested })).toBe('/b')
      expect(resolveRoot({}, undefined, { cwd: nested })).toBe(nested)
    })
  })
  it('puts state under .hece/state', () => {
    const p = statePaths('/p')
    expect(p.flow).toBe(path.join('/p', '.hece', 'state', 'flow.json'))
    expect(p.captures).toBe(path.join('/p', '.hece', 'state', 'captures'))
  })
})
