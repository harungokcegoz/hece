import fs from 'node:fs'
import YAML from 'yaml'
import { formatChecks, installedPlugins, systemChecks, systemOnPath } from '../doctor/main.js'
import type { Check } from '../doctor/main.js'
import { prefsFiles } from '../prefs/load.js'
import { nextRaw, promoteToCustom, readGlobal, saveGlobal, startPrefs } from '../prefs/save.js'
import type { GlobalFile } from '../prefs/save.js'
import type { Prefs } from '../prefs/schema.js'
import { resolveRoot } from '../state/paths.js'
import { PREFS_NAMES, SCREENS, setKey } from './screens.js'
import type { Screen, SetupContext } from './screens.js'
import { ask, terminalIo } from './tui.js'
import type { Io } from './tui.js'

export interface SetupDeps { io: Io; file: string; ctx: SetupContext; doctor(p?: Prefs): Check[]; out(s: string): void }

const SAVED = 'Defaults saved. Change them any time with `hece prefs`.'

type Stop = 'cancelled' | 'aborted'
const stop = (k: 'quit' | 'abort'): Stop => (k === 'abort' ? 'aborted' : 'cancelled')

/** Show screens in order with `b` history. Returns the answers, or why it stopped. */
async function walk(d: SetupDeps, screens: readonly Screen[], p: Prefs, useWhen: boolean): Promise<{ p: Prefs; touched: string[] } | Stop> {
  const touched: string[] = []
  const stack: number[] = []
  let i = 0
  while (i < screens.length) {
    const s = screens[i]
    if (useWhen && s.when && !s.when(p)) { i++; continue }
    const opts = s.options(p, d.ctx)
    const cur = s.key ? (s.key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], p)) : undefined
    const r = await ask(d.io, s.title, s.lines(p, d.ctx), opts, Math.max(0, opts.findIndex((o) => o.value === cur)))
    if (r.kind === 'quit' || r.kind === 'abort') return stop(r.kind)
    if (r.kind === 'back') { if (stack.length) i = stack.pop()!; continue }
    stack.push(i)
    if (s.key) {
      p = setKey(p, s.key, r.value)
      if (!touched.includes(s.key)) touched.push(s.key)
    }
    i++
  }
  return { p, touched }
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
    const answers = await walk(d, SCREENS, start, true)
    if (answers === 'aborted') return 'aborted'
    if (answers === 'cancelled') {
      if (!opts.firstRun) return 'cancelled'
      saveGlobal(g, nextRaw(g.raw, { ...start, preset: 'involved' }, []))
      d.out(SAVED)
      return 'skipped'
    }
    const raw = nextRaw(g.raw, answers.p, answers.touched)
    const text = YAML.stringify(raw)
    const summary = [...text.trimEnd().split('\n'), '', g.path, ...(g.hadComments ? ['', 'Comments in this file will be lost.'] : [])]
    for (const [title, lines] of [['Save', summary], ['Check', formatChecks(d.doctor(answers.p)).trimEnd().split('\n')]] as const) {
      const r = await ask(d.io, title, lines, [{ label: title === 'Save' ? 'Continue' : 'Save', value: true }], 0)
      if (r.kind === 'abort') return 'aborted'
      if (r.kind !== 'pick') return 'cancelled'
    }
    saveGlobal(g, raw)
    return 'saved'
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
    const answers = await walk(d, screens, startPrefs(g), false)
    if (typeof answers === 'string') return answers
    const { prefs, touched } = promoteToCustom(answers.p, answers.touched)
    saveGlobal(g, nextRaw(g.raw, prefs, touched))
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
    doctor: (p) => systemChecks(p?.optimize ?? 'ponytail', []),
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
