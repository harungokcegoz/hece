import fs from 'node:fs'
import YAML from 'yaml'
import { formatChecks, installedPlugins, systemChecks, systemOnPath } from '../doctor/main.js'
import type { Check } from '../doctor/main.js'
import { loadPrefs, prefsFiles } from '../prefs/load.js'
import { CUSTOM_KEYS, nextRaw, promoteToCustom, readGlobal, saveGlobal, startPrefs } from '../prefs/save.js'
import type { GlobalFile } from '../prefs/save.js'
import type { Prefs } from '../prefs/schema.js'
import { resolveRoot } from '../state/paths.js'
import { interactiveClaude } from '../frame/main.js'
import { PREFS_NAMES, SCREENS, setKey } from './screens.js'
import type { Screen, SetupContext } from './screens.js'
import { ask, terminalIo } from './tui.js'
import type { Io } from './tui.js'

export interface SetupDeps { io: Io; file: string; ctx: SetupContext; doctor(): Check[]; out(s: string): void }

const SAVED = 'Defaults saved. Change them any time with `hece prefs`.'

type Stop = 'cancelled' | 'aborted'
const stop = (k: 'quit' | 'abort' | 'back'): Stop => (k === 'abort' ? 'aborted' : 'cancelled')

/** Show screens in order with `b` history. Returns the answers, or why it stopped. */
async function walk<T>(d: SetupDeps, screens: readonly Screen[], p: Prefs, useWhen: boolean, finale: (p: Prefs, touched: string[]) => Promise<T | 'back' | Stop>): Promise<T | Stop> {
  const touched: string[] = []
  const stack: number[] = []
  let i = 0
  for (;;) {
    if (i >= screens.length) {
      const f = await finale(p, touched)
      if (f !== 'back') return f
      if (stack.length) i = stack.pop()!
      continue
    }
    const s = screens[i]
    if (useWhen && s.when && !s.when(p)) { i++; continue }
    const opts = s.options(p, d.ctx)
    const cur = s.key ? (s.key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], p)) : undefined
    const r = await ask(d.io, s.title, s.lines(p, d.ctx), opts, Math.max(0, opts.findIndex((o) => o.value === cur)))
    if (r.kind === 'back') { if (stack.length) i = stack.pop()!; continue }
    if (r.kind !== 'pick') return stop(r.kind)
    stack.push(i)
    if (s.key) {
      p = setKey(p, s.key, r.value)
      if (!touched.includes(s.key)) touched.push(s.key)
    }
    i++
  }
}

function blocked(d: SetupDeps, g: GlobalFile): Promise<unknown> {
  return ask(d.io, 'Cannot save', [g.error!, '', `Fix or delete ${g.path}`], [{ label: 'Exit', value: true }], 0)
}

export async function runWizard(d: SetupDeps, opts: { firstRun: boolean }): Promise<'saved' | 'skipped' | 'cancelled' | 'aborted'> {
  try {
    const g = readGlobal(d.file)
    if (g.error) {
      const r = await blocked(d, g)
      return (r as { kind: string }).kind === 'abort' ? 'aborted' : 'cancelled'
    }
    d.ctx = { ...d.ctx, fileErrors: [...d.ctx.fileErrors, ...g.errors] }
    const start = startPrefs(g)
    const result = await walk<'saved'>(d, SCREENS, start, true, async (p, touched) => {
      const raw = nextRaw(g.raw, p, touched)
      const summary = [...YAML.stringify(raw).trimEnd().split('\n'), '', g.path, ...(g.hadComments ? ['', 'Comments in this file will be lost.'] : [])]
      const r = await ask(d.io, 'Save', summary, [{ label: 'Save', value: true }], 0)
      if (r.kind === 'back') return 'back'
      if (r.kind !== 'pick') return stop(r.kind)
      saveGlobal(g, raw)
      // the file is saved; whatever happens on this screen, the result stays 'saved'
      await ask(d.io, 'Check', formatChecks(d.doctor()).trimEnd().split('\n'), [{ label: 'Done', value: true }], 0)
      return 'saved'
    })
    if (result === 'cancelled' && opts.firstRun) {
      saveGlobal(g, nextRaw(g.raw, { ...start, preset: 'involved' }, []))
      d.out(SAVED)
      return 'skipped'
    }
    return result
  } finally {
    d.io.close()
  }
}

