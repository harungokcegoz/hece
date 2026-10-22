import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpProject, seedFlow, runCli, testEnv, CLI } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { appendEvent } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, approve } from '../../src/flow/flow.js'
import { stripAnsi } from '../../src/panels/color.js'
import { readEventsTail, frameText } from '../../src/panels/main.js'

const size = { HECE_PANEL_WIDTH: '40', HECE_PANEL_HEIGHT: '20' }
const panel = (root: string, widget: string) => {
  const r = runCli(['panel', widget, '--once'], { root, env: size })
  return { ...r, text: stripAnsi(r.stdout) }
}

describe('readEventsTail', () => {
  const lineOf = (at: number) => JSON.stringify({ at, event: 'note', text: 'x' }) + '\n'
  const write = (text: string) => {
    const file = path.join(tmpProject(), 'events.jsonl')
    fs.writeFileSync(file, text)
    return file
  }

  it('keeps the first line when the window starts exactly on a line boundary', () => {
    const a = lineOf(1)
    const b = lineOf(2)
    const c = lineOf(3)
    const file = write(a + b + c)
    expect(readEventsTail(file, b.length + c.length).map((e) => e.at)).toEqual([2, 3])
  })

  it('still drops a first line that the window cuts in half', () => {
    const a = lineOf(1)
    const b = lineOf(2)
    const c = lineOf(3)
    const file = write(a + b + c)
    expect(readEventsTail(file, b.length + c.length + 5).map((e) => e.at)).toEqual([2, 3])
    expect(readEventsTail(file, c.length + 5).map((e) => e.at)).toEqual([3])
  })

  it('reads the whole file when it fits the window', () => {
    const file = write(lineOf(1) + lineOf(2))
    expect(readEventsTail(file, 10000).map((e) => e.at)).toEqual([1, 2])
  })

  it('returns nothing when the window holds no complete line', () => {
    const file = write(lineOf(1) + lineOf(2))
    expect(readEventsTail(file, 5)).toEqual([])
  })
})

