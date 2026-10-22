# hece Frame MVP Implementation Plan (v0.1, plan 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** typing `hece` opens one terminal window with three panes: **Activity** on the left (what is happening, in plain language), the real **Claude Code** with hece loaded in the middle, and **Flow** on the right (the real hece flow). All panes read the real `.hece/state` files.

**Architecture:**
- `hece` runs the new `frame` launcher. It creates a tmux session on a **per-project private socket**, with Claude (`hece --no-frame …`) in the middle and `hece panel <widget>` processes on the sides.
- Panels are read-only. They are pure render functions plus a loop that re-reads state every 300 ms and redraws **only when the text changed**.
- Activity gets plain-language lines from two sources: a new `activity_note` MCP tool (the agent's intent), and rule-based wording of hook events.
- Without a TTY, inside an existing tmux, in print mode, or when tmux is missing, `hece` falls back to plain mode.

**Tech Stack:** Node ≥20, TypeScript 7, ESM, vitest, tmux (runtime, optional), and the existing hece modules. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-hece-design.md`: §9 (layout), §10.1–10.2, and the amendments D9 (plain-language Activity) and D10 (plain ANSI panels for the MVP).

**Not in this plan (plan 2b):** panel keys that talk to Claude (Enter = continue), side chats, Claude channels transport, arrow navigation in panels, and a model-based summarizer.

## Global Constraints

- Node `>=20`; ESM only; relative imports end in `.js`.
- **Panels never write state.** They only read `.hece/state/*` and preferences.
- The hook's invariants are unchanged: it always exits 0 and writes nothing without `.hece/state/flow.json`.
- `activity_note` writes only when a flow exists, and never mutates `flow.json`.
- Activity never shows raw commands or hece's own bookkeeping tool calls (`mcp__…hece…`, `Skill`, `TodoWrite`, `ToolSearch`).
- `hece` must never nest tmux, never open a window without a TTY, and never start a second Claude for the same project while its window is open.
- No new runtime npm dependencies.
- Commits: no `Co-Authored-By` trailer or AI attribution. The repo's git config already has the user's no-reply email.

## Review Focus

1. **The user is already inside tmux** (`$TMUX` set). hece must run in plain mode, not nest. Pinned in Task 6.
2. **Non-interactive use** (`hece -p "…"`, a pipe, `--version`). It must not open a window. Pinned in Task 6.
3. **Running `hece` twice in one project.** The second run must reattach to the open window, not start a second Claude. Pinned in Task 6.
4. **Narrow panes and long text.** Lines are cut with `…` (unicode-safe) and never wrap. Pinned in Task 4.
5. **Missing or corrupt state.** A panel shows a message and never crashes. Pinned in Task 5.

---

## File structure

```
src/mcp/server.ts            + activity_note tool                (modify)
skills/flow/SKILL.md         + narrate with activity_note         (modify)
src/activity/describe.ts     describeCommand, describeTool, describeEvent, relPath
src/activity/view.ts         buildActivity → grouped, collapsed, tail-limited lines
src/panels/fit.ts            fitLine, fitLines
src/panels/color.ts          color helpers, stripAnsi
src/panels/views.ts          flowPanelLines, colorFlowLine, sessionsPanelLines
src/panels/main.ts           panelFrame (pure-ish), runPanel (loop / --once)
src/frame/main.ts            frameName, shellQuote, frameDecision, openFrame, runFrame
src/cli.ts                   routes: panel, --no-frame, default → frame   (modify)
README.md, CONTRIBUTING.md   docs                                  (modify)
test/activity/*.test.ts, test/panels/*.test.ts, test/frame/*.test.ts
```

---

### Task 1: `activity_note` tool and skill instruction

**Files:**
- Modify: `src/mcp/server.ts`, `skills/flow/SKILL.md`
- Test: `test/mcp/mcp.test.ts`, `test/skills/skills.test.ts`

**Interfaces:**
- Produces: the MCP tool `activity_note({ text: string(1..200) })`. It appends the event `{ event: 'note', text, slice: flow.currentSlice }` and returns `noted`. With no flow, it returns `isError` with `hece: no flow yet; start one with flow_set_phase(discuss)`. `TOOL_NAMES` gains `'activity_note'`.

- [ ] **Step 1: Write the failing tests**

In `test/mcp/mcp.test.ts`, add the imports at the top:
```ts
import { readEvents } from '../../src/state/store.js'
import { statePaths } from '../../src/state/paths.js'
```
and this test inside `describe('hece mcp', …)`:
```ts
  it('activity_note records a plain-language note under the current slice', async () => {
    const root = tmpProject()
    const c = await connect(root)
    expect(await call(c, 'activity_note', { text: 'reading the code' })).toEqual({
      text: 'hece: no flow yet; start one with flow_set_phase(discuss)',
      isError: true,
    })
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    expect((await call(c, 'activity_note', { text: '  checking   how login works ' })).text).toBe('noted')
    const notes = readEvents(statePaths(root).events).filter((e) => e.event === 'note')
    expect(notes).toEqual([expect.objectContaining({ event: 'note', text: 'checking how login works', slice: null })])
  })
```
In `test/skills/skills.test.ts`, inside the describe block:
```ts
  it('flow tells the agent to narrate with activity_note', () => {
    expect(read('flow')).toContain('activity_note')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/mcp test/skills`
Expected: FAIL. `activity_note` is an unknown tool, and the flow skill has no `activity_note`.

- [ ] **Step 3: Implement**

In `src/mcp/server.ts`, add `'activity_note'` to the end of `TOOL_NAMES`, and register this tool before `prefs_get`:
```ts
  server.registerTool(
    'activity_note',
    {
      description:
        "Tell the user in one plain sentence what you are about to do and why. It's shown in hece's Activity panel. Call it before each meaningful step. No code, no file contents.",
      inputSchema: { text: z.string().min(1).max(200) },
    },
    async ({ text }) => {
      try {
        if (!fs.existsSync(paths.flow)) return fail('hece: no flow yet; start one with flow_set_phase(discuss)')
        const s = load()
        appendEvent(paths.events, { at: now(), event: 'note', text: text.replace(/\s+/g, ' ').trim(), slice: s.currentSlice })
        return ok('noted')
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  )
```
In `skills/flow/SKILL.md`, under `### build: one slice at a time`, replace the line `1. \`flow_start_slice(n)\`.` with:
```markdown
1. `flow_start_slice(n)`.
   Narrate as you go. Before each meaningful step (reading code to understand it, changing a file, running the tests), call `activity_note` with one plain sentence saying what you're doing and why, e.g. `activity_note("Saving only a hash of the reset token, so a DB leak can't reset passwords")`. No code, no file contents. The user sees these in hece's Activity panel.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. The existing "lists exactly the hece tools" test follows `TOOL_NAMES` automatically.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts skills/flow/SKILL.md test/mcp/mcp.test.ts test/skills/skills.test.ts
git commit -m "feat: activity_note lets the agent narrate its steps"
```

---

### Task 2: Plain-language descriptions

**Files:**
- Create: `src/activity/describe.ts`
- Test: `test/activity/describe.test.ts`

**Interfaces:**
- Consumes: `HeceEvent` (src/state/store.ts), `FlowState` (src/flow/types.ts)
- Produces:
  - `type LineKind = 'note' | 'action' | 'alert' | 'milestone'`
  - `interface ActivityLine { kind: LineKind; text: string; slice: number | null }`
  - `interface DescribeContext { root: string; flow: FlowState }`
  - `relPath(root: string, p: string): string`
  - `describeCommand(command: string): string`
  - `describeTool(tool: string, target: string, root: string): string | null` (null means hidden)
  - `describeEvent(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null`

- [ ] **Step 1: Write the failing test**

`test/activity/describe.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan } from '../../src/flow/flow.js'
import { describeCommand, describeTool, describeEvent, relPath } from '../../src/activity/describe.js'

const root = '/p'
const flow = setPlan(emptyFlow(), [{ title: 'Token model', files: [], kind: 'teaching' }], { guards: false }, 1)
const ctx = { root, flow }

describe('describeCommand', () => {
  it.each([
    ['npm test', 'running the tests'],
    ['npx vitest run test/a.test.ts', 'running the tests'],
    ['cd app && npm run test -- --watch=false', 'running the tests'],
    ['CI=1 pytest -q', 'running the tests'],
    ['npm install zod', 'installing packages'],
    ['npm run typecheck', 'checking code style and types'],
    ['npm run build', 'building the project'],
    ['git status', 'checking what changed in git'],
    ['git commit -m "x"', 'committing the changes'],
    ['ls -la && find . -maxdepth 3', 'looking around the files'],
    ['mkdir -p src/auth', 'arranging files'],
    ['rm -rf dist', 'deleting files'],
    ['node scripts/seed.js --fast', 'running seed.js'],
    ['./deploy.sh', 'running a command'],
  ])('%s → %s', (cmd, text) => {
    expect(describeCommand(cmd)).toBe(text)
  })
})

describe('describeTool', () => {
  it('describes file tools with project-relative paths', () => {
    expect(describeTool('Edit', '/p/src/auth/reset.ts', root)).toBe('changing src/auth/reset.ts')
    expect(describeTool('Write', 'src/new.ts', root)).toBe('writing src/new.ts')
    expect(describeTool('Read', '/elsewhere/notes.md', root)).toBe('reading notes.md')
    expect(describeTool('Grep', 'createUser', root)).toBe('searching the code for "createUser"')
  })
  it('hides hece bookkeeping and housekeeping tools', () => {
    for (const t of ['mcp__plugin_hece_hece__flow_start_slice', 'mcp__hece__activity_note', 'Skill', 'TodoWrite', 'ToolSearch']) {
      expect(describeTool(t, '', root)).toBeNull()
    }
  })
  it('names other MCP servers and unknown tools plainly', () => {
    expect(describeTool('mcp__plugin_figma_figma__get_file', '', root)).toBe('using figma: get file')
    expect(describeTool('Task', '', root)).toBe('handing work to a helper agent')
    expect(describeTool('FancyTool', '', root)).toBe('using FancyTool')
  })
})

describe('describeEvent', () => {
  it('turns notes, tools, flow steps, approvals and problems into lines', () => {
    expect(describeEvent({ at: 1, event: 'note', text: 'saving only a hash', slice: 1 }, ctx)).toEqual({ kind: 'note', text: 'Now: saving only a hash', slice: 1 })
    expect(describeEvent({ at: 1, event: 'tool', tool: 'Bash', target: 'npm test', slice: 1 }, ctx)).toEqual({ kind: 'action', text: 'running the tests', slice: 1 })
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_start_slice', n: 1 }, ctx)).toEqual({ kind: 'milestone', text: 'started slice 1: Token model', slice: 1 })
    expect(describeEvent({ at: 1, event: 'flow', tool: 'flow_finish_slice', n: 1 }, ctx)).toEqual({ kind: 'milestone', text: 'slice 1 done, waiting for you', slice: 1 })
    expect(describeEvent({ at: 1, event: 'approved', what: 'plan', via: 'typed' }, ctx)).toEqual({ kind: 'milestone', text: 'you approved the plan', slice: null })
    expect(describeEvent({ at: 1, event: 'blocked', tool: 'Write', target: '/p/a.ts', reason: 'hece: slice 1 is waiting for the user' }, ctx))
      .toEqual({ kind: 'alert', text: 'hece stopped an edit to a.ts: slice 1 is waiting for the user', slice: null })
    expect(describeEvent({ at: 1, event: 'hook_error', message: 'flow.json is unreadable' }, ctx)).toEqual({ kind: 'alert', text: 'hece problem: flow.json is unreadable', slice: null })
  })
  it('hides noise events', () => {
    for (const event of ['prompt', 'turn_done', 'session_start']) expect(describeEvent({ at: 1, event }, ctx)).toBeNull()
    expect(describeEvent({ at: 1, event: 'tool', tool: 'mcp__hece__flow_get', target: '' }, ctx)).toBeNull()
  })
})

describe('relPath', () => {
  it('falls back to the file name outside the project', () => {
    expect(relPath('/p', '/p/x/y.ts')).toBe('x/y.ts')
    expect(relPath('/p', '/q/y.ts')).toBe('y.ts')
    expect(relPath('/p', '')).toBe('a file')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/activity/describe.test.ts`
Expected: FAIL, cannot resolve `../../src/activity/describe.js`.

- [ ] **Step 3: Implement**

`src/activity/describe.ts`:
```ts
import path from 'node:path'
import { HeceEvent } from '../state/store.js'
import { FlowState } from '../flow/types.js'

export type LineKind = 'note' | 'action' | 'alert' | 'milestone'

export interface ActivityLine {
  kind: LineKind
  text: string
  slice: number | null
}

export interface DescribeContext {
  root: string
  flow: FlowState
}

// housekeeping the user doesn't need to see
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'Skill', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode',
  'BashOutput', 'KillShell', 'KillBash', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
])

export function relPath(root: string, p: string): string {
  if (!p) return 'a file'
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p)
  const rel = path.relative(root, abs)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(p)
}

const COMMAND_RULES: [RegExp, string][] = [
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b/, 'running the tests'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bbrew\s+install\b/, 'installing packages'],
  [/\b(npm|pnpm|yarn|bun)\s+run\s+(lint|typecheck|format)\b|\b(eslint|prettier)\b/, 'checking code style and types'],
  [/\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\b(cargo|go)\s+build\b|^make\b/, 'building the project'],
  [/^git\s+commit\b/, 'committing the changes'],
  [/^git\s+(status|diff|log|show)\b/, 'checking what changed in git'],
  [/^git\b/, 'using git'],
  [/^(ls|find|tree|cat|head|tail|wc|grep|rg|pwd)\b/, 'looking around the files'],
  [/^(mkdir|touch|cp|mv)\b/, 'arranging files'],
  [/^rm\b/, 'deleting files'],
  [/^(curl|wget)\b/, 'calling a URL'],
]

// the part of a shell line that matters: skip `cd …`, `export …` and leading VAR=value
function mainCommand(command: string): string {
  const segments = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)
  const seg = segments.find((s) => s && !/^(cd|export|set)\b/.test(s)) ?? ''
  return seg.replace(/^(\w+=\S*\s+)+/, '')
}

export function describeCommand(command: string): string {
  const cmd = mainCommand(command)
  for (const [re, text] of COMMAND_RULES) if (re.test(cmd)) return text
  const run = cmd.match(/^(?:node|python3?|ruby|deno|bun|tsx)\s+(?:run\s+)?(\S+)/)
  if (run) return `running ${path.basename(run[1])}`
  return 'running a command'
}

export function describeTool(tool: string, target: string, root: string): string | null {
  if (HIDDEN_TOOLS.has(tool)) return null
  if (tool.startsWith('mcp__')) {
    const [, server = '', name = ''] = tool.split('__')
    if (/(^|_)hece$/.test(server)) return null
    return `using ${server.replace(/^plugin_[^_]+_/, '')}: ${name.replace(/_/g, ' ')}`
  }
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
      return `changing ${relPath(root, target)}`
    case 'Write':
      return `writing ${relPath(root, target)}`
    case 'NotebookEdit':
      return `changing notebook ${relPath(root, target)}`
    case 'Read':
      return `reading ${relPath(root, target)}`
    case 'Grep':
      return target ? `searching the code for "${target}"` : 'searching the code'
    case 'Glob':
      return target ? `looking for files matching ${target}` : 'looking for files'
    case 'Bash':
      return describeCommand(target)
    case 'Task':
    case 'Agent':
      return 'handing work to a helper agent'
    case 'WebFetch':
    case 'WebSearch':
      return 'looking something up on the web'
    case 'AskUserQuestion':
      return 'asking you a question'
    default:
      return `using ${tool}`
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
const sliceTitle = (flow: FlowState, n: number | null): string =>
  n === null ? '' : (flow.plan?.slices.find((s) => s.n === n)?.title ?? '')

function describeFlow(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  const n = num(ev.n)
  switch (ev.tool) {
    case 'flow_set_phase':
      return { kind: 'milestone', text: `phase: ${str(ev.phase)}`, slice: null }
    case 'flow_add_decision':
      return { kind: 'milestone', text: `decided: ${str(ev.title)}`, slice: null }
    case 'flow_set_plan':
      return { kind: 'milestone', text: `plan proposed: ${num(ev.slices)} slices, waiting for your approval`, slice: null }
    case 'flow_start_slice':
      return { kind: 'milestone', text: `started slice ${n}: ${sliceTitle(ctx.flow, n)}`, slice: n }
    case 'flow_finish_slice':
      return { kind: 'milestone', text: `slice ${n} done, waiting for you`, slice: n }
    case 'flow_report_review':
      return { kind: 'milestone', text: `review: ${num(ev.important)} important, ${num(ev.minor)} minor`, slice: null }
    default:
      return null
  }
}

export function describeEvent(ev: HeceEvent, ctx: DescribeContext): ActivityLine | null {
  switch (ev.event) {
    case 'note':
      return { kind: 'note', text: `Now: ${str(ev.text)}`, slice: num(ev.slice) }
    case 'tool': {
      const text = describeTool(str(ev.tool), str(ev.target), ctx.root)
      return text ? { kind: 'action', text, slice: num(ev.slice) } : null
    }
    case 'blocked':
      return {
        kind: 'alert',
        text: `hece stopped an edit to ${relPath(ctx.root, str(ev.target))}: ${str(ev.reason).replace(/^hece:\s*/, '')}`,
        slice: null,
      }
    case 'approved':
      return ev.what === 'plan'
        ? { kind: 'milestone', text: 'you approved the plan', slice: null }
        : { kind: 'milestone', text: `you approved slice ${num(ev.n)}`, slice: num(ev.n) }
    case 'redo_requested':
      return { kind: 'milestone', text: `you asked to redo slice ${num(ev.n)}`, slice: num(ev.n) }
    case 'hook_error':
    case 'prefs_error':
      return { kind: 'alert', text: `hece problem: ${str(ev.message)}`, slice: null }
    case 'flow':
      return describeFlow(ev, ctx)
    default:
      return null
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/activity && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/activity/describe.ts test/activity/describe.test.ts
git commit -m "feat: describe hece events in plain language"
```

