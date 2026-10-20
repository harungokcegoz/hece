import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { frameName, shellQuote, frameDecision, openFrame, FrameDeps } from '../../src/frame/main.js'

const tty = { stdinTTY: true, stdoutTTY: true, env: {}, tmuxAvailable: true, cliBuilt: true }

describe('frameDecision', () => {
  it('opens the window only in an interactive terminal with tmux', () => {
    expect(frameDecision([], tty)).toBe('frame')
    expect(frameDecision(['-c'], tty)).toBe('frame')
  })
  it('stays plain when not a terminal, inside tmux, or in print/info mode', () => {
    expect(frameDecision([], { ...tty, stdoutTTY: false })).toBe('plain')
    expect(frameDecision([], { ...tty, env: { TMUX: '/tmp/tmux-1/default,1,0' } })).toBe('plain')
    for (const a of ['-p', '--print', '--version', '-v', '--help', '-h']) expect(frameDecision([a, 'x'], tty)).toBe('plain')
  })
  it('falls back with a hint when tmux is missing', () => {
    expect(frameDecision([], { ...tty, tmuxAvailable: false })).toBe('plain-no-tmux')
  })
  it('falls back with a hint when the CLI is not built', () => {
    expect(frameDecision([], { ...tty, cliBuilt: false })).toBe('plain-not-built')
    // plain wins: no hint when the window would not have opened anyway
    expect(frameDecision(['-p', 'x'], { ...tty, cliBuilt: false })).toBe('plain')
  })
  it('stays plain for claude subcommands', () => {
    for (const a of ['doctor', 'update', 'install', 'config']) expect(frameDecision([a], tty)).toBe('plain')
    expect(frameDecision(['-c', 'doctor'], tty)).toBe('frame')
  })
})