describe('frameText', () => {
  it('never erases to the end of a line after drawing it, so the last column survives', () => {
    const text = frameText(['abcd', 'ef'], 5)
    expect(text).not.toContain('\x1b[K')
    expect(text).toBe('\x1b[2Kabcd\r\n\x1b[2Kef\r\n\x1b[J')
  })
  it('does not erase from the cursor after a full-width last row, nor scroll a full pane', () => {
    expect(frameText(['abcd', 'efgh'], 2)).toBe('\x1b[2Kabcd\r\n\x1b[2Kefgh')
    expect(frameText(['abcd'], 2)).not.toMatch(/efgh|abcd\x1b\[J/)
  })
})

describe('hece panel --once', () => {
  it('flow panel shows the real flow', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    const r = panel(root, 'flow')
    expect(r.status).toBe(0)
    expect(r.text).toContain('▸ Build')
    expect(r.text).toContain('▸ 1. Token model')
  })

  it('flow panel explains an empty project', () => {
    const r = panel(tmpProject(), 'flow')
    expect(r.text).toContain('No flow yet.')
    expect(r.text).not.toContain('home folder')
    expect(r.text).not.toMatch(/^hece$/m)
  })

  it('flow panel adds a tip in the home folder', () => {
    const home = tmpProject()
    const r = runCli(['panel', 'flow', '--once'], { root: home, env: { ...size, HECE_HOME: home } })
    expect(stripAnsi(r.stdout)).toContain("Tip: you're in your home folder.")
  })

  it('panels do not repeat the name the tmux border already shows', () => {
    const root = tmpProject()
    expect(panel(root, 'activity').text.split('\n')[0]).toBe("Nothing yet. Claude's steps")
    expect(panel(root, 'sessions').text.split('\n')[0]).toBe('none yet')
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    expect(panel(root, 'activity').text.split('\n')[0]).toContain('flow.json is unreadable')
  })

  it('activity panel speaks plain language and hides raw commands', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    const ev = statePaths(root).events
    appendEvent(ev, { at: 1, event: 'note', text: 'saving only a hash of the token', slice: 1 })
    appendEvent(ev, { at: 2, event: 'tool', tool: 'Bash', target: 'ls -la && find . -maxdepth 3', slice: 1 })
    appendEvent(ev, { at: 3, event: 'tool', tool: 'mcp__plugin_hece_hece__flow_get', target: '', slice: 1 })
    const r = panel(root, 'activity')
    expect(r.text).toContain('▸ Slice 1 · Token model')
    expect(r.text).toContain('Now: saving only a hash of the token')
    expect(r.text).toContain('· looking around the files')
    expect(r.text).not.toContain('maxdepth')
    expect(r.text).not.toContain('mcp__')
  })

  it('shows a message instead of crashing on a corrupt flow.json', () => {
    const root = tmpProject()
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    const r = panel(root, 'flow')
    expect(r.status).toBe(0)
    expect(r.text).toContain('⚠')
    expect(r.text).toContain('flow.json is unreadable')
    expect(r.text).not.toContain('No flow yet')
    expect(r.text).not.toContain(root)
  })

  it('activity panel also shows only the warning for a corrupt flow.json', () => {
    const root = tmpProject()
    fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
    fs.writeFileSync(statePaths(root).flow, '{oops')
    const r = panel(root, 'activity')
    expect(r.text).toContain('flow.json is unreadable')
    expect(r.text).not.toContain('Nothing yet')
  })

  describe('malformed state shapes', () => {
    const bad = (root: string, file: 'flow' | 'sessions' | 'agent', content: string) => {
      fs.mkdirSync(statePaths(root).stateDir, { recursive: true })
      fs.writeFileSync(statePaths(root)[file], content)
    }
    const friendly = (text: string, name: string) => {
      expect(text).toContain(`⚠ .hece/state/${name} is unreadable`)
      expect(text).toContain('Fix or delete it to continue.')
      expect(text).not.toMatch(/is not a function|Cannot read|undefined|TypeError/)
    }

    for (const content of ['{}', '[]', 'null', '"x"', '{"version":1,"phase":"nope","decisions":[],"plan":null,"currentSlice":null}', '{"version":1,"phase":"build","decisions":[],"plan":{"slices":{}},"currentSlice":null}']) {
      it(`flow.json = ${content} shows a friendly message on every flow-based panel`, () => {
        const root = tmpProject()
        bad(root, 'flow', content)
        for (const widget of ['flow', 'activity']) {
          const r = panel(root, widget)
          expect(r.status).toBe(0)
          friendly(r.text, 'flow.json')
        }
      })
    }

    for (const content of ['{}', '"x"', '[1]', '[{"sessionId":5}]', '{oops']) {
      it(`sessions.json = ${content} shows a friendly message`, () => {
        const root = tmpProject()
        bad(root, 'sessions', content)
        const r = runCli(['panel', 'sessions', '--once'], { root, env: { ...size, HECE_PANEL_WIDTH: '60' } })
        expect(r.status).toBe(0)
        friendly(stripAnsi(r.stdout), 'sessions.json')
      })
    }

    it('sessions.json warning is not truncated at the default 40-column pane', () => {
      const root = tmpProject()
      bad(root, 'sessions', '{}')
      const r = runCli(['panel', 'sessions', '--once'], { root, env: { ...size, HECE_PANEL_WIDTH: '40' } })
      const text = stripAnsi(r.stdout)
      expect(text).toContain('⚠ .hece/state/sessions.json')
      expect(text).toContain('is unreadable')
      expect(text).toContain('Fix or delete it to continue.')
      expect(text).not.toContain('…')
    })

    it('a bad agent.json is ignored when there is no flow', () => {
      const root = tmpProject()
      bad(root, 'agent', '{oops')
      const r = runCli(['panel', 'flow', '--once'], { root, env: { ...size, HECE_PANEL_WIDTH: '60' } })
      expect(stripAnsi(r.stdout)).not.toContain('agent.json')
    })

    for (const content of ['[]', '"x"', 'null', '{"idle":"yes"}', '{oops']) {
      it(`agent.json = ${content} shows a friendly message on the flow panel`, () => {
        const root = tmpProject()
        seedFlow(root, emptyFlow())
        bad(root, 'agent', content)
        const r = runCli(['panel', 'flow', '--once'], { root, env: { ...size, HECE_PANEL_WIDTH: '60' } })
        expect(r.status).toBe(0)
        friendly(stripAnsi(r.stdout), 'agent.json')
      })
    }
  })

  it('never prints more lines than the pane is tall', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    appendEvent(statePaths(root).events, { at: 1, event: 'note', text: 'hello', slice: 1 })
    for (const widget of ['flow', 'activity', 'sessions']) {
      const r = runCli(['panel', widget, '--once'], { root, env: { HECE_PANEL_WIDTH: '40', HECE_PANEL_HEIGHT: '2' } })
      expect(r.stdout.replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(2)
    }
  })

  it('still shows the newest event of a very large events.jsonl', () => {
    const root = tmpProject()
    let s = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: true }, 1)
    s = startSlice(approve(s, 2).state, 1, { guards: true }, 3)
    seedFlow(root, s)
    const ev = statePaths(root).events
    const lines: string[] = []
    for (let i = 0; i < 5000; i++) lines.push(JSON.stringify({ at: i, event: 'tool', tool: 'Bash', target: 'ls -la', slice: 1 }))
    lines.push(JSON.stringify({ at: 5001, event: 'note', text: 'newest marker', slice: 1 }))
    fs.writeFileSync(ev, lines.join('\n') + '\n')
    expect(fs.statSync(ev).size).toBeGreaterThan(256 * 1024)
    expect(panel(root, 'activity').text).toContain('Now: newest marker')
  })

  it('rejects an unknown widget', () => {
    const r = runCli(['panel', 'nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece panel')
  })

  it('the live loop ends by itself when its output is closed', async () => {
    const root = tmpProject()
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'panel', 'flow'], {
      env: testEnv(root, { HECE_PANEL_WIDTH: '40', HECE_PANEL_HEIGHT: '20' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
      // wait until the first frame is out and the panel has gone quiet (nothing changes, so nothing is written)
      await new Promise<void>((resolve) => {
        let quiet: NodeJS.Timeout | undefined
        child.stdout.on('data', () => {
          clearTimeout(quiet)
          quiet = setTimeout(resolve, 800)
        })
      })
      child.stdout.destroy()
      const result = await Promise.race([
        exited,
        new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 5000)),
      ])
      expect(result).toBe(0) // a clean stop, not a crash
    } finally {
      child.kill('SIGKILL')
    }
  }, 10000)
})