---

### Task 3: Activity view, grouped by slice

**Files:**
- Create: `src/activity/view.ts`
- Test: `test/activity/view.test.ts`

**Interfaces:**
- Consumes: `describeEvent`, `DescribeContext`, `LineKind` (Task 2)
- Produces: `interface ViewLine { kind: LineKind | 'header'; text: string }` and `buildActivity(events: HeceEvent[], ctx: DescribeContext, max: number): ViewLine[]`.
  - Lines that belong to a slice are indented under `▸ Slice n · title`.
  - Slice-less lines are not indented.
  - Repeated identical actions collapse into `(×n)`.
  - Only the last `max` lines are kept, and the first kept slice line always has its header.

- [ ] **Step 1: Write the failing test**

`test/activity/view.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan } from '../../src/flow/flow.js'
import { buildActivity } from '../../src/activity/view.js'
import { HeceEvent } from '../../src/state/store.js'

const flow = setPlan(emptyFlow(), [
  { title: 'Token model', files: [], kind: 'teaching' },
  { title: 'Login', files: [], kind: 'routine' },
], { guards: false }, 1)
const ctx = { root: '/p', flow }
const e = (event: string, extra: Record<string, unknown> = {}): HeceEvent => ({ at: 1, event, ...extra })

const events: HeceEvent[] = [
  e('flow', { tool: 'flow_set_phase', phase: 'build' }),
  e('flow', { tool: 'flow_start_slice', n: 1 }),
  e('note', { text: 'adding the token table', slice: 1 }),
  e('tool', { tool: 'Read', target: '/p/src/db.ts', slice: 1 }),
  e('tool', { tool: 'Read', target: '/p/src/db.ts', slice: 1 }),
  e('tool', { tool: 'mcp__hece__flow_get', target: '', slice: 1 }),
  e('tool', { tool: 'Edit', target: '/p/src/token.ts', slice: 1 }),
  e('approved', { what: 'slice', n: 1 }),
  e('flow', { tool: 'flow_start_slice', n: 2 }),
  e('tool', { tool: 'Bash', target: 'npm test', slice: 2 }),
]

describe('buildActivity', () => {
  it('groups by slice, indents, collapses repeats and hides bookkeeping', () => {
    expect(buildActivity(events, ctx, 50).map((l) => l.text)).toEqual([
      '◆ phase: build',
      '▸ Slice 1 · Token model',
      '  ◆ started slice 1: Token model',
      '  Now: adding the token table',
      '  · reading src/db.ts (×2)',
      '  · changing src/token.ts',
      '  ◆ you approved slice 1',
      '▸ Slice 2 · Login',
      '  ◆ started slice 2: Login',
      '  · running the tests',
    ])
  })

  it('keeps the last lines and re-adds the slice header at the top', () => {
    expect(buildActivity(events, ctx, 3).map((l) => l.text)).toEqual([
      '▸ Slice 2 · Login',
      '  ◆ started slice 2: Login',
      '  · running the tests',
    ])
    expect(buildActivity(events, ctx, 2).map((l) => l.text)).toEqual(['▸ Slice 2 · Login', '  · running the tests'])
  })

  it('returns kinds for colouring', () => {
    expect(buildActivity(events, ctx, 50).map((l) => l.kind).slice(0, 4)).toEqual(['milestone', 'header', 'milestone', 'note'])
  })

  it('is empty when nothing readable happened', () => {
    expect(buildActivity([e('prompt'), e('turn_done')], ctx, 10)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/activity/view.test.ts`
