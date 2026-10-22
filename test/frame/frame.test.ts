import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { frameName, shellQuote, tmuxQuote, sidesFor, fitFrame, isHomeRoot, homeNote, frameDecision, openFrame, FrameDeps } from '../../src/frame/main.js'

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
  it('quotes for the tmux command parser', () => {
    expect(tmuxQuote('a "b" $c \\d')).toBe('"a \\"b\\" \\$c \\\\d"')
    expect(tmuxQuote('plain')).toBe('"plain"')
  })
})

describe('sidesFor', () => {
  const layout = { left: 'activity' as const, right: 'flow' as const }
  it('drops the left panel first, then the right, to keep Claude wide enough', () => {
    expect(sidesFor(200, layout)).toEqual(layout)
    expect(sidesFor(120, layout)).toEqual({ left: 'none', right: 'flow' })
    expect(sidesFor(90, layout)).toEqual({ left: 'none', right: 'none' })
    expect(sidesFor(0, layout)).toEqual(layout)
  })
  it('keeps a side that is set to none as none', () => {
    expect(sidesFor(200, { left: 'none', right: 'flow' })).toEqual({ left: 'none', right: 'flow' })
  })
})

describe('home folder', () => {
  it('knows the home folder, also through a symlink, and falls back to the raw strings', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-home-'))
    const real = path.join(base, 'real')
    fs.mkdirSync(real)
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    expect(isHomeRoot(real, real)).toBe(true)
    expect(isHomeRoot(link, real)).toBe(true)
    expect(isHomeRoot(path.join(real, 'proj'), real)).toBe(false)
    expect(isHomeRoot('/nope/a', '/nope/a')).toBe(true)
    expect(isHomeRoot('/nope/a', '/nope/b')).toBe(false)
  })
  it('only has a note for the home folder', () => {
    expect(homeNote('/nope/a', '/nope/a')).toContain("you're in your home folder")
    expect(homeNote('/nope/a', '/nope/a')).toContain('~/.hece')
    expect(homeNote('/nope/a/p', '/nope/a')).toBe('')
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
    const pre = ['-L', name, '-f', '/dev/null', '-u']
    expect(calls.every((c) => c[0] === 'ATTACH' || (c[0] === '-L' && c[1] === name && c[2] === '-f' && c[3] === '/dev/null' && c[4] === '-u'))).toBe(true)
    const newSession = calls.find((c) => c.includes('new-session'))!
    expect(newSession).toContain('/My Project')
    const inner = `/usr/bin/node /h/dist/cli.js --no-frame -c; rc=$?; tmux -L ${name} -f /dev/null -u kill-server; exit $rc`
    expect(newSession[newSession.length - 1]).toBe(`/bin/sh -c '${inner}'`)
    expect(newSession[newSession.length - 1].startsWith("/bin/sh -c '")).toBe(true)
    expect(calls.find((c) => c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel activity')
    expect(calls.find((c) => c.includes('split-window') && !c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel flow')
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F2', 'select-pane', '-t', '%0'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
    expect(calls).toContainEqual([...pre, 'set', '-g', 'allow-set-title', 'off'])
    expect(calls).toContainEqual([...pre, 'set', '-g', 'automatic-rename', 'off'])
    expect(calls.at(-1)).toEqual(['ATTACH', '-L', name, '-f', '/dev/null', '-u', 'attach', '-t', `=${name}`])
  })

  it('checks for an open window with the exact session name', () => {
    const { calls, deps } = fake()
    openFrame(opts, deps)
    const name = frameName('/My Project')
    expect(calls[0]).toEqual(['-L', name, '-f', '/dev/null', '-u', 'has-session', '-t', `=${name}`])
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

describe('openFrame roles and hooks', () => {
  it('marks every pane with its role', () => {
    const { calls, deps } = fake()
    openFrame(opts, deps)
    const pre = ['-L', frameName('/My Project'), '-f', '/dev/null', '-u']
    expect(calls).toContainEqual([...pre, 'set', '-p', '-t', '%0', '@hece_role', 'middle'])
    expect(calls).toContainEqual([...pre, 'set', '-p', '-t', '%1', '@hece_role', 'left'])
    expect(calls).toContainEqual([...pre, 'set', '-p', '-t', '%2', '@hece_role', 'right'])
  })
  it('re-fits the layout on attach and resize through frame-fit', () => {
    const { calls, deps } = fake()
    openFrame(opts, deps)
    for (const hook of ['client-attached', 'client-resized']) {
      const c = calls.find((c) => c.includes('set-hook') && c.includes(hook))!
      const cmd = c.at(-1)!
      expect(cmd).toContain('run-shell -b')
      expect(cmd).toContain('frame-fit')
      expect(cmd).toContain("cd '/My Project'")
    }
  })
  it('installs the hooks even when the window starts without side panels', () => {
    const { calls, deps } = fake()
    openFrame({ ...opts, columns: 90 }, deps)
    expect(calls.filter((c) => c.includes('set-hook'))).toHaveLength(2)
  })
})

interface FitOpts {
  width?: string
  panes?: string // list-panes output
  failOn?: string
}

function fitFake(f: FitOpts = {}) {
  const calls: string[][] = []
  let n = 10
  const deps: FrameDeps = {
    tmux: (args) => {
      calls.push(args)
      if (f.failOn && args.includes(f.failOn)) return { status: 1, stdout: '', stderr: 'boom' }
      if (args.includes('display')) return { status: 0, stdout: `${f.width ?? '200'}\n`, stderr: '' }
      if (args.includes('list-panes')) return { status: 0, stdout: f.panes ?? '', stderr: '' }
      if (args.includes('-P')) return { status: 0, stdout: `%${n++}\n`, stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    attach: () => 0,
  }
  return { calls, deps }
}

const fitOpts = {
  root: '/My Project',
  layout: { left: 'activity' as const, right: 'flow' as const },
  node: '/usr/bin/node',
  cli: '/h/dist/cli.js',
}
const pre = ['-L', frameName('/My Project'), '-f', '/dev/null', '-u']
// trailing colon: a bare =name makes real tmux answer `display` with an empty string
const exact = `=${frameName('/My Project')}:`
const all3 = '%0 middle\n%1 left\n%2 right\n'

describe('fitFrame', () => {
  it('reads the window width and the pane roles', () => {
    const { calls, deps } = fitFake({ panes: '%0 middle\n' })
    fitFrame(fitOpts, deps)
    expect(calls[0]).toEqual([...pre, 'display', '-p', '-t', exact, '#{window_width}'])
    expect(calls[1]).toEqual([...pre, 'list-panes', '-t', exact, '-F', '#{pane_id} #{@hece_role}'])
  })

  it('adds the missing side panels when there is room', () => {
    const { calls, deps } = fitFake({ width: '200', panes: '%0 middle\n' })
    expect(fitFrame(fitOpts, deps)).toBe(0)
    const splits = calls.filter((c) => c.includes('split-window'))
    expect(splits).toHaveLength(2)
    expect(splits[0]).toContain('-hb')
    expect(splits[0].at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel activity')
    expect(splits[1]).toContain('-h')
    expect(splits[1]).not.toContain('-hb')
    expect(splits[1].at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel flow')
    for (const s of splits) expect(s[s.indexOf('-c') + 1]).toBe('/My Project')
    expect(calls).toContainEqual([...pre, 'set', '-p', '-t', '%10', '@hece_role', 'left'])
    expect(calls).toContainEqual([...pre, 'set', '-p', '-t', '%11', '@hece_role', 'right'])
    expect(calls).toContainEqual([...pre, 'select-pane', '-t', '%10', '-T', 'Activity'])
    expect(calls).toContainEqual([...pre, 'select-pane', '-t', '%11', '-T', 'Flow'])
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%10', '-x', '40'])
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%11', '-x', '36'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%10'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F2', 'select-pane', '-t', '%0'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%11'])
    // splits and role are set before anything is resized
    const firstResize = calls.findIndex((c) => c.includes('resize-pane'))
    expect(calls.findIndex((c) => c.includes('split-window'))).toBeLessThan(firstResize)
  })

  it('does not steal focus from the pane the user is in', () => {
    const { calls, deps } = fitFake({ panes: '%0 middle\n' })
    fitFrame(fitOpts, deps)
    for (const s of calls.filter((c) => c.includes('split-window'))) expect(s).toContain('-d')
  })

  it('removes the side panels when the terminal is too narrow', () => {
    const { calls, deps } = fitFake({ width: '90', panes: all3 })
    expect(fitFrame(fitOpts, deps)).toBe(0)
    expect(calls.some((c) => c.includes('split-window'))).toBe(false)
    expect(calls.filter((c) => c.includes('kill-pane'))).toEqual([
      [...pre, 'kill-pane', '-t', '%1'],
      [...pre, 'kill-pane', '-t', '%2'],
    ])
    expect(calls.some((c) => c.includes('resize-pane'))).toBe(false)
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%0'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%0'])
  })

  it('drops only the left panel at a medium width', () => {
    const { calls, deps } = fitFake({ width: '120', panes: all3 })
    fitFrame(fitOpts, deps)
    expect(calls.filter((c) => c.includes('kill-pane'))).toEqual([[...pre, 'kill-pane', '-t', '%1']])
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%2', '-x', '36'])
  })

  it('only resizes and binds when the layout already fits', () => {
    const { calls, deps } = fitFake({ width: '200', panes: all3 })
    expect(fitFrame(fitOpts, deps)).toBe(0)
    expect(calls.some((c) => c.includes('split-window') || c.includes('kill-pane'))).toBe(false)
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%1', '-x', '40'])
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%2', '-x', '36'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
  })

  it('changes nothing when the width is unknown or there is no middle pane', () => {
    for (const f of [{ width: 'abc', panes: all3 }, { width: '0', panes: all3 }, { width: '200', panes: '%1 left\n%2 right\n' }]) {
      const { calls, deps } = fitFake(f)
      expect(fitFrame(fitOpts, deps)).toBe(0)
      expect(calls.some((c) => c.includes('split-window') || c.includes('kill-pane') || c.includes('resize-pane'))).toBe(false)
    }
  })

  it('reports a tmux error with 1 and does not throw', () => {
    expect(fitFrame(fitOpts, fitFake({ panes: '%0 middle\n', failOn: 'split-window' }).deps)).toBe(1)
    expect(fitFrame(fitOpts, fitFake({ panes: all3, width: '90', failOn: 'kill-pane' }).deps)).toBe(1)
    const throwing: FrameDeps = { tmux: () => { throw new Error('gone') }, attach: () => 0 }
    expect(fitFrame(fitOpts, throwing)).toBe(1)
  })
})

describe('fitFrame duplicate panels', () => {
  it('keeps the first pane per role, kills the extras and rebinds to the survivors', () => {
    const { calls, deps } = fitFake({ width: '200', panes: '%0 middle\n%1 left\n%5 left\n%2 right\n%6 right\n%7 right\n' })
    expect(fitFrame(fitOpts, deps)).toBe(0)
    expect(calls.filter((c) => c.includes('kill-pane'))).toEqual([
      [...pre, 'kill-pane', '-t', '%5'],
      [...pre, 'kill-pane', '-t', '%6'],
      [...pre, 'kill-pane', '-t', '%7'],
    ])
    expect(calls.some((c) => c.includes('split-window'))).toBe(false)
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%1', '-x', '40'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
  })

  it('still resizes and rebinds when a kill-pane fails', () => {
    const { calls, deps } = fitFake({ width: '200', panes: '%0 middle\n%1 left\n%5 left\n%2 right\n', failOn: 'kill-pane' })
    fitFrame(fitOpts, deps)
    expect(calls).toContainEqual([...pre, 'resize-pane', '-t', '%2', '-x', '36'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual([...pre, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
  })

  it('still rebinds when removing a side for a narrow window fails', () => {
    const { calls, deps } = fitFake({ width: '90', panes: all3, failOn: 'kill-pane' })
    fitFrame(fitOpts, deps)
    expect(calls.filter((c) => c.includes('bind'))).toHaveLength(3)
  })
})

describe('fitFrame at the same time', () => {
  it('leaves exactly one pane per role when two run together', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-race-'))
    const state = path.join(dir, 'state.json')
    fs.writeFileSync(state, JSON.stringify({ next: 10, panes: [{ id: '%0', role: 'middle' }] }))
    const env = {
      ...process.env,
      TMPDIR: dir,
      FAKE_TMUX_STATE: state,
      FAKE_TMUX_BIN: path.resolve('test/frame/support/fake-tmux.mjs'),
      FIT_ROOT: '/race proj',
    }
    const run = () =>
      new Promise<number>((resolve) => {
        const p = spawn('node', ['--import', 'tsx', path.resolve('test/frame/support/fit-runner.ts')], { env, stdio: 'ignore' })
        p.on('exit', (c) => resolve(c ?? 1))
      })
    const codes = await Promise.all([run(), run()])
    expect(codes).toEqual([0, 0])
    const roles = (JSON.parse(fs.readFileSync(state, 'utf8')).panes as Array<{ role: string }>).map((p) => p.role).sort()
    expect(roles).toEqual(['left', 'middle', 'right'])
  })
})

describe('frame-fit command', () => {
  it('exits 0 and prints nothing even when tmux fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-fit-'))
    const bin = path.join(root, 'tmux')
    fs.writeFileSync(
      bin,
      '#!/bin/sh\ncase "$*" in\n*display*) echo 200;;\n*list-panes*) echo "%0 middle";;\n*) echo nope >&2; exit 1;;\nesac\n',
      { mode: 0o755 },
    )
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'frame-fit'], {
      encoding: 'utf8',
      env: { ...process.env, HECE_ROOT: root, HECE_TMUX_BIN: bin, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, '.c') },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })
})
