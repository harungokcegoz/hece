import type { Prefs } from '../prefs/schema.js'
import { presetDefaults } from '../prefs/schema.js'
import { VENDORS } from '../prefs/vendors.js'
import { fitLine } from '../panels/fit.js'
import type { Option } from './tui.js'

export interface SetupContext { onPath(bin: string): boolean; plugins: Set<string> | null; fileErrors: string[] }
export interface Screen {
  id: string
  group: string
  key?: string
  title: string
  lines(p: Prefs, c: SetupContext): string[]
  options(p: Prefs, c: SetupContext): Option[]
  when?(p: Prefs): boolean
}

const custom = (p: Prefs) => p.preset === 'custom'
const opt = (value: string | boolean, label: string, note?: string): Option => ({ label, value, note })

/** A custom-only screen: a one-line question and fixed options. */
function pick(id: string, key: string, title: string, lines: string[], options: Option[]): Screen {
  return { id, group: id, key, title, lines: () => lines, options: () => options, when: custom }
}

export function setKey(p: Prefs, key: string, value: string | boolean): Prefs {
  const out = structuredClone(p) as unknown as Record<string, unknown>
  const [group, leaf] = key.split('.')
  if (leaf === undefined) out[group] = value
  else (out[group] as Record<string, unknown>)[leaf] = value
  return out as unknown as Prefs
}

const PACKS = { ponytail: ['/plugin marketplace add DietrichGebert/ponytail', '/plugin install ponytail@ponytail'], caveman: ['/plugin marketplace add JuliusBrussee/caveman', '/plugin install caveman@caveman'] }
const SUPERPOWERS = '/plugin install superpowers@claude-plugins-official'

function skillLines(p: Prefs, c: SetupContext): string[] {
  const out = ['ponytail: smallest change that works.', 'caveman: terse replies, fewer tokens.', '']
  if (!c.plugins) return [...out, "Can't read Claude Code's plugin list.", 'hece needs superpowers. Install both:', SUPERPOWERS, ...PACKS[p.optimize]]
  const sp = c.plugins.has('superpowers')
  const pk = c.plugins.has(p.optimize)
  out.push(`superpowers ${sp ? '✓' : '✗'}  ${p.optimize} ${pk ? '✓' : '✗'}`)
  if (!sp) out.push(SUPERPOWERS)
  if (!pk) out.push(...PACKS[p.optimize])
  return out
}

function slicePreview(depth: Prefs['slice_stop']['depth'], question: boolean): string[] {
  const body = {
    line: ['Slice 2 done: login form.'],
    short: ['Slice 2 done: login form.', 'Next: wire it to the API.'],
    detailed: ['Slice 2 done: login form.', 'Changed: form.ts, form.test.ts', 'Next: wire it to the API.'],
  }[depth]
  return [...body, ...(question ? ['Q: why a controlled input?'] : []), 'Continue?']
}

const cur = (p: Prefs, key: string): string | undefined => {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], p)
  return typeof v === 'string' && v !== 'default' ? v : undefined
}
const choice = (id: string, key: string, title: string, q: string, list: (p: Prefs) => readonly string[], orchestrator: boolean): Screen => ({
  id, group: 'models', key, title,
  lines: () => [q],
  options: (p) => [
    ...(orchestrator ? [opt('default', "Claude Code's own setting")] : []),
    // a hand-edited value outside the vendor list stays the first, pre-selected option
    ...(cur(p, key) && !list(p).includes(cur(p, key)!) ? [opt(cur(p, key)!, fitLine(cur(p, key)!, 30), 'current')] : []),
    ...list(p).map((m) => opt(m, m)),
  ],
})
const models = (id: string, key: string, title: string, orch = false) => choice(id, key, title, 'Which model?', (p) => VENDORS[p.agent].models, orch)
const efforts = (id: string, key: string, title: string, orch = false) => choice(id, key, title, 'How much effort?', (p) => VENDORS[p.agent].efforts, orch)

const onOff = (id: string, key: string, title: string, lines: string[]): Screen => ({
  id, group: 'guards', key, title, lines: () => lines,
  options: () => [opt(true, 'on'), opt(false, 'off')],
})

const widgets = (id: string, key: string, title: string): Screen => ({
  id, group: 'layout', key, title,
  lines: () => ['What goes in this pane?'],
  options: () => [
    opt('flow', 'flow', 'where the build stands'),
    opt('activity', 'activity', 'what the agent just did'),
    opt('sessions', 'sessions'),
    opt('none', 'none'),
  ],
})

