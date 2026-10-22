// Runs one fitFrame against the fake tmux in $FAKE_TMUX_BIN, like a tmux hook would.
import { spawnSync } from 'node:child_process'
import { fitFrame } from '../../../src/frame/main.js'

const bin = process.env.FAKE_TMUX_BIN!
const code = fitFrame(
  { root: process.env.FIT_ROOT!, layout: { left: 'activity', right: 'flow' }, node: 'node', cli: '/h/dist/cli.js' },
  {
    tmux: (args) => {
      const r = spawnSync('node', [bin, ...args], { encoding: 'utf8' })
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    attach: () => 0,
  },
)
process.exitCode = code