export async function runPrefsEdit(d: SetupDeps, name?: string): Promise<'saved' | 'cancelled' | 'aborted'> {
  try {
    const g = readGlobal(d.file)
    if (g.error) {
      const r = await blocked(d, g)
      return (r as { kind: string }).kind === 'abort' ? 'aborted' : 'cancelled'
    }
    if (name === undefined) {
      const r = await ask(d.io, 'hece prefs', ['Which group?'], PREFS_NAMES.map((n) => ({ label: n, value: n })), 0)
      if (r.kind !== 'pick') return r.kind === 'abort' ? 'aborted' : 'cancelled'
      name = String(r.value)
    }
    const screens = SCREENS.filter((s) => s.group === name && s.group !== 'intro')
    if (!screens.length) {
      d.out(`Unknown name "${name}". Valid names: ${PREFS_NAMES.join(', ')}`)
      return 'cancelled'
    }
    const start = startPrefs(g)
    const answers = await walk<{ p: Prefs; touched: string[] }>(d, screens, start, false, async (p, touched) => ({ p, touched }))
    if (typeof answers === 'string') return answers
    // leaving a fixed preset for custom pins the old preset's values
    const touched = start.preset !== 'custom' && answers.p.preset === 'custom' ? [...answers.touched, ...CUSTOM_KEYS] : answers.touched
    const { prefs, touched: all } = promoteToCustom(answers.p, touched)
    saveGlobal(g, nextRaw(g.raw, prefs, all))
    return 'saved'
  } finally {
    d.io.close()
  }
}

function realDeps(): SetupDeps | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`hece ${process.argv[2]} needs a terminal\n`)
    process.exitCode = 1
    return undefined
  }
  const file = prefsFiles(process.env, resolveRoot(process.env)).global
  return {
    io: terminalIo(),
    file,
    ctx: { onPath: systemOnPath, plugins: installedPlugins(process.env), fileErrors: [] },
    doctor: () => {
      const { prefs, errors } = loadPrefs(process.env, resolveRoot(process.env))
      return systemChecks(prefs.optimize, errors)
    },
    out: (s) => void process.stdout.write(s + '\n'),
  }
}

export async function runSetup(_argv: string[]): Promise<void> {
  const d = realDeps()
  if (!d) return
  if ((await runWizard(d, { firstRun: !fs.existsSync(d.file) })) === 'aborted') process.exitCode = 130
}

export async function runPrefs(argv: string[]): Promise<void> {
  const d = realDeps()
  if (!d) return
  if ((await runPrefsEdit(d, argv[0])) === 'aborted') process.exitCode = 130
}

export function needsFirstRun(argv: string[], o: { stdinTTY: boolean; stdoutTTY: boolean; globalExists: boolean }): boolean {
  return !o.globalExists && interactiveClaude(argv.filter((a) => a !== '--no-frame'), o)
}

/** Runs the wizard before the first interactive launch. Returns false when the user aborted (Ctrl-C). */
export async function maybeFirstRun(argv: string[]): Promise<boolean> {
  const file = prefsFiles(process.env, resolveRoot(process.env)).global
  const tty = { stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY) }
  if (!needsFirstRun(argv, { ...tty, globalExists: fs.existsSync(file) })) return true
  const d = realDeps()
  if (!d) return true
  if ((await runWizard(d, { firstRun: true })) !== 'aborted') return true
  process.exitCode = 130
  return false
}