export const SCREENS: readonly Screen[] = [
  {
    id: 'intro', group: 'intro', title: 'hece',
    lines: (_p, c) => [
      'hece keeps you in the loop while',
      'AI agents build: discuss, plan,',
      'small slices, review, recap.',
      ...(c.fileErrors.length ? ['', 'Problems in your prefs files:', ...c.fileErrors] : []),
    ],
    options: () => [opt(true, 'Continue')],
  },
  {
    id: 'agent', group: 'agent', key: 'agent', title: 'Agent',
    lines: () => ['Which agent runs the build?'],
    options: (_p, c) => (Object.keys(VENDORS) as Prefs['agent'][]).map((a) => ({
      label: `${VENDORS[a].bin} ${c.onPath(VENDORS[a].bin) ? '✓' : '✗'}`,
      value: a,
      ...(VENDORS[a].supported ? {} : { disabled: 'not supported yet' }),
    })),
  },
  {
    id: 'preset', group: 'preset', key: 'preset', title: 'Preset',
    lines: () => ['How involved do you want to be?'],
    options: () => (['involved', 'learning', 'custom'] as const).map((n) => {
      const d = presetDefaults(n)
      const note = { involved: 'stop after each slice', learning: 'stops plus check questions', custom: 'pick each setting' }[n]
      return { label: n, value: n, note, preview: slicePreview(d.slice_stop.depth, d.check_questions !== 'off') }
    }),
  },
  pick('discussion-first', 'discussion.first', 'Who speaks first?', ['Who speaks first in a discussion?', 'me: it asks for your idea first.', 'agent: it offers its idea first.'],
    [opt('me', 'me'), opt('agent', 'agent', 'it proposes first')]),
  pick('pushback', 'discussion.pushback', 'Pushback', ['How does it react to a weak idea?', 'gentle: suggests an alternative.', 'direct: says why it is a bad idea.'],
    [opt('gentle', 'gentle'), opt('direct', 'direct')]),
  pick('slice-size', 'plan.slice_size', 'Slice size', ['How big is each build step?', 'small: 1-3 files per slice.', 'medium: 3-6 files per slice.'],
    [opt('small', 'small'), opt('medium', 'medium')]),
  pick('stop-depth', 'slice_stop.depth', 'Stop depth', ['How much to say at each stop?', 'line: one line.', 'short: up to 5 lines, done + next.', 'detailed: up to 15 lines, files + why.'],
    [opt('line', 'line', 'one line'), opt('short', 'short'), opt('detailed', 'detailed', 'files and why')]),
  pick('check-questions', 'check_questions', 'Check questions', ['Quiz you on what was built?', 'off: never.', 'non-routine: only teaching slices.', 'every: after every slice.'],
    [opt('off', 'off'), opt('non-routine', 'non-routine', 'only unusual code'), opt('every', 'every', 'every slice')]),
  pick('side-chats', 'side_chats.open_in', 'Side chats', ['Where do side chats open?', 'pane: beside the build.', 'window: in a separate window.'],
    [opt('pane', 'pane'), opt('window', 'window')]),
  pick('review-final', 'review.final', 'Final review', ['Review the whole build at the end?', 'on: a reviewer reads the full diff.', 'off: skip the final review.'],
    [opt(true, 'on'), opt(false, 'off')]),
  pick('review-minor', 'review.show_minor', 'Minor findings', ['Show small review findings?', 'on: naming and style nits appear.', 'off: only the important ones.'],
    [opt(true, 'on'), opt(false, 'off')]),
  pick('recap', 'flow_recap', 'Recap', ['Recap the flow when done?', 'on: a walkthrough, up to 15 lines.', 'off: finish without a recap.'],
    [opt(true, 'on'), opt(false, 'off')]),
  {
    id: 'optimize', group: 'skills', key: 'optimize', title: 'Skills',
    lines: skillLines,
    options: () => [opt('ponytail', 'ponytail', 'smallest change'), opt('caveman', 'caveman', 'terse replies')],
  },
  models('orchestrator-model', 'delegate.orchestrator', 'Orchestrator model', true),
  efforts('orchestrator-effort', 'effort.orchestrator', 'Orchestrator effort', true),
  models('build-model', 'delegate.build', 'Build model'),
  efforts('build-effort', 'effort.build', 'Build effort'),
  models('review-model', 'review.reviewer_model', 'Review model'),
  efforts('review-effort', 'effort.review', 'Review effort'),
  onOff('guard-stops', 'guards.stops', 'Stop guard', ['Block code edits during discussion,', 'before plan approval, and while', 'a slice waits for you.', 'Off: the agent can edit anytime.']),
  onOff('guard-files', 'guards.files', 'File guard', ['Block edits to .hece/ and the', 'hece config dir.', 'Off: the agent can change hece', 'state and settings.']),
  widgets('layout-left', 'layout.left', 'Left pane'),
  widgets('layout-right', 'layout.right', 'Right pane'),
]

const MAIN = ['agent', 'preset', 'skills', 'models', 'guards', 'layout']
export const PREFS_NAMES: readonly string[] = [...MAIN, ...new Set(SCREENS.map((s) => s.group))].filter((g, i, a) => g !== 'intro' && a.indexOf(g) === i)