Expected: FAIL, cannot resolve `../../src/activity/view.js`.

- [ ] **Step 3: Implement**

`src/activity/view.ts`:
```ts
import { HeceEvent } from '../state/store.js'
import { ActivityLine, DescribeContext, LineKind, describeEvent } from './describe.js'

export interface ViewLine {
  kind: LineKind | 'header'
  text: string
}

interface Tagged extends ViewLine {
  slice: number | null
}

const MARK: Record<LineKind, string> = { note: '', action: '· ', alert: '⚠ ', milestone: '◆ ' }

export function buildActivity(events: HeceEvent[], ctx: DescribeContext, max: number): ViewLine[] {
  const lines: (ActivityLine & { count: number })[] = []
  for (const ev of events) {
    const l = describeEvent(ev, ctx)
    if (!l) continue
    const prev = lines[lines.length - 1]
    if (prev && prev.kind === 'action' && l.kind === 'action' && prev.text === l.text && prev.slice === l.slice) prev.count++
    else lines.push({ ...l, count: 1 })
  }

  const header = (n: number): Tagged => {
    const title = ctx.flow.plan?.slices.find((s) => s.n === n)?.title ?? ''
    return { kind: 'header', text: `▸ Slice ${n}${title ? ` · ${title}` : ''}`, slice: n }
  }

  const out: Tagged[] = []
  let group: number | null = null
  for (const l of lines) {
    if (l.slice !== null && l.slice !== group) out.push(header(l.slice))
    group = l.slice
    const indent = l.slice === null ? '' : '  '
    const count = l.count > 1 ? ` (×${l.count})` : ''
    out.push({ kind: l.kind, text: `${indent}${MARK[l.kind]}${l.text}${count}`, slice: l.slice })
  }

  if (out.length <= max) return out.map(({ kind, text }) => ({ kind, text }))
  let kept = out.slice(out.length - max)
  const first = kept[0]
  if (first && first.kind !== 'header' && first.slice !== null) kept = [header(first.slice), ...out.slice(out.length - max + 1)]
  return kept.map(({ kind, text }) => ({ kind, text }))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/activity && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/activity/view.ts test/activity/view.test.ts
git commit -m "feat: activity view grouped by slice"
```

