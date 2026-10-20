import { describe, it, expect } from 'vitest'
import { frameName, shellQuote, frameDecision, openFrame, FrameDeps } from '../../src/frame/main.js'

const tty = { stdinTTY: true, stdoutTTY: true, env: {}, tmuxAvailable: true }

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
})

describe('helpers', () => {
  it('names the frame after the project and quotes safely', () => {
    expect(frameName('/a/b')).toMatch(/^hece-[0-9a-f]{8}$/)
    expect(frameName('/a/b')).toBe(frameName('/a/b'))
    expect(frameName('/a/b')).not.toBe(frameName('/a/c'))
    expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node')
    expect(shellQuote('/My Project/x')).toBe("'/My Project/x'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

function fake(existing = false) {
  const calls: string[][] = []
  let n = 0
  const deps: FrameDeps = {
    tmux: (args) => {
      calls.push(args)
      if (args.includes('has-session')) return { status: existing ? 0 : 1, stdout: '' }
      return { status: 0, stdout: args.includes('-P') ? `%${n++}\n` : '' }
    },
    attach: (args) => {
      calls.push(['ATTACH', ...args])
      return 0
    },
  }
  return { calls, deps }
}

const opts = {
  root: '/My Project',
  claudeArgv: ['-c'],
  layout: { left: 'activity' as const, right: 'flow' as const },
  node: '/usr/bin/node',
  cli: '/h/dist/cli.js',
  tmuxBin: 'tmux',
}

describe('openFrame', () => {
  it('builds the three panes around Claude and attaches', () => {
    const { calls, deps } = fake()
    expect(openFrame(opts, deps)).toBe(0)
    const name = frameName('/My Project')
    expect(calls.every((c) => c[0] === 'ATTACH' || (c[0] === '-L' && c[1] === name))).toBe(true)
    const newSession = calls.find((c) => c.includes('new-session'))!
    expect(newSession).toContain('/My Project')
    expect(newSession[newSession.length - 1]).toBe(`/usr/bin/node /h/dist/cli.js --no-frame -c; tmux -L ${name} kill-server`)
    expect(calls.find((c) => c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel activity')
    expect(calls.find((c) => c.includes('split-window') && !c.includes('-hb'))!.at(-1)).toBe('/usr/bin/node /h/dist/cli.js panel flow')
    expect(calls).toContainEqual(['-L', name, 'bind', '-n', 'F1', 'select-pane', '-t', '%1'])
    expect(calls).toContainEqual(['-L', name, 'bind', '-n', 'F2', 'select-pane', '-t', '%0'])
    expect(calls).toContainEqual(['-L', name, 'bind', '-n', 'F3', 'select-pane', '-t', '%2'])
    expect(calls.at(-1)).toEqual(['ATTACH', '-L', name, 'attach', '-t', name])
  })

  it('skips a side set to none', () => {
    const { calls, deps } = fake()
    openFrame({ ...opts, layout: { left: 'none', right: 'flow' } }, deps)
    expect(calls.some((c) => c.includes('-hb'))).toBe(false)
    expect(calls.filter((c) => c.includes('split-window'))).toHaveLength(1)
  })

  it('reattaches to an open window instead of starting a second Claude', () => {
    const { calls, deps } = fake(true)
    openFrame(opts, deps)
    expect(calls.some((c) => c.includes('new-session'))).toBe(false)
    expect(calls.at(-1)![0]).toBe('ATTACH')
  })
})