describe('helpers', () => {
  it('names the frame after the project and quotes safely', () => {
    expect(frameName('/a/b')).toMatch(/^hece-[0-9a-f]{12}$/)
    expect(frameName('/a/b')).toBe(frameName('/a/b'))
    expect(frameName('/a/b')).not.toBe(frameName('/a/c'))
    expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node')
    expect(shellQuote('/My Project/x')).toBe("'/My Project/x'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

interface FakeOpts {
  existing?: boolean
  newSessionFails?: boolean
  hasAfterFail?: boolean
  emptyIdFor?: string // a command name whose -P output is empty
}

function fake(f: FakeOpts = {}) {
  const calls: string[][] = []
  const errs: string[] = []
  let n = 0
  let failedNew = false
  const deps: FrameDeps = {
    tmux: (args) => {
      calls.push(args)
      if (args.includes('has-session')) {
        const ok = failedNew ? f.hasAfterFail : f.existing
        return { status: ok ? 0 : 1, stdout: '', stderr: '' }
      }
      if (args.includes('new-session') && f.newSessionFails) {
        failedNew = true
        return { status: 1, stdout: '', stderr: 'boom' }
      }
      if (args.includes('-P')) {
        if (f.emptyIdFor && args.includes(f.emptyIdFor)) return { status: 0, stdout: '', stderr: '' }
        return { status: 0, stdout: `%${n++}\n`, stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
    attach: (args) => {
      calls.push(['ATTACH', ...args])
      return 0
    },
    err: (m) => errs.push(m),
  }
  return { calls, errs, deps }
}

const opts = {
  root: '/My Project',
  claudeArgv: ['-c'],
  layout: { left: 'activity' as const, right: 'flow' as const },
  node: '/usr/bin/node',
  cli: '/h/dist/cli.js',
  tmuxBin: 'tmux',
  columns: 200,
}

describe('openFrame', () => {
  it('builds the three panes around Claude and attaches', () => {
    const { calls, deps } = fake()
    expect(openFrame(opts, deps)).toBe(0)
    const name = frameName('/My Project')
    const pre = ['-L', name, '-f', '/dev/null']
    expect(calls.every((c) => c[0] === 'ATTACH' || (c[0] === '-L' && c[1] === name && c[2] === '-f' && c[3] === '/dev/null'))).toBe(true)
    const newSession = calls.find((c) => c.includes('new-session'))!
    expect(newSession).toContain('/My Project')
    const inner = `/usr/bin/node /h/dist/cli.js --no-frame -c; rc=$?; tmux -L ${name} -f /dev/null kill-server; exit $rc`
    expect(newSession[newSession.length - 1]).toBe(`/bin/sh -c '${inner}'`)
    expect(newSession[newSession.length - 1].startsWith("/bin/sh -c '")).toBe(true)
    expect(calls.find((c) => c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel activity')
    expect(calls.find((c) => c.includes('split-window') && !c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel flow')
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F2', 'select-pane', '-t', '%0'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
    expect(calls).toContainEqual([...pre, 'set', '-g', 'allow-set-title', 'off'])
    expect(calls).toContainEqual([...pre, 'set', '-g', 'automatic-rename', 'off'])
    expect(calls.at(-1)).toEqual(['ATTACH', '-L', name, '-f', '/dev/null', 'attach', '-t', `=${name}`])
  })

  it('checks for an open window with the exact session name', () => {
    const { calls, deps } = fake()
    openFrame(opts, deps)
    const name = frameName('/My Project')
    expect(calls[0]).toEqual(['-L', name, '-f', '/dev/null', 'has-session', '-t', `=${name}`])
  })

  it('skips a side set to none', () => {
    const { calls, deps } = fake()
    openFrame({ ...opts, layout: { left: 'none', right: 'flow' } }, deps)
    expect(calls.some((c) => c.includes('-hb'))).toBe(false)
    expect(calls.filter((c) => c.includes('split-window'))).toHaveLength(1)
  })

  it('reattaches to an open window instead of starting a second Claude', () => {
    const { calls, deps } = fake({ existing: true })
    openFrame(opts, deps)
    expect(calls.some((c) => c.includes('new-session'))).toBe(false)
    expect(calls.at(-1)![0]).toBe('ATTACH')
  })

  it('attaches when a parallel launch won the race for the session', () => {
    const { calls, deps, errs } = fake({ newSessionFails: true, hasAfterFail: true })
    expect(openFrame(opts, deps)).toBe(0)
    expect(calls.some((c) => c.includes('split-window'))).toBe(false)
    expect(calls.at(-1)![0]).toBe('ATTACH')
    expect(errs).toEqual([])
  })

  it('gives up with a message when tmux cannot start a session', () => {
    const { calls, deps, errs } = fake({ newSessionFails: true, hasAfterFail: false })
    expect(openFrame(opts, deps)).toBe(1)
    expect(errs.join('')).toContain('hece: could not start tmux (boom)')
    // has-session, new-session, has-session again, then nothing
    expect(calls).toHaveLength(3)
    expect(calls.some((c) => c[0] === 'ATTACH')).toBe(false)
  })

  it('tears the window down when a pane id comes back empty', () => {
    const { calls, deps, errs } = fake({ emptyIdFor: '-hb' })
    expect(openFrame(opts, deps)).toBe(1)
    expect(errs.join('')).toContain('hece:')
    expect(calls.at(-1)!.includes('kill-server')).toBe(true)
    expect(calls.some((c) => c[0] === 'ATTACH')).toBe(false)
    expect(calls.every((c) => !c.includes('-t') || c[c.indexOf('-t') + 1] !== '')).toBe(true)
  })

  it('tears the window down when the first pane id comes back empty', () => {
    const { calls, deps } = fake({ emptyIdFor: 'new-session' })
    expect(openFrame(opts, deps)).toBe(1)
    expect(calls.at(-1)!.includes('kill-server')).toBe(true)
    expect(calls.some((c) => c.includes('split-window'))).toBe(false)
  })

  it('drops side panels the terminal is too narrow for', () => {
    const run = (columns: number) => {
      const { calls, deps } = fake()
      openFrame({ ...opts, columns }, deps)
      return calls
    }
    const only = run(120)
    expect(only.some((c) => c.includes('-hb'))).toBe(false)
    expect(only.filter((c) => c.includes('split-window'))).toHaveLength(1)
    expect(only.find((c) => c.includes('split-window'))!.at(-1)).toContain('panel flow')
    expect(run(90).some((c) => c.includes('split-window'))).toBe(false)
    expect(run(0).filter((c) => c.includes('split-window'))).toHaveLength(2)
    expect(run(200).filter((c) => c.includes('split-window'))).toHaveLength(2)
  })

  it('produces a command /bin/sh can parse even with single quotes in paths', () => {
    const { calls, deps } = fake()
    openFrame({ ...opts, root: "/My 'Proj'", cli: "/My 'Proj'/dist/cli.js", claudeArgv: ["it's", '-c'] }, deps)
    const cmd = calls.find((c) => c.includes('new-session'))!.at(-1)!
    expect(cmd.startsWith("/bin/sh -c '")).toBe(true)
    const r = spawnSync('/bin/sh', ['-n', '-c', cmd])
    expect(r.status).toBe(0)
  })

  it('escapes # in the working directory', () => {
    const { calls, deps } = fake()
    openFrame({ ...opts, root: '/a#b/proj' }, deps)
    for (const c of calls.filter((c) => c.includes('new-session') || c.includes('split-window'))) {
      expect(c[c.indexOf('-c') + 1]).toBe('/a##b/proj')
    }
  })
})