---

### Task 4: Panel views, fitting and colour

**Files:**
- Create: `src/panels/fit.ts`, `src/panels/color.ts`, `src/panels/views.ts`
- Test: `test/panels/views.test.ts`

**Interfaces:**
- Consumes: `renderFlow` (src/flow/render.ts), `FlowState`, `SessionRecord` (src/hooks/handle.ts)
- Produces:
  - `fitLine(text, width): string` and `fitLines(lines, width, height, keep: 'top' | 'bottom'): string[]`
  - `color` (`dim`, `bold`, `green`, `yellow`, `red`, `cyan`, `boldYellow`, `boldRed`, `boldCyan`) and `stripAnsi(s)`
  - `flowPanelLines(flow: FlowState | null, opts: { guards: boolean; idle: boolean | null }): string[]`
  - `colorFlowLine(line: string): string`
  - `sessionsPanelLines(sessions: SessionRecord[]): string[]`

- [ ] **Step 1: Write the failing test**

`test/panels/views.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { fitLine, fitLines } from '../../src/panels/fit.js'
import { stripAnsi } from '../../src/panels/color.js'
import { flowPanelLines, colorFlowLine, sessionsPanelLines } from '../../src/panels/views.js'

describe('fit', () => {
  it('cuts long lines with an ellipsis and never splits a character', () => {
    expect(fitLine('abcdef', 4)).toBe('abc…')
    expect(fitLine('abc', 4)).toBe('abc')
    expect(fitLine('✓ ◆ ▸ ■ ←', 5)).toBe('✓ ◆ …')
  })
  it('keeps the top or the bottom when there are too many lines', () => {
    expect(fitLines(['1', '2', '3'], 10, 2, 'top')).toEqual(['1', '2'])
    expect(fitLines(['1', '2', '3'], 10, 2, 'bottom')).toEqual(['2', '3'])
  })
})

describe('flowPanelLines', () => {
  it('explains what to do when there is no flow yet', () => {
    expect(flowPanelLines(null, { guards: true, idle: null })).toEqual(['hece', '', 'No flow yet.', 'Ask Claude to build', 'something to start one.'])
  })
  it('shows the flow, whether Claude is waiting, and the guards', () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], { guards: true }, 1)
    s = finishSlice(startSlice(approve(s, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
    const lines = flowPanelLines(s, { guards: true, idle: true })
    expect(lines).toContain('  ■ 1. A  ← waiting for you')
    expect(lines.slice(-2)).toEqual(['Claude: waiting for you', 'guards: on'])
  })
  it('colours waiting lines red and the current step yellow', () => {
    expect(colorFlowLine('  ■ 1. A  ← waiting for you')).toContain('\x1b[1;31m')
    expect(colorFlowLine('▸ Build')).toContain('\x1b[1;33m')
    expect(stripAnsi(colorFlowLine('✓ Plan (2 slices)'))).toBe('✓ Plan (2 slices)')
  })
})

describe('sessionsPanelLines', () => {
  it('lists the most recent sessions', () => {
    expect(sessionsPanelLines([])).toEqual(['Sessions', '', 'none yet'])
    expect(sessionsPanelLines([{ sessionId: 'abcdef1234', source: 'startup', at: 1 }])).toEqual(['Sessions', '', '• main abcdef12'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/panels/views.test.ts`
Expected: FAIL, cannot resolve `../../src/panels/fit.js`.

- [ ] **Step 3: Implement**

`src/panels/fit.ts`:
```ts
export function fitLine(text: string, width: number): string {
  const chars = Array.from(text)
  if (chars.length <= width) return text
  return width <= 1 ? chars.slice(0, Math.max(0, width)).join('') : chars.slice(0, width - 1).join('') + '…'
}

export function fitLines(lines: string[], width: number, height: number, keep: 'top' | 'bottom'): string[] {
  const fitted = lines.map((l) => fitLine(l, width))
  if (fitted.length <= height) return fitted
  return keep === 'top' ? fitted.slice(0, height) : fitted.slice(fitted.length - height)
}
```

`src/panels/color.ts`:
```ts
const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`

export const color = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  boldYellow: wrap('1;33'),
  boldRed: wrap('1;31'),
  boldCyan: wrap('1;36'),
}

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
```

`src/panels/views.ts`:
```ts
import { FlowState } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { SessionRecord } from '../hooks/handle.js'
import { color } from './color.js'

export function flowPanelLines(flow: FlowState | null, opts: { guards: boolean; idle: boolean | null }): string[] {
  if (!flow) return ['hece', '', 'No flow yet.', 'Ask Claude to build', 'something to start one.']
  const lines = renderFlow(flow, { guards: opts.guards }).split('\n')
  const status = opts.idle === null ? [] : [opts.idle ? 'Claude: waiting for you' : 'Claude: working…']
  return [...lines.slice(0, -1), '', ...status, lines[lines.length - 1]]
}

export function colorFlowLine(line: string): string {
  const t = line.trimStart()
  if (line.includes('← waiting for you') || t.startsWith('■') || line.startsWith('Claude: waiting')) return color.boldRed(line)
  if (t.startsWith('▸')) return color.boldYellow(line)
  if (t.startsWith('✓')) return color.green(line)
  if (line.startsWith('hece')) return color.bold(line)
  if (line.startsWith('guards:') || line.startsWith('Claude:')) return color.dim(line)
  return line
}

export function sessionsPanelLines(sessions: SessionRecord[]): string[] {
  if (sessions.length === 0) return ['Sessions', '', 'none yet']
  return [
    'Sessions',
    '',
    ...sessions.slice(-8).map((s) => `• ${s.source === 'startup' ? 'main' : s.source} ${s.sessionId.slice(0, 8)}`),
  ]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/panels && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panels/fit.ts src/panels/color.ts src/panels/views.ts test/panels/views.test.ts
git commit -m "feat: flow and sessions panel views"
```

---

### Task 5: `hece panel <widget>`

**Files:**
- Create: `src/panels/main.ts`
- Modify: `src/cli.ts` (add the `panel` route)
- Test: `test/panels/panel-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4, `statePaths`, `readJson`, `readEvents`, `loadPrefs`, `resolveRoot`, `emptyFlow`, `SessionRecord`
- Produces:
  - `type PanelWidget = 'flow' | 'activity' | 'sessions'`
  - `panelFrame(widget, root, env, size: { width; height }): string[]` (coloured lines, already fitted)
  - `runPanel(argv: string[]): Promise<void>`. `--once` prints one frame and exits. Otherwise it runs an alternate-screen loop that re-reads every 300 ms, redraws only on change or resize, and restores the terminal on SIGINT, SIGTERM or SIGHUP.
- Size: `process.stdout.columns`/`rows`, falling back to `HECE_PANEL_WIDTH`/`HECE_PANEL_HEIGHT`, then 40×24.

- [ ] **Step 1: Write the failing test**

`test/panels/panel-cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { appendEvent } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, approve } from '../../src/flow/flow.js'
import { stripAnsi } from '../../src/panels/color.js'

const size = { HECE_PANEL_WIDTH: '40', HECE_PANEL_HEIGHT: '20' }
const panel = (root: string, widget: string) => {
  const r = runCli(['panel', widget, '--once'], { root, env: size })
  return { ...r, text: stripAnsi(r.stdout) }
}

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
    expect(panel(tmpProject(), 'flow').text).toContain('No flow yet.')
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
  })

  it('rejects an unknown widget', () => {
    const r = runCli(['panel', 'nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece panel')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/panels/panel-cli.test.ts`
Expected: FAIL. `panel` is not routed yet, so the CLI passes it through to claude.

- [ ] **Step 3: Implement**

`src/panels/main.ts`:
```ts
import fs from 'node:fs'
import { resolveRoot, statePaths } from '../state/paths.js'
import { readJson, readEvents } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { loadPrefs } from '../prefs/load.js'
import { SessionRecord } from '../hooks/handle.js'
import { buildActivity } from '../activity/view.js'
import { fitLine, fitLines } from './fit.js'
import { color } from './color.js'
import { flowPanelLines, colorFlowLine, sessionsPanelLines } from './views.js'

export type PanelWidget = 'flow' | 'activity' | 'sessions'
const WIDGETS: readonly string[] = ['flow', 'activity', 'sessions']

function safeJson<T>(file: string): T | null {
  try {
    return readJson<T | null>(file, null)
  } catch {
    return null
  }
}

export function panelFrame(
  widget: PanelWidget,
  root: string,
  env: NodeJS.ProcessEnv,
  size: { width: number; height: number },
): string[] {
  const paths = statePaths(root)
  let flow: FlowState | null = null
  let problem = ''
  if (fs.existsSync(paths.flow)) {
    try {
      flow = readJson<FlowState>(paths.flow, emptyFlow())
    } catch (err) {
      problem = `⚠ ${(err as Error).message}`
    }
  }
  const { width, height } = size

  if (widget === 'flow') {
    const { prefs } = loadPrefs(env, root)
    const agent = safeJson<{ idle?: boolean }>(paths.agent)
    const lines = flowPanelLines(flow, { guards: prefs.guards, idle: flow && agent ? Boolean(agent.idle) : null })
    if (problem) lines.unshift(problem, '')
    return fitLines(lines, width, height, 'top').map(colorFlowLine)
  }

  if (widget === 'sessions') {
    const lines = sessionsPanelLines(safeJson<SessionRecord[]>(paths.sessions) ?? [])
    return fitLines(lines, width, height, 'top').map((l, i) => (i === 0 ? color.bold(l) : l))
  }

  const view = buildActivity(readEvents(paths.events).slice(-500), { root, flow: flow ?? emptyFlow() }, Math.max(1, height - 2))
  const head = [color.bold(fitLine('Activity', width)), '']
  if (problem) return [...head, color.red(fitLine(problem, width))]
  if (view.length === 0) {
    return [...head, ...fitLines(["Nothing yet. Claude's steps", 'show up here in plain words.'], width, height - 2, 'top').map(color.dim)]
  }
  const paint = { header: color.boldCyan, note: color.yellow, action: (s: string) => s, alert: color.red, milestone: color.green }
  return [...head, ...view.map((v) => paint[v.kind](fitLine(v.text, width)))]
}

export async function runPanel(argv: string[]): Promise<void> {
  const widget = argv[0]
  if (!widget || !WIDGETS.includes(widget)) {
    process.stderr.write('usage: hece panel <flow|activity|sessions> [--once]\n')
    process.exitCode = 1
    return
  }
  const root = resolveRoot(process.env)
  const size = () => ({
    width: process.stdout.columns || Number(process.env.HECE_PANEL_WIDTH) || 40,
    height: process.stdout.rows || Number(process.env.HECE_PANEL_HEIGHT) || 24,
  })
  const frame = (): string[] => {
    try {
      return panelFrame(widget as PanelWidget, root, process.env, size())
    } catch (err) {
      return [`⚠ ${(err as Error).message}`]
    }
  }

  if (argv.includes('--once')) {
    process.stdout.write(frame().join('\n') + '\n')
    return
  }

  const out = process.stdout
  out.write('\x1b[?1049h\x1b[?25l') // alternate screen, hide cursor
  let last = ''
  const draw = (force = false) => {
    const text = frame().map((l) => l + '\x1b[K').join('\r\n') + '\x1b[J'
    if (force || text !== last) {
      out.write('\x1b[H' + text) // overwrite in place: no clear, no flicker
      last = text
    }
  }
  draw(true)
  const timer = setInterval(() => draw(), 300)
  out.on('resize', () => draw(true))
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer)
      out.write('\x1b[?25h\x1b[?1049l')
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
  })
}
```

`src/cli.ts`: add `import { runPanel } from './panels/main.js'` and, before the `help` check, `if (cmd === 'panel') return runPanel(argv.slice(1))`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panels/main.ts src/cli.ts test/panels/panel-cli.test.ts
git commit -m "feat: hece panel renders flow, activity and sessions"
```

---

### Task 6: The frame launcher

**Files:**
- Create: `src/frame/main.ts`
- Modify: `src/cli.ts` (`--no-frame` route; default route goes to `runFrame`; usage text)
- Test: `test/frame/frame.test.ts`

**Interfaces:**
- Consumes: `pluginRoot`, `runLaunch` (src/launch/main.ts), `loadPrefs`, `resolveRoot`, `Widget`
- Produces:
  - `frameName(root: string): string`, which is `hece-` plus the first 8 hex chars of sha1(root). It is used as both the tmux socket and the session name.
  - `shellQuote(s: string): string`
  - `frameDecision(argv, { stdinTTY, stdoutTTY, env, tmuxAvailable }): 'frame' | 'plain' | 'plain-no-tmux'`
  - `openFrame(o: FrameOptions, deps: FrameDeps): number`
  - `runFrame(argv: string[]): Promise<void>`
  - `FrameOptions { root; claudeArgv: string[]; layout: { left: Widget; right: Widget }; node; cli; tmuxBin }`
  - `FrameDeps { tmux(args): { status: number; stdout: string }; attach(args): number }`

- [ ] **Step 1: Write the failing test**

`test/frame/frame.test.ts`:
```ts
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
```

Also add a process-level test to `test/launch/launch.test.ts`, inside its existing describe block. Reuse the file's fake-claude helper (the test that checks `['-c', '--model', 'sonnet']` already creates it):
```ts
  it('--no-frame runs Claude directly and drops the flag', () => {
    // same fake-claude setup as the passthrough tests in this file
    const r = runCli(['--no-frame', '-c'], { root, env: { HECE_CLAUDE_BIN: fakeClaude } })
    expect(JSON.parse(r.stdout)).toEqual(['--plugin-dir', REPO_ROOT, '-c'])
  })
```
Adapt the variable names (`root`, `fakeClaude`, `REPO_ROOT`) to whatever that file already uses. Without a TTY, the default route stays plain, so the existing launch tests keep passing unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/frame test/launch`
Expected: FAIL, cannot resolve `../../src/frame/main.js`, and `--no-frame` is passed to claude as an argument.

- [ ] **Step 3: Implement**

`src/frame/main.ts`:
```ts
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { pluginRoot, runLaunch } from '../launch/main.js'
import { loadPrefs } from '../prefs/load.js'
import { resolveRoot } from '../state/paths.js'
import { Widget } from '../prefs/schema.js'

export interface FrameOptions {
  root: string
  claudeArgv: string[]
  layout: { left: Widget; right: Widget }
  node: string
  cli: string
  tmuxBin: string
}

export interface FrameDeps {
  tmux: (args: string[]) => { status: number; stdout: string }
  attach: (args: string[]) => number
}

const LEFT_WIDTH = 40
const RIGHT_WIDTH = 36
const PLAIN_FLAGS = new Set(['-p', '--print', '--version', '-v', '--help', '-h'])
const TITLES: Record<Widget, string> = { flow: 'Flow', activity: 'Activity', sessions: 'Sessions', none: '' }

export function frameName(root: string): string {
  return 'hece-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function frameDecision(
  argv: string[],
  o: { stdinTTY: boolean; stdoutTTY: boolean; env: NodeJS.ProcessEnv; tmuxAvailable: boolean },
): 'frame' | 'plain' | 'plain-no-tmux' {
  if (!o.stdinTTY || !o.stdoutTTY || o.env.TMUX || argv.some((a) => PLAIN_FLAGS.has(a))) return 'plain'
  return o.tmuxAvailable ? 'frame' : 'plain-no-tmux'
}

export function openFrame(o: FrameOptions, deps: FrameDeps): number {
  const name = frameName(o.root)
  const t = (...args: string[]) => deps.tmux(['-L', name, ...args])
  const attach = () => deps.attach(['-L', name, 'attach', '-t', name])
  if (t('has-session', '-t', name).status === 0) return attach()

  const q = (args: string[]) => args.map(shellQuote).join(' ')
  // when Claude exits, the whole window closes
  const middle = `${q([o.node, o.cli, '--no-frame', ...o.claudeArgv])}; ${q([o.tmuxBin, '-L', name, 'kill-server'])}`
  const panel = (w: Widget) => q([o.node, o.cli, 'panel', w])
  const id = (r: { stdout: string }) => r.stdout.trim()

  const mid = id(t('new-session', '-d', '-s', name, '-c', o.root, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', middle))
  const left = o.layout.left !== 'none'
    ? id(t('split-window', '-hb', '-t', mid, '-l', String(LEFT_WIDTH), '-c', o.root, '-P', '-F', '#{pane_id}', panel(o.layout.left)))
    : undefined
  const right = o.layout.right !== 'none'
    ? id(t('split-window', '-h', '-t', mid, '-l', String(RIGHT_WIDTH), '-c', o.root, '-P', '-F', '#{pane_id}', panel(o.layout.right)))
    : undefined

  for (const [opt, value] of [
    ['mouse', 'on'],
    ['escape-time', '10'],
    ['status-style', 'bg=colour236,fg=white'],
    ['status-left', ' hece '],
    ['status-right', ' F1 left · F2 claude · F3 right · click a pane to focus '],
    ['status-right-length', '80'],
    ['pane-border-status', 'top'],
    ['pane-border-format', ' #{pane_title} '],
    ['pane-active-border-style', 'fg=yellow'],
  ]) t('set', '-g', opt, value)

  t('select-pane', '-t', mid, '-T', 'claude')
  if (left) t('select-pane', '-t', left, '-T', TITLES[o.layout.left])
  if (right) t('select-pane', '-t', right, '-T', TITLES[o.layout.right])

  // keep side panels at a fixed width when the terminal is resized
  const fix = [left && `resize-pane -t ${left} -x ${LEFT_WIDTH}`, right && `resize-pane -t ${right} -x ${RIGHT_WIDTH}`]
    .filter(Boolean)
    .join(' ; ')
  if (fix) {
    t('set-hook', '-g', 'client-resized', fix)
    t('set-hook', '-g', 'client-attached', fix)
  }

  t('bind', '-n', 'F1', 'select-pane', '-t', left ?? mid)
  t('bind', '-n', 'F2', 'select-pane', '-t', mid)
  t('bind', '-n', 'F3', 'select-pane', '-t', right ?? mid)
  t('select-pane', '-t', mid)
  return attach()
}

export async function runFrame(argv: string[]): Promise<void> {
  const env = process.env
  const tmuxBin = env.HECE_TMUX_BIN || 'tmux'
  const tmuxAvailable = () => spawnSync(tmuxBin, ['-V'], { stdio: 'ignore' }).status === 0
  const decision = frameDecision(argv, {
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    env,
    tmuxAvailable: Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.TMUX) && tmuxAvailable(),
  })
  if (decision === 'plain') return runLaunch(argv)
  if (decision === 'plain-no-tmux') {
    process.stderr.write('hece: tmux not found, so starting without panels. Install it for the full window (macOS: brew install tmux).\n')
    return runLaunch(argv)
  }
  const root = resolveRoot(env)
  const { prefs } = loadPrefs(env, root)
  process.exitCode = openFrame(
    { root, claudeArgv: argv, layout: prefs.layout, node: process.execPath, cli: path.join(pluginRoot(), 'dist', 'cli.js'), tmuxBin },
    {
      tmux: (args) => {
        const r = spawnSync(tmuxBin, args, { encoding: 'utf8' })
        return { status: r.status ?? 1, stdout: r.stdout ?? '' }
      },
      attach: (args) => spawnSync(tmuxBin, args, { stdio: 'inherit' }).status ?? 0,
    },
  )
}
```

`src/cli.ts`: the final version routes, in order: `hook`, `mcp`, `status`, `panel`, `help`, then `--no-frame` (as the first argument) → `runLaunch(argv.slice(1))`, then everything else → `runFrame(argv)`. Import `runFrame` from `./frame/main.js`. Replace `USAGE` with:
```ts
const USAGE = `usage: hece [claude args…]          open the hece window: Activity · Claude · Flow
       hece --no-frame [claude args…]   Claude Code with hece loaded, no panels
       hece status                      show where you are in the flow
       hece panel <flow|activity|sessions>   run one panel (used by the window)
       hece help                        show this help
(hece hook and hece mcp are run by Claude Code itself)
`
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frame/main.ts src/cli.ts test/frame/frame.test.ts test/launch/launch.test.ts
git commit -m "feat: hece opens a three-pane window around Claude"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Update README**

1. Replace the status line (`> **Status: early (v0.1, core engine).** …`) with:
   `> **Status: early (v0.1).** \`hece\` opens one terminal window: Activity on the left, Claude Code in the middle, your flow on the right. The panels are read-only for now. See the [roadmap](#roadmap).`
2. Change the screenshot caption's first sentence to `**Early prototype from the feasibility spike.** The shipped window has the same layout.` Keep the rest of the caption.
3. In **Requirements**, add: `- [tmux](https://github.com/tmux/tmux) for the three-pane window (\`brew install tmux\` on macOS). Without it, \`hece\` still works, just without panels.`
4. In **Quick start**, after `hece`, add:
   ```markdown
   `hece` opens the window. The **Activity** panel tells you what Claude is doing in plain words ("Now: saving only a hash of the token…", "changing src/auth/reset.ts", "running the tests"), and the **Flow** panel shows where you are. Use `hece --no-frame` for Claude Code with hece but without panels. Inside an existing tmux session, or when piping (`hece -p …`), hece runs without panels automatically.
   ```
5. In **Roadmap**, replace item 2 with:
   ```markdown
   2. **Frame:** ✅ the three-pane window with plain-language Activity and the live Flow (2a). Next (2b): panel keys that talk to Claude (Enter = continue), side chats, and arrow navigation.
   ```

- [ ] **Step 2: Update CONTRIBUTING**

In **Project layout**, add these lines after `src/status`:
```
src/activity   plain-language Activity lines from hece events
src/panels     `hece panel`: Flow / Activity / Sessions renderers
src/frame      `hece`: the tmux three-pane window
```

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run`
Expected: PASS.

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: the hece window"
```

---

### Task 8: Smoke test in a real terminal (👤 human + controller)

- [ ] **Step 1:** If `tmux -V` fails, the controller asks the user for permission and then runs `brew install tmux`.
- [ ] **Step 2:** `npm run build`. The global `hece` link points at this repo, so it picks up the build.
- [ ] **Step 3 (👤):** in a full-screen terminal, run `cd /tmp/hece-demo && hece`. Check:
  - three panes appear;
  - the middle pane is Claude;
  - Flow says "No flow yet";
  - when you ask Claude to build something with hece, Activity shows `Now: …` lines and plain actions with no raw commands, and Flow updates;
  - resizing keeps the side widths;
  - F1/F2/F3 move focus;
  - `/exit` in Claude closes the whole window;
  - running `hece` again in the same folder while the window is open reattaches to it.
- [ ] **Step 4:** write anything surprising to `docs/notes/2026-10-20-frame-smoke.md` and commit it as `docs: frame smoke notes`.
