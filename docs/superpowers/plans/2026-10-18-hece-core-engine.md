# hece Core Engine Implementation Plan (v0.1, plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hece works inside plain Claude Code (no panels yet). An orchestrator follows hece's skills through discuss → plan → build slices → review → recap. Flow state lives in `.hece/state/`, the two guards hold, and `hece status` shows where you are.

**Architecture:** One Node CLI (`hece`) with three subcommands: `hook` (Claude Code hook handler: activity log, approval detection, guards), `mcp` (stdio MCP server exposing `flow_*` and `prefs_get`), and `status` (prints the flow). Pure modules (`flow`, `prefs`, `guards`) hold the logic. `state` does file I/O. The repo root is also a Claude Code plugin (`.claude-plugin/`, `skills/`, `hooks/`, `.mcp.json`), following superpowers' layout, so `claude --plugin-dir .` loads everything.

**Tech Stack:** Node ≥20 (dev machine: 25), TypeScript 7, ESM, `@modelcontextprotocol/sdk` 1.32, `zod` 4, `yaml` 2, `vitest` 5, `tsx` (to run TS in integration tests).

**Spec:** `docs/superpowers/specs/2026-10-18-hece-design.md`

**v0.1 is split into four plans,** each producing working software:
1. **Core engine** (this plan): state, flow, prefs, guards, hook, MCP, status, skills, Claude Code plugin.
2. **Frame:** launcher, tmux layout, Flow/Activity/Sessions panels, actions and transports, side chats.
3. **Onboarding:** `hece setup`, `hece prefs`, `hece doctor`.
4. **Release:** bundling (so plugin installs don't need a build), CI, README with the vendor table, `adapters/*` placeholders, LICENSE, public repo.

**Deviation from spec §10.7, deliberate:** Claude Code plugin manifests live at the repo root (`.claude-plugin/`, `hooks/`, `.mcp.json`) because that's where Claude Code and its marketplace look, the same as superpowers. Adapter *code* lives in `src/`. Planned vendors get `adapters/<vendor>/README.md` in plan 4.

## Global Constraints

- Node `>=20`; ESM only (`"type": "module"`); relative imports end in `.js`.
- State lives under `<project>/.hece/state/`: `flow.json`, `events.jsonl`, `sessions.json`, `agent.json`. All JSON writes are atomic (temp file + rename).
- Project root resolution order: `HECE_ROOT` → `CLAUDE_PROJECT_DIR` → hook payload `cwd` → `process.cwd()`.
- Preferences: global `${XDG_CONFIG_HOME:-~/.config}/hece/preferences.yaml`, project `.hece/preferences.yaml`; project overrides global key by key; invalid values are rejected with a message naming the key and the allowed values.
- **There is no approve tool.** Approval comes only from the human: a typed message that is exactly one of `continue`, `ok`, `next`, `go`, `approve` (case-insensitive, trailing `.`/`!` allowed), or the native picker answer `Continue`.
- Guards (when `guards: on`) deny only `Edit`, `Write`, `MultiEdit`, `NotebookEdit`. Bash is never blocked.
- hece hooks must never break Claude Code: always exit 0. Failures are logged as `hook_error` events (visible), not thrown.
- Hooks do nothing in projects without `.hece/state/flow.json`. The flow starts when the agent first calls an MCP flow tool.
- Communication caps: `line` = 1 line, `short` ≤ 5 lines, `detailed` ≤ 15 lines; diagrams don't count.
- Commits: author is the user. **Never add a `Co-Authored-By: Claude` trailer.**

## Review Focus

1. **YAML `on`/`off`.** `yaml` v2 parses `guards: off` as the *string* `"off"`. Users expect it to mean false. Pinned in Task 4.
2. **Malformed or empty hook stdin.** The hook must exit 0, print nothing, and log `hook_error` if a flow exists. It must never block the agent. Pinned in Task 6.
3. **Approval phrasing.** `"Continue."`, `" OK "` and `"GO!"` approve. `"ok but why X?"` and `"continue with the tests first"` must not. Pinned in Task 5.
4. **Projects without hece.** The plugin is installed globally, so hooks fire in every project. With no `.hece/state/flow.json`, the hook must write nothing at all. Pinned in Task 6.
5. **Typo in preferences** (`gaurds: off`). It must produce an error naming the key, and guards must stay at the safe default (on). It must not be silently ignored. Pinned in Task 4.

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts
src/cli.ts                  # subcommand router: hook | mcp | status
src/state/paths.ts          # resolveRoot, statePaths
src/state/store.ts          # readJson, writeJsonAtomic, appendEvent, readEvents
src/flow/types.ts           # FlowState and friends, emptyFlow
src/flow/flow.ts            # pure transitions + approve (human-only)
src/flow/render.ts          # renderFlow → text (status, flow_get, later panels)
src/prefs/schema.ts         # Prefs type, presets, validate, resolve
src/prefs/load.ts           # read YAML files, loadPrefs
src/guards/guards.ts        # decideTool, isContinueIntent, pickerApproved
src/hooks/handle.ts         # handleHook(payload, ctx) → result (testable)
src/hooks/main.ts           # stdin → handleHook → stdout; capture mode
src/mcp/server.ts           # createServer (tools)
src/mcp/main.ts             # stdio transport
src/status/main.ts          # hece status
skills/{flow,slice-stop,check-question,communicate,review-findings,recap}/SKILL.md
.claude-plugin/plugin.json, hooks/hooks.json, .mcp.json
test/helpers.ts, test/**/*.test.ts, test/fixtures/claude-code/*.json
```

---

### Task 1: Project scaffold and state store

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/state/paths.ts`, `src/state/store.ts`
- Test: `test/state/store.test.ts`

**Interfaces:**
- Produces:
  - `resolveRoot(env: NodeJS.ProcessEnv, payloadCwd?: string): string`
  - `statePaths(root: string): StatePaths` with `{ root, heceDir, stateDir, flow, events, sessions, agent, captures }`
  - `class StateError extends Error`
  - `readJson<T>(file: string, fallback: T): T`: returns the fallback if the file is missing, **throws StateError** if it's invalid JSON
  - `writeJsonAtomic(file: string, value: unknown): void`
  - `interface HeceEvent { at: number; event: string; [k: string]: unknown }`
  - `appendEvent(file: string, ev: HeceEvent): void`, `readEvents(file: string): HeceEvent[]`

- [ ] **Step 1: Create the project files and install dependencies**

`package.json`:
```json
{
  "name": "hece",
  "version": "0.1.0",
  "description": "Stay in the loop while AI agents build: discussion, small slices, a stop after each.",
  "type": "module",
  "bin": { "hece": "dist/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000 },
})
```

Run:
```bash
npm install yaml@^2.9 @modelcontextprotocol/sdk@^1.32 zod@^4
npm install -D typescript@^7 vitest@^5 tsx @types/node
```

- [ ] **Step 2: Write the failing test**

`test/state/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJson, writeJsonAtomic, appendEvent, readEvents, StateError } from '../../src/state/store.js'
import { statePaths, resolveRoot } from '../../src/state/paths.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-'))
})

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
  it('creates parent dirs, writes JSON, and leaves no temp files', () => {
    const f = path.join(dir, 'a', 'b', 'x.json')
    writeJsonAtomic(f, { n: 1 })
    expect(readJson(f, null)).toEqual({ n: 1 })
    expect(fs.readdirSync(path.dirname(f))).toEqual(['x.json'])
  })
})

describe('events', () => {
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
  it('puts state under .hece/state', () => {
    const p = statePaths('/p')
    expect(p.flow).toBe(path.join('/p', '.hece', 'state', 'flow.json'))
    expect(p.captures).toBe(path.join('/p', '.hece', 'state', 'captures'))
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/state/store.test.ts`
Expected: FAIL, cannot resolve `../../src/state/store.js`.

- [ ] **Step 4: Write the implementation**

`src/state/paths.ts`:
```ts
import path from 'node:path'

export interface StatePaths {
  root: string
  heceDir: string
  stateDir: string
  flow: string
  events: string
  sessions: string
  agent: string
  captures: string
}

export function resolveRoot(env: NodeJS.ProcessEnv, payloadCwd?: string): string {
  return env.HECE_ROOT || env.CLAUDE_PROJECT_DIR || payloadCwd || process.cwd()
}

export function statePaths(root: string): StatePaths {
  const heceDir = path.join(root, '.hece')
  const stateDir = path.join(heceDir, 'state')
  return {
    root,
    heceDir,
    stateDir,
    flow: path.join(stateDir, 'flow.json'),
    events: path.join(stateDir, 'events.jsonl'),
    sessions: path.join(stateDir, 'sessions.json'),
    agent: path.join(stateDir, 'agent.json'),
    captures: path.join(stateDir, 'captures'),
  }
}
```

`src/state/store.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'

export class StateError extends Error {}

export interface HeceEvent {
  at: number
  event: string
  [key: string]: unknown
}

export function readJson<T>(file: string, fallback: T): T {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new StateError(`hece: ${file} is not valid JSON`)
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function appendEvent(file: string, ev: HeceEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(ev) + '\n')
}

export function readEvents(file: string): HeceEvent[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: HeceEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev && typeof ev.event === 'string') out.push(ev)
    } catch {
      // a crash mid-append can leave a truncated last line; skip it
    }
  }
  return out
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/state/store.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/state test/state
git commit -m "feat: project scaffold and atomic state store"
```

---

### Task 2: Flow model

**Files:**
- Create: `src/flow/types.ts`, `src/flow/flow.ts`
- Test: `test/flow/flow.test.ts`

**Interfaces:**
- Produces (types): `Phase`, `PHASES`, `SliceKind`, `SliceStatus`, `Decision`, `Slice`, `Plan`, `ReviewSummary`, `FlowState`, `SliceInput`, `emptyFlow(): FlowState`
- Produces (functions, all pure, return a new state, throw `FlowError`):
  - `setPhase(s: FlowState, phase: Phase, now: number): FlowState`
  - `addDecision(s: FlowState, d: { title: string; choice: string; why: string }, now: number): FlowState`
  - `setPlan(s: FlowState, input: SliceInput[], now: number): FlowState`
  - `startSlice(s: FlowState, n: number, opts: { guards: boolean }, now: number): FlowState`
  - `finishSlice(s: FlowState, n: number, info: { summary: string; connectsTo: string }, now: number): FlowState`
  - `reportReview(s: FlowState, r: { important: number; minor: number }, now: number): FlowState`
  - `type Approved = { what: 'plan' } | { what: 'slice'; n: number } | null`
  - `approve(s: FlowState, now: number): { state: FlowState; approved: Approved }`: **human-only**; called by hooks, never exposed as an MCP tool.

- [ ] **Step 1: Write the failing test**

`test/flow/flow.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow, SliceInput } from '../../src/flow/types.js'
import {
  setPhase, addDecision, setPlan, startSlice, finishSlice, reportReview, approve, FlowError,
} from '../../src/flow/flow.js'

const slices: SliceInput[] = [
  { title: 'Token model', files: ['src/token.ts'], kind: 'teaching', model: 'sonnet' },
  { title: 'Login endpoint', files: ['src/login.ts'], kind: 'routine' },
]
const planned = () => setPlan(setPhase(emptyFlow(), 'discuss', 1), slices, 2)
const approvedPlan = () => approve(planned(), 3).state

describe('flow', () => {
  it('starts idle and moves phases', () => {
    expect(emptyFlow().phase).toBe('idle')
    expect(setPhase(emptyFlow(), 'discuss', 5)).toMatchObject({ phase: 'discuss', updatedAt: 5 })
  })

  it('rejects unknown phases', () => {
    expect(() => setPhase(emptyFlow(), 'ship' as never, 1)).toThrow(FlowError)
  })

  it('does not mutate its input', () => {
    const s = emptyFlow()
    addDecision(s, { title: 'Auth', choice: 'JWT', why: 'stateless' }, 1)
    expect(s.decisions).toEqual([])
  })

  it('records decisions', () => {
    const s = addDecision(emptyFlow(), { title: 'Auth', choice: 'JWT', why: 'stateless' }, 9)
    expect(s.decisions).toEqual([{ title: 'Auth', choice: 'JWT', why: 'stateless', at: 9 }])
  })

  it('sets a plan that needs approval and moves to the plan phase', () => {
    const s = planned()
    expect(s.phase).toBe('plan')
    expect(s.plan).toMatchObject({ approved: false, changed: false })
    expect(s.plan!.slices.map((x) => [x.n, x.status])).toEqual([[1, 'todo'], [2, 'todo']])
  })

  it('rejects an empty plan', () => {
    expect(() => setPlan(emptyFlow(), [], 1)).toThrow('at least one slice')
  })

  it('approve() approves a pending plan first', () => {
    const { state, approved } = approve(planned(), 3)
    expect(approved).toEqual({ what: 'plan' })
    expect(state.plan!.approved).toBe(true)
  })

  it('approve() returns null when nothing is waiting', () => {
    expect(approve(emptyFlow(), 1).approved).toBeNull()
  })

  it('with guards, refuses to start a slice before the plan is approved', () => {
    expect(() => startSlice(planned(), 1, { guards: true }, 4)).toThrow('plan is waiting')
  })

  it('without guards, allows starting before approval', () => {
    expect(startSlice(planned(), 1, { guards: false }, 4).plan!.slices[0].status).toBe('working')
  })

  it('runs a slice: start → finish (stopped) → approve', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    expect(s).toMatchObject({ phase: 'build', currentSlice: 1 })
    s = finishSlice(s, 1, { summary: 'added Token', connectsTo: 'used by login' }, 5)
    expect(s.plan!.slices[0]).toMatchObject({ status: 'stopped', summary: 'added Token', connectsTo: 'used by login' })
    const r = approve(s, 6)
    expect(r.approved).toEqual({ what: 'slice', n: 1 })
    expect(r.state.plan!.slices[0].status).toBe('approved')
  })

  it('with guards, refuses the next slice while one is waiting for the user', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    expect(() => startSlice(s, 2, { guards: true }, 6)).toThrow('slice 1 is waiting for the user')
  })

  it('allows redoing the stopped slice itself', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    expect(startSlice(s, 1, { guards: true }, 6).plan!.slices[0].status).toBe('working')
  })

  it('refuses to finish a slice that is not in progress', () => {
    expect(() => finishSlice(approvedPlan(), 1, { summary: 'x', connectsTo: 'y' }, 5)).toThrow('not in progress')
  })

  it('refuses unknown slices with a helpful message', () => {
    expect(() => startSlice(approvedPlan(), 7, { guards: true }, 4)).toThrow('no slice 7; the plan has 2')
    expect(() => startSlice(emptyFlow(), 1, { guards: true }, 4)).toThrow('no plan yet')
  })

  it('a changed plan needs approval again and keeps approved slices', () => {
    let s = startSlice(approvedPlan(), 1, { guards: true }, 4)
    s = finishSlice(s, 1, { summary: 'x', connectsTo: 'y' }, 5)
    s = approve(s, 6).state
    s = setPlan(s, [...slices, { title: 'Logout', files: ['src/logout.ts'], kind: 'routine' }], 7)
    expect(s.plan).toMatchObject({ approved: false, changed: true })
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['approved', 'todo', 'todo'])
    expect(s.phase).toBe('build')
  })

  it('reports review counts and enters the review phase', () => {
    expect(reportReview(emptyFlow(), { important: 2, minor: 3 }, 8)).toMatchObject({
      phase: 'review',
      review: { important: 2, minor: 3, at: 8 },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow/flow.test.ts`
Expected: FAIL, cannot resolve `../../src/flow/types.js`.

- [ ] **Step 3: Write the implementation**

`src/flow/types.ts`:
```ts
export type Phase = 'idle' | 'discuss' | 'plan' | 'build' | 'review' | 'recap' | 'done'
export const PHASES: readonly Phase[] = ['idle', 'discuss', 'plan', 'build', 'review', 'recap', 'done']
export type SliceKind = 'routine' | 'teaching'
export type SliceStatus = 'todo' | 'working' | 'stopped' | 'approved'

export interface Decision {
  title: string
  choice: string
  why: string
  at: number
}

export interface Slice {
  n: number
  title: string
  files: string[]
  kind: SliceKind
  model?: string
  status: SliceStatus
  summary?: string
  connectsTo?: string
}

export interface Plan {
  slices: Slice[]
  approved: boolean
  changed: boolean
}

export interface ReviewSummary {
  important: number
  minor: number
  at: number
}

export interface FlowState {
  version: 1
  phase: Phase
  decisions: Decision[]
  plan: Plan | null
  currentSlice: number | null
  review: ReviewSummary | null
  updatedAt: number
}

export interface SliceInput {
  title: string
  files: string[]
  kind: SliceKind
  model?: string
}

export function emptyFlow(): FlowState {
  return { version: 1, phase: 'idle', decisions: [], plan: null, currentSlice: null, review: null, updatedAt: 0 }
}
```

`src/flow/flow.ts`:
```ts
import { FlowState, Phase, PHASES, Slice, SliceInput } from './types.js'

export class FlowError extends Error {}

const clone = (s: FlowState): FlowState => structuredClone(s)

export function setPhase(s: FlowState, phase: Phase, now: number): FlowState {
  if (!PHASES.includes(phase)) throw new FlowError(`unknown phase "${phase}"; valid: ${PHASES.join(', ')}`)
  const next = clone(s)
  next.phase = phase
  next.updatedAt = now
  return next
}

export function addDecision(s: FlowState, d: { title: string; choice: string; why: string }, now: number): FlowState {
  const next = clone(s)
  next.decisions.push({ title: d.title, choice: d.choice, why: d.why, at: now })
  next.updatedAt = now
  return next
}

export function setPlan(s: FlowState, input: SliceInput[], now: number): FlowState {
  if (input.length === 0) throw new FlowError('a plan needs at least one slice')
  const next = clone(s)
  const prev = s.plan
  const slices: Slice[] = input.map((x, i) => {
    const n = i + 1
    const old = prev?.slices.find((p) => p.n === n && p.title === x.title)
    if (old && old.status === 'approved') return { ...old, files: x.files, kind: x.kind, model: x.model }
    return { n, title: x.title, files: x.files, kind: x.kind, model: x.model, status: 'todo' }
  })
  next.plan = { slices, approved: false, changed: prev !== null }
  if (next.currentSlice !== null && next.currentSlice > slices.length) next.currentSlice = null
  if (next.phase === 'idle' || next.phase === 'discuss') next.phase = 'plan'
  next.updatedAt = now
  return next
}

function findSlice(s: FlowState, n: number): Slice {
  if (!s.plan) throw new FlowError('no plan yet; call flow_set_plan first')
  const sl = s.plan.slices.find((x) => x.n === n)
  if (!sl) throw new FlowError(`no slice ${n}; the plan has ${s.plan.slices.length}`)
  return sl
}

export function startSlice(s: FlowState, n: number, opts: { guards: boolean }, now: number): FlowState {
  const next = clone(s)
  const sl = findSlice(next, n)
  if (opts.guards) {
    if (!next.plan!.approved) throw new FlowError('hece: the plan is waiting for the user to approve it')
    const waiting = next.plan!.slices.find((x) => x.status === 'stopped' && x.n !== n)
    if (waiting) throw new FlowError(`hece: slice ${waiting.n} is waiting for the user`)
  }
  if (sl.status === 'approved') throw new FlowError(`slice ${n} is already approved`)
  sl.status = 'working'
  next.currentSlice = n
  next.phase = 'build'
  next.updatedAt = now
  return next
}

export function finishSlice(
  s: FlowState,
  n: number,
  info: { summary: string; connectsTo: string },
  now: number,
): FlowState {
  const next = clone(s)
  const sl = findSlice(next, n)
  if (sl.status !== 'working') throw new FlowError(`slice ${n} is not in progress (status: ${sl.status})`)
  sl.status = 'stopped'
  sl.summary = info.summary
  sl.connectsTo = info.connectsTo
  next.updatedAt = now
  return next
}

export function reportReview(s: FlowState, r: { important: number; minor: number }, now: number): FlowState {
  const next = clone(s)
  next.review = { important: r.important, minor: r.minor, at: now }
  next.phase = 'review'
  next.updatedAt = now
  return next
}

export type Approved = { what: 'plan' } | { what: 'slice'; n: number } | null

// Human-only. Called by hooks when the user approves; never exposed as an MCP tool.
export function approve(s: FlowState, now: number): { state: FlowState; approved: Approved } {
  const next = clone(s)
  if (next.plan && !next.plan.approved) {
    next.plan.approved = true
    next.plan.changed = false
    next.updatedAt = now
    return { state: next, approved: { what: 'plan' } }
  }
  const sl = next.plan?.slices.find((x) => x.status === 'stopped')
  if (sl) {
    sl.status = 'approved'
    next.updatedAt = now
    return { state: next, approved: { what: 'slice', n: sl.n } }
  }
  return { state: s, approved: null }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow/flow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow test/flow
git commit -m "feat: flow model with human-only approval"
```

---

### Task 3: Flow renderer

**Files:**
- Create: `src/flow/render.ts`
- Test: `test/flow/render.test.ts`

**Interfaces:**
- Consumes: `FlowState` (Task 2)
- Produces: `renderFlow(s: FlowState, opts: { guards: boolean }): string`, used by `hece status`, `flow_get`, every flow tool result, and the panels in plan 2.

- [ ] **Step 1: Write the failing test**

`test/flow/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, addDecision, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { renderFlow } from '../../src/flow/render.js'

describe('renderFlow', () => {
  it('renders an idle flow', () => {
    expect(renderFlow(emptyFlow(), { guards: true })).toBe(
      [
        'hece · idle',
        '  Discussion (0 decisions)',
        '  Plan',
        '  Build',
        '  Review',
        '  Recap',
        'guards: on',
      ].join('\n'),
    )
  })

  it('renders a build in progress with a slice waiting for the user', () => {
    let s = addDecision(setPhase(emptyFlow(), 'discuss', 1), { title: 'Auth', choice: 'JWT', why: 'x' }, 2)
    s = setPlan(s, [
      { title: 'Token model', files: [], kind: 'teaching' },
      { title: 'Login endpoint', files: [], kind: 'routine' },
      { title: 'Refresh', files: [], kind: 'routine' },
    ], 3)
    s = approve(s, 4).state
    s = startSlice(s, 1, { guards: true }, 5)
    s = finishSlice(s, 1, { summary: 'a', connectsTo: 'b' }, 6)
    s = approve(s, 7).state
    s = startSlice(s, 2, { guards: true }, 8)
    s = finishSlice(s, 2, { summary: 'a', connectsTo: 'b' }, 9)
    expect(renderFlow(s, { guards: false })).toBe(
      [
        'hece · build',
        '✓ Discussion (1 decision)',
        '✓ Plan (3 slices)',
        '▸ Build',
        '  ✓ 1. Token model',
        '  ■ 2. Login endpoint  ← waiting for you',
        '    3. Refresh',
        '  Review',
        '  Recap',
        'guards: off',
      ].join('\n'),
    )
  })

  it('flags a changed plan waiting for approval', () => {
    let s = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }], 1)
    s = setPlan(s, [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 2)
    expect(renderFlow(s, { guards: true })).toContain('▸ Plan (2 slices) — changed, waiting for approval')
  })

  it('shows review counts and marks everything done at the end', () => {
    const s = { ...setPhase(emptyFlow(), 'done', 1), review: { important: 2, minor: 3, at: 1 } }
    const out = renderFlow(s, { guards: true })
    expect(out).toContain('✓ Review (2 important, 3 minor)')
    expect(out).toContain('✓ Recap')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow/render.test.ts`
Expected: FAIL, cannot resolve `../../src/flow/render.js`.

- [ ] **Step 3: Write the implementation**

`src/flow/render.ts`:
```ts
import { FlowState, PHASES, SliceStatus } from './types.js'

const STEPS = [
  ['discuss', 'Discussion'],
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['review', 'Review'],
  ['recap', 'Recap'],
] as const

const SLICE_MARK: Record<SliceStatus, string> = { approved: '✓', working: '▸', stopped: '■', todo: ' ' }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function renderFlow(s: FlowState, opts: { guards: boolean }): string {
  const cur = PHASES.indexOf(s.phase)
  const mark = (id: string) => {
    const i = PHASES.indexOf(id as FlowState['phase'])
    return i < cur ? '✓' : i === cur ? '▸' : ' '
  }
  const lines = [`hece · ${s.phase}`]
  for (const [id, label] of STEPS) {
    let text: string = label
    if (id === 'discuss') text += ` (${plural(s.decisions.length, 'decision')})`
    if (id === 'plan' && s.plan) {
      text += ` (${plural(s.plan.slices.length, 'slice')})`
      if (!s.plan.approved) text += s.plan.changed ? ' — changed, waiting for approval' : ' — waiting for approval'
    }
    if (id === 'review' && s.review) text += ` (${s.review.important} important, ${s.review.minor} minor)`
    lines.push(`${mark(id)} ${text}`)
    if (id === 'build' && s.plan) {
      for (const sl of s.plan.slices) {
        const wait = sl.status === 'stopped' ? '  ← waiting for you' : ''
        lines.push(`  ${SLICE_MARK[sl.status]} ${sl.n}. ${sl.title}${wait}`)
      }
    }
  }
  lines.push(`guards: ${opts.guards ? 'on' : 'off'}`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow/render.ts test/flow/render.test.ts
git commit -m "feat: text renderer for the flow"
```

---

### Task 4: Preferences

**Files:**
- Create: `src/prefs/schema.ts`, `src/prefs/load.ts`
- Test: `test/prefs/prefs.test.ts`

**Interfaces:**
- Produces:
  - `type Widget = 'flow' | 'activity' | 'sessions' | 'none'`
  - `interface Prefs`: the full shape from spec §8.2, with booleans for `review.final`, `review.show_minor`, `flow_recap`, `guards`
  - `presetDefaults(preset: Prefs['preset']): Prefs`
  - `validatePrefs(raw: unknown, source: string): { flat: Record<string, string | boolean>; errors: string[] }`
  - `resolvePrefs(layers: { raw: unknown; source: string }[]): { prefs: Prefs; errors: string[] }` (later layers win)
  - `prefsFiles(env, root, home?): { global: string; project: string }`
  - `loadPrefs(env: NodeJS.ProcessEnv, root: string, home?: string): { prefs: Prefs; errors: string[] }`. Invalid entries are dropped (the default stays) and reported in `errors`. It never throws.

- [ ] **Step 1: Write the failing test**

`test/prefs/prefs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { presetDefaults, resolvePrefs, validatePrefs } from '../../src/prefs/schema.js'
import { loadPrefs, prefsFiles } from '../../src/prefs/load.js'

let root: string
let home: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-root-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hece-home-'))
})
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('presets', () => {
  it('defaults to the Involved preset', () => {
    const p = resolvePrefs([]).prefs
    expect(p).toMatchObject({ preset: 'involved', check_questions: 'off', flow_recap: false, guards: true })
    expect(p.review).toEqual({ final: true, reviewer_model: 'opus', show_minor: false })
  })
  it('Learning turns on check questions, minor findings and the recap', () => {
    expect(presetDefaults('learning')).toMatchObject({
      check_questions: 'non-routine', flow_recap: true, review: { show_minor: true },
    })
  })
  it('explicit values beat the preset', () => {
    const p = resolvePrefs([{ raw: { preset: 'learning', check_questions: 'off' }, source: 'g' }]).prefs
    expect(p.check_questions).toBe('off')
    expect(p.flow_recap).toBe(true)
  })
})

describe('validation', () => {
  it('treats YAML on/off as booleans', () => {
    const { flat, errors } = validatePrefs({ guards: 'off', review: { final: 'on' } }, 'x')
    expect(errors).toEqual([])
    expect(flat).toEqual({ guards: false, 'review.final': true })
  })
  it('rejects a typo key by name and keeps the safe default', () => {
    const { prefs, errors } = resolvePrefs([{ raw: { gaurds: false }, source: 'p.yaml' }])
    expect(errors).toEqual(['p.yaml: unknown key "gaurds"'])
    expect(prefs.guards).toBe(true)
  })
  it('names the key and the allowed values for a bad value', () => {
    const { errors } = validatePrefs({ slice_stop: { depth: 'huge' } }, 'p.yaml')
    expect(errors).toEqual(['p.yaml: "slice_stop.depth" is "huge"; allowed: line | short | detailed'])
  })
  it('rejects a group that is not a mapping', () => {
    expect(validatePrefs({ review: 'yes' }, 'p.yaml').errors).toEqual(['p.yaml: "review" must be a mapping'])
  })
  it('rejects a non-mapping file', () => {
    expect(validatePrefs(['a'], 'p.yaml').errors).toEqual(['p.yaml: preferences must be a mapping of keys to values'])
  })
})

describe('loadPrefs', () => {
  it('reads global then project, project winning key by key', () => {
    const files = prefsFiles({}, root, home)
    write(files.global, 'guards: off\nslice_stop: { depth: detailed }\n')
    write(files.project, 'guards: on\n')
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors).toEqual([])
    expect(prefs.guards).toBe(true)
    expect(prefs.slice_stop.depth).toBe('detailed')
  })
  it('honours XDG_CONFIG_HOME', () => {
    expect(prefsFiles({ XDG_CONFIG_HOME: '/x' }, root, home).global).toBe(path.join('/x', 'hece', 'preferences.yaml'))
  })
  it('reports invalid YAML with the file path and falls back to defaults', () => {
    const files = prefsFiles({}, root, home)
    write(files.project, 'guards: [oops\n')
    const { prefs, errors } = loadPrefs({}, root, home)
    expect(errors[0]).toContain(files.project)
    expect(errors[0]).toContain('invalid YAML')
    expect(prefs.guards).toBe(true)
  })
  it('works with no files at all', () => {
    expect(loadPrefs({}, root, home)).toEqual({ prefs: presetDefaults('involved'), errors: [] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/prefs/prefs.test.ts`
Expected: FAIL, cannot resolve `../../src/prefs/schema.js`.

- [ ] **Step 3: Write the implementation**

`src/prefs/schema.ts`:
```ts
export type Widget = 'flow' | 'activity' | 'sessions' | 'none'

export interface Prefs {
  preset: 'involved' | 'learning' | 'custom'
  agent: 'claude' | 'codex' | 'gemini' | 'opencode'
  discussion: { first: 'me' | 'agent'; pushback: 'gentle' | 'direct' }
  plan: { slice_size: 'small' | 'medium' }
  slice_stop: { depth: 'line' | 'short' | 'detailed' }
  check_questions: 'off' | 'non-routine' | 'every'
  side_chats: { open_in: 'pane' | 'window' }
  review: { final: boolean; reviewer_model: string; show_minor: boolean }
  flow_recap: boolean
  layout: { left: Widget; right: Widget }
  delegate: { orchestrator: string; build: string; review: string }
  guards: boolean
}

const INVOLVED: Prefs = {
  preset: 'involved',
  agent: 'claude',
  discussion: { first: 'me', pushback: 'direct' },
  plan: { slice_size: 'small' },
  slice_stop: { depth: 'short' },
  check_questions: 'off',
  side_chats: { open_in: 'pane' },
  review: { final: true, reviewer_model: 'opus', show_minor: false },
  flow_recap: false,
  layout: { left: 'activity', right: 'flow' },
  delegate: { orchestrator: 'opus', build: 'sonnet', review: 'opus' },
  guards: true,
}

export function presetDefaults(preset: Prefs['preset']): Prefs {
  const base = structuredClone(INVOLVED)
  base.preset = preset
  if (preset === 'learning') {
    base.check_questions = 'non-routine'
    base.review.show_minor = true
    base.flow_recap = true
  }
  return base
}

type Rule = { kind: 'enum'; values: readonly string[] } | { kind: 'bool' } | { kind: 'string' }
const e = (...values: string[]): Rule => ({ kind: 'enum', values })
const BOOL: Rule = { kind: 'bool' }
const STR: Rule = { kind: 'string' }
const WIDGETS = e('flow', 'activity', 'sessions', 'none')

const RULES: Record<string, Rule> = {
  preset: e('involved', 'learning', 'custom'),
  agent: e('claude', 'codex', 'gemini', 'opencode'),
  'discussion.first': e('me', 'agent'),
  'discussion.pushback': e('gentle', 'direct'),
  'plan.slice_size': e('small', 'medium'),
  'slice_stop.depth': e('line', 'short', 'detailed'),
  check_questions: e('off', 'non-routine', 'every'),
  'side_chats.open_in': e('pane', 'window'),
  'review.final': BOOL,
  'review.reviewer_model': STR,
  'review.show_minor': BOOL,
  flow_recap: BOOL,
  'layout.left': WIDGETS,
  'layout.right': WIDGETS,
  'delegate.orchestrator': STR,
  'delegate.build': STR,
  'delegate.review': STR,
  guards: BOOL,
}

type Check = { ok: true; value: string | boolean } | { ok: false; allowed: string }

function check(rule: Rule, v: unknown): Check {
  if (rule.kind === 'enum') {
    return typeof v === 'string' && rule.values.includes(v)
      ? { ok: true, value: v }
      : { ok: false, allowed: rule.values.join(' | ') }
  }
  if (rule.kind === 'bool') {
    // yaml v2 (YAML 1.2) parses on/off/yes/no as strings, but users mean booleans
    if (typeof v === 'boolean') return { ok: true, value: v }
    if (v === 'on' || v === 'yes') return { ok: true, value: true }
    if (v === 'off' || v === 'no') return { ok: true, value: false }
    return { ok: false, allowed: 'on | off' }
  }
  return typeof v === 'string' && v.trim() !== '' ? { ok: true, value: v } : { ok: false, allowed: 'a non-empty string' }
}

export function validatePrefs(raw: unknown, source: string): { flat: Record<string, string | boolean>; errors: string[] } {
  const flat: Record<string, string | boolean> = {}
  const errors: string[] = []
  if (raw === null || raw === undefined) return { flat, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { flat, errors: [`${source}: preferences must be a mapping of keys to values`] }
  }
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      const rule = RULES[key]
      if (!rule) {
        const isGroup = Object.keys(RULES).some((r) => r.startsWith(key + '.'))
        if (isGroup && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          walk(v as Record<string, unknown>, key)
        } else {
          errors.push(isGroup ? `${source}: "${key}" must be a mapping` : `${source}: unknown key "${key}"`)
        }
        continue
      }
      const r = check(rule, v)
      if (r.ok) flat[key] = r.value
      else errors.push(`${source}: "${key}" is ${JSON.stringify(v)}; allowed: ${r.allowed}`)
    }
  }
  walk(raw as Record<string, unknown>, '')
  return { flat, errors }
}

function applyFlat(base: Prefs, flat: Record<string, string | boolean>): Prefs {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>
  for (const [key, value] of Object.entries(flat)) {
    const [group, leaf] = key.split('.')
    if (leaf === undefined) (out as unknown as Record<string, unknown>)[group] = value
    else out[group][leaf] = value
  }
  return out as unknown as Prefs
}

export function resolvePrefs(layers: { raw: unknown; source: string }[]): { prefs: Prefs; errors: string[] } {
  const validated = layers.map((l) => validatePrefs(l.raw, l.source))
  const merged: Record<string, string | boolean> = Object.assign({}, ...validated.map((v) => v.flat))
  const preset = (merged.preset as Prefs['preset'] | undefined) ?? 'involved'
  return { prefs: applyFlat(presetDefaults(preset), merged), errors: validated.flatMap((v) => v.errors) }
}
```

`src/prefs/load.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { Prefs, resolvePrefs } from './schema.js'

export function prefsFiles(env: NodeJS.ProcessEnv, root: string, home: string = os.homedir()) {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return {
    global: path.join(configHome, 'hece', 'preferences.yaml'),
    project: path.join(root, '.hece', 'preferences.yaml'),
  }
}

function readYaml(file: string): { raw: unknown; error?: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { raw: undefined }
  }
  try {
    return { raw: YAML.parse(text) }
  } catch (err) {
    return { raw: undefined, error: `${file}: invalid YAML (${(err as Error).message.split('\n')[0]})` }
  }
}

export function loadPrefs(env: NodeJS.ProcessEnv, root: string, home?: string): { prefs: Prefs; errors: string[] } {
  const files = prefsFiles(env, root, home)
  const g = readYaml(files.global)
  const p = readYaml(files.project)
  const { prefs, errors } = resolvePrefs([
    { raw: g.raw, source: files.global },
    { raw: p.raw, source: files.project },
  ])
  return { prefs, errors: [g.error, p.error, ...errors].filter((x): x is string => Boolean(x)) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/prefs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prefs test/prefs
git commit -m "feat: preferences with presets, merge, and validation"
```

---

### Task 5: Guards and approval detection

**Files:**
- Create: `src/guards/guards.ts`
- Test: `test/guards/guards.test.ts`

**Interfaces:**
- Consumes: `FlowState` (Task 2), `Prefs` (Task 4)
- Produces:
  - `EDIT_TOOLS: ReadonlySet<string>`, containing `Edit`, `Write`, `MultiEdit`, `NotebookEdit`
  - `type GuardDecision = { allow: true } | { allow: false; reason: string }`
  - `decideTool(flow: FlowState, prefs: Prefs, toolName: string): GuardDecision`
  - `isContinueIntent(text: string): boolean`
  - `pickerApproved(toolResponse: unknown): boolean`

- [ ] **Step 1: Write the failing test**

`test/guards/guards.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'
import { decideTool, isContinueIntent, pickerApproved } from '../../src/guards/guards.js'

const on = presetDefaults('involved')
const off = { ...on, guards: false }
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 1)
const approved = approve(plan, 2).state
const working = startSlice(approved, 1, { guards: true }, 3)
const stopped = finishSlice(working, 1, { summary: 's', connectsTo: 'c' }, 4)

describe('decideTool', () => {
  it('never interferes before a flow starts or after it is done', () => {
    expect(decideTool(emptyFlow(), on, 'Write')).toEqual({ allow: true })
    expect(decideTool(setPhase(stopped, 'done', 5), on, 'Write')).toEqual({ allow: true })
  })
  it('blocks edits during discussion', () => {
    const d = decideTool(setPhase(emptyFlow(), 'discuss', 1), on, 'Edit')
    expect(d).toEqual({ allow: false, reason: 'hece: no code edits during discussion; agree on a plan first' })
  })
  it('blocks edits before the plan is approved', () => {
    expect(decideTool(plan, on, 'Write')).toEqual({ allow: false, reason: 'hece: no code edits before the user approves the plan' })
  })
  it('blocks edits while a changed plan waits for approval', () => {
    const changed = setPlan(stopped, [{ title: 'A', files: [], kind: 'routine' }], 5)
    expect(decideTool(changed, on, 'Edit')).toEqual({ allow: false, reason: 'hece: the changed plan is waiting for the user to approve it' })
  })
  it('blocks edits while a slice is waiting for the user', () => {
    expect(decideTool(stopped, on, 'MultiEdit')).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
  it('allows edits while a slice is in progress', () => {
    expect(decideTool(working, on, 'Write')).toEqual({ allow: true })
  })
  it('never blocks non-edit tools such as Bash or Read', () => {
    expect(decideTool(stopped, on, 'Bash')).toEqual({ allow: true })
    expect(decideTool(stopped, on, 'Read')).toEqual({ allow: true })
  })
  it('allows everything when guards are off', () => {
    expect(decideTool(stopped, off, 'Write')).toEqual({ allow: true })
  })
})

describe('isContinueIntent', () => {
  it.each(['continue', 'Continue.', ' OK ', 'GO!', 'next', 'approve'])('approves %j', (t) => {
    expect(isContinueIntent(t)).toBe(true)
  })
  it.each(['ok but why X?', 'continue with the tests first', 'okay', 'yes', '', 'why?'])('does not approve %j', (t) => {
    expect(isContinueIntent(t)).toBe(false)
  })
})

describe('pickerApproved', () => {
  it('approves when an answer is exactly Continue', () => {
    expect(pickerApproved({ answers: { 'Slice 1 done. Next?': 'Continue' } })).toBe(true)
  })
  it('approves the text form Claude shows the model', () => {
    expect(pickerApproved('User has answered your questions: "Slice 1 done. Next?"="Continue".')).toBe(true)
  })
  it('does not approve other answers or question text that merely mentions continue', () => {
    expect(pickerApproved({ answers: { 'Continue or redo?': 'Redo' } })).toBe(false)
    expect(pickerApproved({ answers: { q: 'Continue later' } })).toBe(false)
    expect(pickerApproved(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/guards/guards.test.ts`
Expected: FAIL, cannot resolve `../../src/guards/guards.js`.

- [ ] **Step 3: Write the implementation**

`src/guards/guards.ts`:
```ts
import { FlowState } from '../flow/types.js'
import { Prefs } from '../prefs/schema.js'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type GuardDecision = { allow: true } | { allow: false; reason: string }

const deny = (reason: string): GuardDecision => ({ allow: false, reason })

export function decideTool(flow: FlowState, prefs: Prefs, toolName: string): GuardDecision {
  if (!prefs.guards || !EDIT_TOOLS.has(toolName)) return { allow: true }
  if (flow.phase === 'idle' || flow.phase === 'done') return { allow: true }
  if (flow.phase === 'discuss') return deny('hece: no code edits during discussion; agree on a plan first')
  if (!flow.plan) return deny('hece: no code edits before there is a plan')
  if (!flow.plan.approved) {
    return deny(flow.plan.changed
      ? 'hece: the changed plan is waiting for the user to approve it'
      : 'hece: no code edits before the user approves the plan')
  }
  const stopped = flow.plan.slices.find((s) => s.status === 'stopped')
  if (stopped) return deny(`hece: slice ${stopped.n} is waiting for the user`)
  return { allow: true }
}

const CONTINUE_WORDS = new Set(['continue', 'ok', 'next', 'go', 'approve'])

export function isContinueIntent(text: string): boolean {
  return CONTINUE_WORDS.has(text.trim().toLowerCase().replace(/[.!\s]+$/u, ''))
}

// The picker's tool_response shape is not documented; accept a structured answer that is
// exactly "Continue", or the `"question"="Continue"` text form. Pinned by captured fixtures (Task 11).
export function pickerApproved(toolResponse: unknown): boolean {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(toolResponse)
  return strings.some((s) => s.trim().toLowerCase() === 'continue' || /="continue"/i.test(s))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/guards && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guards test/guards
git commit -m "feat: guards and human approval detection"
```

---

### Task 6: Hook handler and `hece hook`

**Files:**
- Create: `src/hooks/handle.ts`, `src/hooks/main.ts`, `src/cli.ts`, `test/helpers.ts`
- Test: `test/hooks/handle.test.ts`, `test/hooks/cli-hook.test.ts`

**Interfaces:**
- Consumes: `statePaths`, `readJson`, `writeJsonAtomic`, `appendEvent` (Task 1); `FlowState`, `emptyFlow`, `approve` (Task 2); `Prefs`, `loadPrefs` (Task 4); `decideTool`, `isContinueIntent`, `pickerApproved` (Task 5)
- Produces:
  - `interface HookPayload { hook_event_name?: string; session_id?: string; cwd?: string; source?: string; prompt?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown }`
  - `interface HookContext { root: string; prefs: Prefs; prefsErrors: string[]; now: number }`
  - `interface SessionRecord { sessionId: string; source: string; at: number }`
  - `summarizeTool(name: string, input?: Record<string, unknown>): string`
  - `handleHook(p: HookPayload, ctx: HookContext): { stdout: string }`
  - `runHook(): Promise<void>` (reads stdin, always exits 0; `HECE_CAPTURE=1` saves sanitized payloads)
  - `test/helpers.ts`: `tmpProject()`, `seedFlow(root, state)`, `runCli(args, { root, stdin?, env? })`
- Event names written to `events.jsonl`: `session_start`, `prefs_error`, `prompt`, `tool`, `blocked`, `approved`, `turn_done`, `hook_error`.

- [ ] **Step 1: Write the test helpers**

`test/helpers.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { statePaths } from '../src/state/paths.js'
import { writeJsonAtomic } from '../src/state/store.js'
import { FlowState } from '../src/flow/types.js'

export const CLI = path.resolve('src/cli.ts')

export function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hece-proj-'))
}

export function seedFlow(root: string, state: FlowState): void {
  writeJsonAtomic(statePaths(root).flow, state)
}

export function testEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.CLAUDE_PROJECT_DIR
  return { ...env, HECE_ROOT: root, XDG_CONFIG_HOME: path.join(root, '.config-test'), ...extra }
}

export function runCli(args: string[], opts: { root: string; stdin?: string; env?: Record<string, string> }) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    input: opts.stdin ?? '',
    encoding: 'utf8',
    env: testEnv(opts.root, opts.env),
  })
}
```

- [ ] **Step 2: Write the failing unit test**

`test/hooks/handle.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import { tmpProject, seedFlow } from '../helpers.js'
import { handleHook, summarizeTool } from '../../src/hooks/handle.js'
import { statePaths } from '../../src/state/paths.js'
import { readJson, readEvents } from '../../src/state/store.js'
import { emptyFlow, FlowState } from '../../src/flow/types.js'
import { setPhase, setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'
import { presetDefaults } from '../../src/prefs/schema.js'

let root: string
const prefs = presetDefaults('involved')
const ctx = () => ({ root, prefs, prefsErrors: [] as string[], now: 100 })
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 1)
const stopped = finishSlice(startSlice(approve(plan, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
const events = () => readEvents(statePaths(root).events).map((e) => e.event)
const flow = () => readJson<FlowState>(statePaths(root).flow, emptyFlow())

beforeEach(() => {
  root = tmpProject()
})

describe('handleHook', () => {
  it('does nothing at all in a project without a hece flow', () => {
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 's' }, ctx())
    expect(r).toEqual({ stdout: '' })
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })

  it('records sessions and prefs errors on SessionStart', () => {
    seedFlow(root, emptyFlow())
    handleHook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, { ...ctx(), prefsErrors: ['bad key'] })
    expect(readJson(statePaths(root).sessions, [])).toEqual([{ sessionId: 's1', source: 'startup', at: 100 }])
    expect(events()).toEqual(['session_start', 'prefs_error'])
  })

  it('denies an edit while a slice waits, with the reason, and logs it', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts' } }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'hece: slice 1 is waiting for the user',
      },
    })
    expect(events()).toEqual(['blocked'])
  })

  it('logs allowed tools as activity and marks the agent busy', () => {
    seedFlow(root, emptyFlow())
    const r = handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, ctx())
    expect(r.stdout).toBe('')
    expect(readEvents(statePaths(root).events)[0]).toMatchObject({ event: 'tool', tool: 'Bash', target: 'npm test' })
    expect(readJson(statePaths(root).agent, {})).toEqual({ idle: false, at: 100 })
  })

  it('approves on a typed "continue" and tells the agent', () => {
    seedFlow(root, stopped)
    const r = handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Continue.' }, ctx())
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hece: the user approved slice 1' },
    })
    expect(flow().plan!.slices[0].status).toBe('approved')
  })

  it('does not approve a question', () => {
    seedFlow(root, stopped)
    expect(handleHook({ hook_event_name: 'UserPromptSubmit', prompt: 'ok but why?' }, ctx()).stdout).toBe('')
    expect(flow().plan!.slices[0].status).toBe('stopped')
  })

  it('approves the plan from the picker answer', () => {
    seedFlow(root, plan)
    const r = handleHook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_response: { answers: { 'Plan ok?': 'Continue' } } }, ctx())
    expect(JSON.parse(r.stdout).hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse', additionalContext: 'hece: the user approved the plan' })
    expect(flow().plan!.approved).toBe(true)
  })

  it('marks the agent idle on Stop', () => {
    seedFlow(root, setPhase(emptyFlow(), 'discuss', 1))
    handleHook({ hook_event_name: 'Stop' }, ctx())
    expect(readJson(statePaths(root).agent, {})).toEqual({ idle: true, at: 100 })
    expect(events()).toEqual(['turn_done'])
  })
})

describe('summarizeTool', () => {
  it('uses the file path, command, or pattern and truncates long values', () => {
    expect(summarizeTool('Edit', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(summarizeTool('Bash', { command: 'ls   -la\n&& pwd' })).toBe('ls -la && pwd')
    expect(summarizeTool('Bash', { command: 'x'.repeat(200) })).toHaveLength(120)
    expect(summarizeTool('Read', undefined)).toBe('')
  })
})
```

- [ ] **Step 3: Write the failing CLI test**

`test/hooks/cli-hook.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { readEvents } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'

describe('hece hook (process)', () => {
  it('exits 0 and logs hook_error on malformed stdin', () => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin: '{not json' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(readEvents(statePaths(root).events).map((e) => e.event)).toEqual(['hook_error'])
  })

  it('exits 0 on empty stdin in a project without hece, writing nothing', () => {
    const root = tmpProject()
    const r = runCli(['hook'], { root, stdin: '' })
    expect(r.status).toBe(0)
    expect(fs.existsSync(statePaths(root).heceDir)).toBe(false)
  })

  it('prints usage and exits 1 for an unknown command', () => {
    const r = runCli(['nope'], { root: tmpProject() })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('usage: hece')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/hooks`
Expected: FAIL, cannot resolve `../../src/hooks/handle.js` / `src/cli.ts`.

- [ ] **Step 5: Write the implementation**

`src/hooks/handle.ts`:
```ts
import fs from 'node:fs'
import { statePaths } from '../state/paths.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { approve } from '../flow/flow.js'
import { Prefs } from '../prefs/schema.js'
import { decideTool, isContinueIntent, pickerApproved } from '../guards/guards.js'

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  source?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
}

export interface HookContext {
  root: string
  prefs: Prefs
  prefsErrors: string[]
  now: number
}

export interface SessionRecord {
  sessionId: string
  source: string
  at: number
}

const PICKER_TOOL = 'AskUserQuestion'

const oneLine = (raw: string): string => {
  const s = raw.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

export function summarizeTool(name: string, input?: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (name === 'Bash') return oneLine(str(input?.command))
  return oneLine(str(input?.file_path) || str(input?.notebook_path) || str(input?.pattern) || str(input?.path))
}

export function handleHook(p: HookPayload, ctx: HookContext): { stdout: string } {
  const paths = statePaths(ctx.root)
  // hooks fire in every project once the plugin is installed; stay silent where no hece flow exists
  if (!fs.existsSync(paths.flow)) return { stdout: '' }

  const none = { stdout: '' }
  const ev = (event: string, extra: Record<string, unknown> = {}) =>
    appendEvent(paths.events, { at: ctx.now, event, session: p.session_id, ...extra })
  const setIdle = (idle: boolean) => writeJsonAtomic(paths.agent, { idle, at: ctx.now })
  const flow = readJson<FlowState>(paths.flow, emptyFlow())

  const recordApproval = (hookEventName: 'UserPromptSubmit' | 'PostToolUse', via: string) => {
    const { state, approved } = approve(flow, ctx.now)
    if (!approved) return none
    writeJsonAtomic(paths.flow, state)
    const text = approved.what === 'plan' ? 'hece: the user approved the plan' : `hece: the user approved slice ${approved.n}`
    ev('approved', { what: approved.what, n: approved.what === 'slice' ? approved.n : undefined, via })
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) }
  }

  switch (p.hook_event_name) {
    case 'SessionStart': {
      if (p.session_id) {
        const sessions = readJson<SessionRecord[]>(paths.sessions, [])
        sessions.push({ sessionId: p.session_id, source: p.source ?? 'unknown', at: ctx.now })
        writeJsonAtomic(paths.sessions, sessions)
      }
      ev('session_start', { source: p.source })
      for (const message of ctx.prefsErrors) ev('prefs_error', { message })
      return none
    }
    case 'UserPromptSubmit': {
      setIdle(false)
      ev('prompt', { text: oneLine(p.prompt ?? '') })
      return p.prompt && isContinueIntent(p.prompt) ? recordApproval('UserPromptSubmit', 'typed') : none
    }
    case 'PreToolUse': {
      setIdle(false)
      const name = p.tool_name ?? ''
      const target = summarizeTool(name, p.tool_input)
      const d = decideTool(flow, ctx.prefs, name)
      if (!d.allow) {
        ev('blocked', { tool: name, target, reason: d.reason })
        return {
          stdout: JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason },
          }),
        }
      }
      ev('tool', { tool: name, target, slice: flow.currentSlice })
      return none
    }
    case 'PostToolUse':
      return p.tool_name === PICKER_TOOL && pickerApproved(p.tool_response) ? recordApproval('PostToolUse', 'picker') : none
    case 'Stop':
      setIdle(true)
      ev('turn_done')
      return none
    default:
      return none
  }
}
```

`src/hooks/main.ts`:
```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HookPayload, handleHook } from './handle.js'
import { resolveRoot, statePaths } from '../state/paths.js'
import { appendEvent, writeJsonAtomic } from '../state/store.js'
import { loadPrefs } from '../prefs/load.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// HECE_CAPTURE=1 saves each payload (home dir replaced by ~) for building test fixtures.
function capture(root: string, text: string, p: HookPayload): void {
  const name = [p.hook_event_name, p.tool_name].filter(Boolean).join('-') || 'unknown'
  const sanitized = JSON.parse(text.split(os.homedir()).join('~'))
  writeJsonAtomic(path.join(statePaths(root).captures, `${name}.json`), sanitized)
}

export async function runHook(): Promise<void> {
  const text = await readStdin()
  let payload: HookPayload = {}
  try {
    payload = JSON.parse(text) as HookPayload
  } catch {
    // handled below as hook_error
  }
  const root = resolveRoot(process.env, payload.cwd)
  try {
    if (typeof payload.hook_event_name !== 'string') throw new Error('hook received no valid JSON payload')
    if (process.env.HECE_CAPTURE === '1') capture(root, text, payload)
    const { prefs, errors } = loadPrefs(process.env, root)
    const res = handleHook(payload, { root, prefs, prefsErrors: errors, now: Date.now() })
    if (res.stdout) process.stdout.write(res.stdout)
  } catch (err) {
    const paths = statePaths(root)
    if (fs.existsSync(paths.flow)) {
      try {
        appendEvent(paths.events, { at: Date.now(), event: 'hook_error', message: (err as Error).message })
      } catch {
        // nothing more we can do without breaking the agent
      }
    }
    process.stderr.write(`hece hook: ${(err as Error).message}\n`)
  }
  process.exitCode = 0
}
```

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { runHook } from './hooks/main.js'

const USAGE = 'usage: hece <hook|mcp|status>'

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  process.stderr.write(USAGE + '\n')
  process.exitCode = 1
}

await main(process.argv.slice(2))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/hooks && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hooks src/cli.ts test/helpers.ts test/hooks
git commit -m "feat: hece hook — activity log, approvals, guards"
```

---

### Task 7: MCP server and `hece mcp`

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/main.ts`
- Modify: `src/cli.ts` (add `mcp`)
- Test: `test/mcp/mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (`flow.*`, `renderFlow`, `loadPrefs`, `statePaths`, store, and `runCli`/`testEnv` from helpers)
- Produces:
  - `TOOL_NAMES`: `flow_get`, `flow_set_phase`, `flow_add_decision`, `flow_set_plan`, `flow_start_slice`, `flow_finish_slice`, `flow_report_review`, `prefs_get`. **No approve tool.**
  - `createServer(opts: { root: string; env: NodeJS.ProcessEnv; now?: () => number }): McpServer`
  - `runMcp(): Promise<void>`
  - Every mutating tool returns `renderFlow(...)` text on success, or `isError: true` with the `FlowError` message.

- [ ] **Step 1: Write the failing test**

`test/mcp/mcp.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CLI, tmpProject, testEnv, runCli } from '../helpers.js'
import { TOOL_NAMES } from '../../src/mcp/server.js'

let client: Client | undefined
afterEach(async () => {
  await client?.close()
  client = undefined
})

async function connect(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', CLI, 'mcp'],
    env: testEnv(root),
  })
  client = new Client({ name: 'hece-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean }
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r = (await c.callTool({ name, arguments: args })) as CallResult
    return { text: r.content.map((x) => x.text ?? '').join(''), isError: r.isError === true }
  } catch (err) {
    // some SDK versions throw on schema validation instead of returning isError
    return { text: (err as Error).message, isError: true }
  }
}
const approveAsHuman = (root: string) =>
  runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', session_id: 's' }) })

describe('hece mcp', () => {
  it('lists exactly the hece tools, with no approve tool', async () => {
    const c = await connect(tmpProject())
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())
    expect(names.some((n) => n.includes('approve'))).toBe(false)
  })

  it('runs discuss → plan → slices, with guards enforced across MCP and hooks', async () => {
    const root = tmpProject()
    const c = await connect(root)
    expect((await call(c, 'flow_set_phase', { phase: 'discuss' })).text).toContain('▸ Discussion')
    expect(fs.readFileSync(path.join(root, '.hece', '.gitignore'), 'utf8')).toBe('state/\n')
    expect((await call(c, 'flow_add_decision', { title: 'Auth', choice: 'JWT', why: 'stateless' })).text).toContain('(1 decision)')
    const plan = await call(c, 'flow_set_plan', {
      slices: [
        { title: 'Token model', files: ['src/token.ts'], kind: 'teaching' },
        { title: 'Login', files: ['src/login.ts'], kind: 'routine', model: 'sonnet' },
      ],
    })
    expect(plan.text).toContain('waiting for approval')

    const early = await call(c, 'flow_start_slice', { n: 1 })
    expect(early).toEqual({ text: 'hece: the plan is waiting for the user to approve it', isError: true })

    expect(approveAsHuman(root).stdout).toContain('approved the plan')
    expect((await call(c, 'flow_start_slice', { n: 1 })).text).toContain('▸ 1. Token model')
    expect((await call(c, 'flow_finish_slice', { n: 1, summary: 'Token type', connects_to: 'login uses it' })).text)
      .toContain('■ 1. Token model  ← waiting for you')
    expect(await call(c, 'flow_start_slice', { n: 2 })).toEqual({ text: 'hece: slice 1 is waiting for the user', isError: true })

    expect(approveAsHuman(root).stdout).toContain('approved slice 1')
    expect((await call(c, 'flow_start_slice', { n: 2 })).text).toContain('▸ 2. Login')
  })

  it('rejects invalid input via the schema', async () => {
    const c = await connect(tmpProject())
    expect((await call(c, 'flow_set_phase', { phase: 'ship' })).isError).toBe(true)
    expect((await call(c, 'flow_start_slice', { n: 0 })).isError).toBe(true)
  })

  it('returns effective prefs and errors', async () => {
    const c = await connect(tmpProject())
    const r = JSON.parse((await call(c, 'prefs_get')).text)
    expect(r.prefs.preset).toBe('involved')
    expect(r.errors).toEqual([])
  })

  it('flow_get includes recorded sessions', async () => {
    const root = tmpProject()
    const c = await connect(root)
    await call(c, 'flow_set_phase', { phase: 'discuss' })
    runCli(['hook'], { root, stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup' }) })
    expect((await call(c, 'flow_get')).text).toContain('"sessionId": "abc"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mcp`
Expected: FAIL, cannot resolve `../../src/mcp/server.js`.

- [ ] **Step 3: Write the implementation**

`src/mcp/server.ts`:
```ts
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { statePaths } from '../state/paths.js'
import { readJson, writeJsonAtomic, appendEvent } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import * as flow from '../flow/flow.js'
import { renderFlow } from '../flow/render.js'
import { loadPrefs } from '../prefs/load.js'

export const TOOL_NAMES = [
  'flow_get',
  'flow_set_phase',
  'flow_add_decision',
  'flow_set_plan',
  'flow_start_slice',
  'flow_finish_slice',
  'flow_report_review',
  'prefs_get',
] as const

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export function createServer(opts: { root: string; env: NodeJS.ProcessEnv; now?: () => number }): McpServer {
  const now = opts.now ?? Date.now
  const paths = statePaths(opts.root)
  const server = new McpServer({ name: 'hece', version: '0.1.0' })
  const prefs = () => loadPrefs(opts.env, opts.root)
  const load = () => readJson<FlowState>(paths.flow, emptyFlow())

  // keep runtime state out of the user's git history; .hece/preferences.yaml stays committable
  const ensureGitignore = () => {
    const file = path.join(paths.heceDir, '.gitignore')
    if (!fs.existsSync(file)) {
      fs.mkdirSync(paths.heceDir, { recursive: true })
      fs.writeFileSync(file, 'state/\n')
    }
  }

  const mutate = (tool: string, fn: (s: FlowState) => FlowState, extra: Record<string, unknown> = {}): ToolResult => {
    try {
      const next = fn(load())
      ensureGitignore()
      writeJsonAtomic(paths.flow, next)
      appendEvent(paths.events, { at: now(), event: 'flow', tool, ...extra })
      return ok(renderFlow(next, { guards: prefs().prefs.guards }))
    } catch (err) {
      return fail((err as Error).message)
    }
  }

  server.registerTool(
    'flow_get',
    { description: 'Read the current hece flow (phase, decisions, plan, slices, review) and recorded sessions.', inputSchema: {} },
    async () => {
      try {
        const s = load()
        const sessions = readJson(paths.sessions, [])
        return ok(`${renderFlow(s, { guards: prefs().prefs.guards })}\n\n${JSON.stringify({ flow: s, sessions }, null, 2)}`)
      } catch (err) {
        return fail((err as Error).message)
      }
    },
  )

  server.registerTool(
    'flow_set_phase',
    {
      description: 'Move the hece flow to a phase. Calling it with "discuss" starts a flow and creates .hece/state in the project.',
      inputSchema: { phase: z.enum(['discuss', 'plan', 'build', 'review', 'recap', 'done']) },
    },
    async ({ phase }) => mutate('flow_set_phase', (s) => flow.setPhase(s, phase, now()), { phase }),
  )

  server.registerTool(
    'flow_add_decision',
    {
      description: 'Record a decision settled with the user during discussion.',
      inputSchema: { title: z.string().min(1), choice: z.string().min(1), why: z.string().min(1) },
    },
    async (d) => mutate('flow_add_decision', (s) => flow.addDecision(s, d, now()), { title: d.title }),
  )

  server.registerTool(
    'flow_set_plan',
    {
      description:
        'Set or change the plan as ordered slices. The user must approve it before code edits; a changed plan needs approval again.',
      inputSchema: {
        slices: z
          .array(
            z.object({
              title: z.string().min(1),
              files: z.array(z.string()),
              kind: z.enum(['routine', 'teaching']),
              model: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ slices }) => mutate('flow_set_plan', (s) => flow.setPlan(s, slices, now()), { slices: slices.length }),
  )

  server.registerTool(
    'flow_start_slice',
    { description: 'Start working on slice n (1-based).', inputSchema: { n: z.number().int().min(1) } },
    async ({ n }) => mutate('flow_start_slice', (s) => flow.startSlice(s, n, { guards: prefs().prefs.guards }, now()), { n }),
  )

  server.registerTool(
    'flow_finish_slice',
    {
      description: 'Finish slice n and stop for the user. summary: what changed. connects_to: how it connects to existing code.',
      inputSchema: { n: z.number().int().min(1), summary: z.string().min(1), connects_to: z.string().min(1) },
    },
    async ({ n, summary, connects_to }) =>
      mutate('flow_finish_slice', (s) => flow.finishSlice(s, n, { summary, connectsTo: connects_to }, now()), { n }),
  )

  server.registerTool(
    'flow_report_review',
    {
      description: 'Record the final review counts and enter the review phase.',
      inputSchema: { important: z.number().int().min(0), minor: z.number().int().min(0) },
    },
    async (r) => mutate('flow_report_review', (s) => flow.reportReview(s, r, now()), r),
  )

  server.registerTool(
    'prefs_get',
    { description: "Read the user's effective hece preferences (global merged with project). Follow them exactly.", inputSchema: {} },
    async () => ok(JSON.stringify(prefs(), null, 2)),
  )

  return server
}
```

`src/mcp/main.ts`:
```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { resolveRoot } from '../state/paths.js'

export async function runMcp(): Promise<void> {
  const server = createServer({ root: resolveRoot(process.env), env: process.env })
  await server.connect(new StdioServerTransport())
}
```

`src/cli.ts` (replace whole file):
```ts
#!/usr/bin/env node
import { runHook } from './hooks/main.js'
import { runMcp } from './mcp/main.js'

const USAGE = 'usage: hece <hook|mcp|status>'

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  if (cmd === 'mcp') return runMcp()
  process.stderr.write(USAGE + '\n')
  process.exitCode = 1
}

await main(process.argv.slice(2))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp && npm run typecheck`
Expected: PASS. If `registerTool`'s callback typing rejects the empty `inputSchema: {}`, check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (`registerTool` signature) and omit `inputSchema` for the no-argument tools instead. Behaviour stays the same.

- [ ] **Step 5: Commit**

```bash
git add src/mcp src/cli.ts test/mcp
git commit -m "feat: hece MCP server with flow and prefs tools"
```

---

### Task 8: `hece status`

**Files:**
- Create: `src/status/main.ts`
- Modify: `src/cli.ts` (add `status`)
- Test: `test/status/status.test.ts`

**Interfaces:**
- Consumes: `resolveRoot`, `statePaths`, `readJson` (Task 1); `emptyFlow` (Task 2); `renderFlow` (Task 3); `loadPrefs` (Task 4)
- Produces: `runStatus(): void`

- [ ] **Step 1: Write the failing test**

`test/status/status.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPhase } from '../../src/flow/flow.js'

describe('hece status', () => {
  it('explains when there is no flow yet', () => {
    const r = runCli(['status'], { root: tmpProject() })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no flow in this project yet')
  })

  it('prints the flow and warns about preference errors', () => {
    const root = tmpProject()
    seedFlow(root, setPhase(emptyFlow(), 'discuss', 1))
    fs.writeFileSync(path.join(root, '.hece', 'preferences.yaml'), 'gaurds: off\n')
    const r = runCli(['status'], { root })
    expect(r.stdout).toContain('▸ Discussion (0 decisions)')
    expect(r.stdout).toContain('guards: on')
    expect(r.stderr).toContain('unknown key "gaurds"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/status`
Expected: FAIL. Usage is printed and the exit code is 1.

- [ ] **Step 3: Write the implementation**

`src/status/main.ts`:
```ts
import fs from 'node:fs'
import { resolveRoot, statePaths } from '../state/paths.js'
import { readJson } from '../state/store.js'
import { FlowState, emptyFlow } from '../flow/types.js'
import { renderFlow } from '../flow/render.js'
import { loadPrefs } from '../prefs/load.js'

export function runStatus(): void {
  const root = resolveRoot(process.env)
  const paths = statePaths(root)
  if (!fs.existsSync(paths.flow)) {
    process.stdout.write('hece: no flow in this project yet. Ask the agent to build something with hece to start one.\n')
    return
  }
  const { prefs, errors } = loadPrefs(process.env, root)
  process.stdout.write(renderFlow(readJson<FlowState>(paths.flow, emptyFlow()), { guards: prefs.guards }) + '\n')
  for (const e of errors) process.stderr.write(`warning: ${e}\n`)
}
```

`src/cli.ts` (replace whole file):
```ts
#!/usr/bin/env node
import { runHook } from './hooks/main.js'
import { runMcp } from './mcp/main.js'
import { runStatus } from './status/main.js'

const USAGE = 'usage: hece <hook|mcp|status>'

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv
  if (cmd === 'hook') return runHook()
  if (cmd === 'mcp') return runMcp()
  if (cmd === 'status') return runStatus()
  process.stderr.write(USAGE + '\n')
  process.exitCode = 1
}

await main(process.argv.slice(2))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status src/cli.ts test/status
git commit -m "feat: hece status"
```

---

### Task 9: hece skills

**Files:**
- Create: `skills/flow/SKILL.md`, `skills/slice-stop/SKILL.md`, `skills/check-question/SKILL.md`, `skills/communicate/SKILL.md`, `skills/review-findings/SKILL.md`, `skills/recap/SKILL.md`
- Test: `test/skills/skills.test.ts`

**Interfaces:**
- Consumes: `TOOL_NAMES` (Task 7)
- Produces: skills invoked as `hece:flow`, `hece:slice-stop`, `hece:check-question`, `hece:communicate`, `hece:review-findings`, `hece:recap`. They reference only MCP tools in `TOOL_NAMES`.

- [ ] **Step 1: Write the failing test**

`test/skills/skills.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TOOL_NAMES } from '../../src/mcp/server.js'

const DIR = path.resolve('skills')
const EXPECTED = ['check-question', 'communicate', 'flow', 'recap', 'review-findings', 'slice-stop']
const read = (name: string) => fs.readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8')

describe('skills', () => {
  it('has exactly the expected skills', () => {
    expect(fs.readdirSync(DIR).sort()).toEqual(EXPECTED)
  })

  it.each(EXPECTED)('%s has frontmatter with a matching name and a "Use when" description', (name) => {
    const m = read(name).match(/^---\nname: (.+)\ndescription: (.+)\n---\n/)
    expect(m).not.toBeNull()
    expect(m![1]).toBe(name)
    expect(m![2]).toMatch(/^Use (when|after|during|in)/)
  })

  it.each(EXPECTED)('%s only references real hece tools and skills', (name) => {
    const text = read(name)
    // flow_recap is a preference key, not a tool
    for (const tool of (text.match(/\b(flow_[a-z_]+|prefs_get)\b/g) ?? []).filter((t) => t !== 'flow_recap')) {
      expect(TOOL_NAMES as readonly string[]).toContain(tool)
    }
    for (const ref of text.match(/hece:([a-z-]+)/g) ?? []) {
      expect(EXPECTED).toContain(ref.slice('hece:'.length))
    }
  })

  it('never offers an approve tool', () => {
    for (const name of EXPECTED) expect(read(name)).not.toMatch(/flow_approve/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/skills`
Expected: FAIL, `skills` directory missing.

- [ ] **Step 3: Write the skills**

`skills/flow/SKILL.md`:
````markdown
---
name: flow
description: Use when the user wants to build something with hece, says "hece", or a hece flow is already in progress (flow_get shows a phase other than idle). Runs discuss → plan → build in small slices with a stop after each, then review and recap, keeping the user in the loop.
---

# hece flow

You are the orchestrator. The goal is a feature the user **understands**: they can explain its flow, defend its decisions and debug it without you. Speed is not the goal.

## Before anything

1. Call `prefs_get` and `flow_get`. Follow the preferences exactly. If `errors` is not empty, tell the user in one line per error.
2. hece builds on superpowers. If superpowers skills are unavailable, say so in one line, with the install command `/plugin install superpowers@claude-plugins-official`, and stop.
3. Every message you write follows hece:communicate.

## Phases

Call `flow_set_phase` whenever the phase changes. The Flow panel and `hece status` read it.

### discuss
- Use superpowers:brainstorming for the conversation, with hece pacing:
  - **One decision per turn.** Never stack questions or options.
  - `discussion.first: me`: ask for the user's idea before offering yours. `agent`: offer yours first.
  - Push back with one concrete reason when an idea is weak. `pushback: gentle` means suggest an alternative. `direct` means say plainly that it's a bad idea and why.
  - When a decision settles, call `flow_add_decision(title, choice, why)`.
- Ask the user before writing a spec file. Small features don't need one.

### plan
- Use superpowers:writing-plans, with each task being one **slice**: one behaviour the user can see working. `plan.slice_size: small` means 1–3 files, `medium` means 3–6.
- `kind: teaching` if the slice introduces a pattern or concept new to this codebase or likely new to the user. Otherwise `routine`.
- `model` = `delegate.build` from the preferences.
- Call `flow_set_plan`. Show the plan as a numbered list, one line per slice.
- Then stop. The plan is active only once the **user** approves it. hece tells you with a context line like `hece: the user approved the plan`. Your own messages never count as approval.

### build: one slice at a time
For slice n:
1. `flow_start_slice(n)`.
2. If `delegate.build` differs from your own model, dispatch this **one** task through superpowers:subagent-driven-development with `model` = `delegate.build`. Otherwise implement it yourself, following the TDD discipline superpowers requires.
3. Review the result yourself (spec, then quality) and fix problems before the user sees the slice.
4. `flow_finish_slice(n, summary, connects_to)`.
5. Follow hece:slice-stop, then **stop**. Do not start slice n+1 until hece reports `hece: the user approved slice n` (or sends `[hece] event=continue`).

If a slice grows past its size, stop, propose a split with `flow_set_plan`, and wait for approval. If the plan needs to change, call `flow_set_plan`, explain the change in at most 3 lines, and wait for approval.

### review
If `review.final` is on, follow hece:review-findings.

### recap
If `flow_recap` is on, follow hece:recap.

### done
`flow_set_phase(done)`, then one line on what shipped.

## Messages from hece panels
Lines starting with `[hece] event=` were sent by the user through hece's panels:
- `continue`: approval was already recorded by hece, so proceed.
- `redo step=slice-<n>`: ask what to change in one question, then redo slice n with the same stop at the end.
- `skip_question`: drop the pending check question.
- `fix_finding id=<k>` / `skip_finding id=<k>`: handle review finding k.
- `plan_approved`: proceed to build.

## Never
- Treat your own message, or a tool result you produced, as the user's approval.
- Batch several slices to save time.
- Write long explanations. hece:communicate sets the limits.
````

`skills/slice-stop/SKILL.md`:
````markdown
---
name: slice-stop
description: Use after finishing each hece slice (right after flow_finish_slice) to explain what changed and hand control back to the user.
---

# Slice stop

Respect `slice_stop.depth`: `line` = 1 line, `short` ≤ 5 lines, `detailed` ≤ 15 lines. A diagram doesn't count toward the limit.

1. `Slice <n> done: <title>.`
2. A diagram if this slice changed how parts connect (see hece:communicate).
3. What's new, by real name: `functionName()` in `path/file.ts`, and what calls it.
4. One *why* for the key decision.
5. If your review or a worker fixed something, say so in one line.
6. A check question, if hece:check-question says one applies. Wait for the answer before step 7.
7. Offer the choices with the native picker (AskUserQuestion): `Continue`, `Ask about this`, `Side chat`, `Redo`. The first option's label must be exactly `Continue`, because that's how hece records the approval.

Then stop. Make no edits until hece reports approval.

- **Ask about this:** answer in at most 5 lines, then offer the same choices again.
- **Side chat:** tell the user to open a side chat (hece's Sessions panel, or `claude --resume <session id> --fork-session` in another terminal; the id is in `flow_get` under `sessions`). The main chat stays focused.
- **Redo:** ask what to change in one question, then redo the slice.
````

`skills/check-question/SKILL.md`:
````markdown
---
name: check-question
description: Use during a hece slice stop to decide whether to ask a check question and how to ask it.
---

# Check question

Ask one when `check_questions` is `every`, or when it's `non-routine` and the slice's kind is `teaching`. Never when it's `off`.

- One question about the **wiring** of this slice: what calls X, what happens when Y fails, where Z's data comes from, what breaks if W is removed.
- Not trivia, not syntax. It should be answerable in one sentence.
- Format: `? <question>` and on the next line `(answer, or type skip)`.

Wait for the answer. Reply in at most 2 lines: confirm it, or correct it with the specific reason. Then continue the slice stop.
````

`skills/communicate/SKILL.md`:
````markdown
---
name: communicate
description: Use for every message written during a hece flow. Keeps explanations short, specific and never superficial, with diagrams where they explain better than text.
---

# How hece talks

- **Point first.** The first sentence says what happened or what you are asking.
- **Hard length caps** from `slice_stop.depth`: `line` = 1 line, `short` ≤ 5 lines, `detailed` ≤ 15 lines. Diagrams don't count. These are limits, not suggestions.
- **Specific, not superficial.** Name real functions and files (`refreshToken()` in `auth/session.ts`), not "the auth logic". Give one *why* per decision.
- **No filler.** Don't restate the user, don't praise, don't summarise the summary.
- **One decision per message** when asking the user something.

## Diagrams

Draw one for data flow between parts, call sequences, or state changes. Skip it for one-file tweaks. A diagram **replaces** prose; it isn't added on top. Use box-drawing text only (terminals don't render Mermaid), no wider than 80 columns.

```
Slice 3 done: refresh flow.

  request ─▶ authMiddleware ─▶ expired? ─no─▶ handler
                                  │yes
                                  ▼
                          refreshToken() ─▶ retry once

New: refreshToken() in auth/session.ts. Called from authMiddleware.
Why retry once: a second failure means the refresh token is dead → logout.
```
````

`skills/review-findings/SKILL.md`:
````markdown
---
name: review-findings
description: Use in the hece review phase to run the final code review and walk the user through findings one at a time.
---

# Review findings

1. Dispatch a fresh reviewer with superpowers:requesting-code-review on `review.reviewer_model`, scoped to the whole feature (every slice). Give it the plan and the diff only, not the build conversation.
2. Order findings with important first. Drop minor ones if `review.show_minor` is off.
3. `flow_report_review(important, minor)`.
4. One summary line: `Review: <i> important, <m> minor.`
5. Then one finding per message:
   ```
   [k/N] important · src/auth/session.ts:42
   Problem: <one line>
   Why it matters: <one line>
   ```
   Picker: `Fix now`, `Skip`, `Ask about it`.
6. **Fix now:** make the fix, show what changed in at most 3 lines, then move to the next finding. **Ask about it:** suggest a side chat for long questions, or answer in at most 5 lines.
7. After the last finding, go to recap (if `flow_recap` is on) or done.
````

`skills/recap/SKILL.md`:
````markdown
---
name: recap
description: Use at the end of a hece flow, when flow_recap is on, to walk the user through the whole feature's flow.
---

# Recap

1. `flow_set_phase(recap)`.
2. One diagram of the whole feature's flow (A → B → C), naming real functions and files.
3. At most 15 lines walking through the diagram in order: what each step does and why it exists.
4. End with: `Ask me about any step.`
````

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/skills`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills test/skills
git commit -m "feat: hece skills — flow, slice stop, check question, communicate, review, recap"
```

---

### Task 10: Claude Code plugin wiring and smoke test

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`
- Test: `test/plugin/plugin.test.ts`

**Interfaces:**
- Consumes: `hece hook`, `hece mcp` (Tasks 6–7), built to `dist/cli.js` by `npm run build`
- Produces: a Claude Code plugin loadable with `claude --plugin-dir <repo>`

- [ ] **Step 1: Write the failing test**

`test/plugin/plugin.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook'

describe('Claude Code plugin', () => {
  it('has a manifest named hece', () => {
    expect(json('.claude-plugin/plugin.json')).toMatchObject({ name: 'hece', version: '0.1.0' })
  })

  it('wires every hook event hece handles to `hece hook`', () => {
    const hooks = json('hooks/hooks.json').hooks
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    for (const entries of Object.values(hooks) as { hooks: { type: string; command: string }[] }[][]) {
      expect(entries[0].hooks[0]).toEqual({ type: 'command', command: CMD })
    }
    expect(hooks.PreToolUse[0].matcher).toBe('*')
    expect(hooks.PostToolUse[0].matcher).toBe('*')
  })

  it('registers the MCP server as `hece mcp`', () => {
    expect(json('.mcp.json')).toEqual({
      mcpServers: { hece: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', 'mcp'] } },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/plugin`
Expected: FAIL, files missing.

- [ ] **Step 3: Write the plugin files**

`.claude-plugin/plugin.json`:
```json
{
  "name": "hece",
  "version": "0.1.0",
  "description": "Stay in the loop while AI agents build: discussion, small slices, a stop after each.",
  "author": { "name": "Harun Gökçegöz" }
}
```

`hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" hook" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" hook" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.js\" hook" }] }]
  }
}
```

`.mcp.json`:
```json
{
  "mcpServers": {
    "hece": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/cli.js", "mcp"] }
  }
}
```

- [ ] **Step 4: Run all tests and build**

Run: `npx vitest run && npm run build && node dist/cli.js status`
Expected: all tests PASS; `dist/cli.js` exists; status prints "no flow in this project yet".

- [ ] **Step 5: Smoke test in real Claude Code (👤 human step; the user drives, the agent watches)**

```bash
mkdir -p /tmp/hece-smoke && cd /tmp/hece-smoke && git init -q
claude --plugin-dir /Users/harungokcegoz/Documents/repos/hece-cli
```
In Claude: `/mcp` should list `hece` with 8 tools. Then type: `Let's build a tiny CLI that prints a greeting, using hece.` and check, in a second terminal:
```bash
cd /tmp/hece-smoke && node /Users/harungokcegoz/Documents/repos/hece-cli/dist/cli.js status
```
Expected: the phase moves to `discuss`. Decisions are recorded one at a time. After the plan, try to get Claude to edit before approving: the edit is denied with `hece: no code edits before the user approves the plan`. Typing `continue` approves. After slice 1, Claude stops and shows the picker. Note anything surprising in `docs/notes/2026-10-18-smoke.md` (create it) for plan 2.

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin hooks .mcp.json test/plugin
git commit -m "feat: Claude Code plugin wiring for hece"
```

---

### Task 11: Captured payload fixtures (👤 human-assisted)

Hook payload shapes (especially the picker's `tool_response`) aren't fully documented. This task pins hece to **real** Claude Code payloads, so an update that changes them fails a test instead of silently breaking approvals.

**Files:**
- Create: `test/fixtures/claude-code/*.json` (captured), `test/hooks/fixtures.test.ts`

**Interfaces:**
- Consumes: `HECE_CAPTURE=1` capture mode (Task 6), `runCli`, `seedFlow` (helpers), flow functions (Task 2)

- [ ] **Step 1: Capture payloads (👤 human)**

```bash
cd /tmp/hece-smoke && rm -rf .hece && HECE_CAPTURE=1 claude --plugin-dir /Users/harungokcegoz/Documents/repos/hece-cli
```
In Claude:
1. `Start a hece flow for a greeting CLI.` This produces SessionStart, PreToolUse and PostToolUse captures for the MCP tool calls, plus UserPromptSubmit.
2. Agree to a one-slice plan. When asked to approve, type exactly `continue`.
3. Let slice 1 run. That produces PreToolUse-Write or PreToolUse-Edit, and PreToolUse-Bash.
4. At the slice stop picker, choose `Continue`. That produces PostToolUse-AskUserQuestion.
5. Exit.

Then copy the captures:
```bash
mkdir -p /Users/harungokcegoz/Documents/repos/hece-cli/test/fixtures/claude-code
cp /tmp/hece-smoke/.hece/state/captures/*.json /Users/harungokcegoz/Documents/repos/hece-cli/test/fixtures/claude-code/
ls /Users/harungokcegoz/Documents/repos/hece-cli/test/fixtures/claude-code
```
Expected: at least `SessionStart.json`, `UserPromptSubmit.json`, `PreToolUse-Write.json` (or `PreToolUse-Edit.json`), `PreToolUse-Bash.json`, `PostToolUse-AskUserQuestion.json`, `Stop.json`. Open each one and confirm it contains no secrets (the home directory is already replaced by `~`). If `UserPromptSubmit.json` captured a later prompt, edit only its `prompt` field to `"continue"`.

- [ ] **Step 2: Write the replay test**

`test/hooks/fixtures.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpProject, seedFlow, runCli } from '../helpers.js'
import { statePaths } from '../../src/state/paths.js'
import { readEvents } from '../../src/state/store.js'
import { emptyFlow } from '../../src/flow/types.js'
import { setPlan, startSlice, finishSlice, approve } from '../../src/flow/flow.js'

const DIR = path.resolve('test/fixtures/claude-code')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
const raw = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')
const plan = setPlan(emptyFlow(), [{ title: 'A', files: [], kind: 'routine' }, { title: 'B', files: [], kind: 'routine' }], 1)
const stopped = finishSlice(startSlice(approve(plan, 2).state, 1, { guards: true }, 3), 1, { summary: 's', connectsTo: 'c' }, 4)
const edit = files.find((f) => f === 'PreToolUse-Write.json' || f === 'PreToolUse-Edit.json')

describe('real Claude Code payloads', () => {
  it('has the core captures', () => {
    for (const f of ['SessionStart.json', 'UserPromptSubmit.json', 'PreToolUse-Bash.json', 'PostToolUse-AskUserQuestion.json', 'Stop.json']) {
      expect(files).toContain(f)
    }
    expect(edit).toBeDefined()
  })

  it.each(files)('%s is handled without a hook_error', (f) => {
    const root = tmpProject()
    seedFlow(root, emptyFlow())
    const r = runCli(['hook'], { root, stdin: raw(f) })
    expect(r.status).toBe(0)
    expect(readEvents(statePaths(root).events).map((e) => e.event)).not.toContain('hook_error')
  })

  it('a real Write/Edit payload is denied while a slice waits', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw(edit!) })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('a real Bash payload is never denied', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    expect(runCli(['hook'], { root, stdin: raw('PreToolUse-Bash.json') }).stdout).toBe('')
  })

  it('the real picker answer "Continue" approves the waiting slice', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw('PostToolUse-AskUserQuestion.json') })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })

  it('the real typed "continue" approves the waiting slice', () => {
    const root = tmpProject()
    seedFlow(root, stopped)
    const r = runCli(['hook'], { root, stdin: raw('UserPromptSubmit.json') })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe('hece: the user approved slice 1')
  })
})
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/hooks/fixtures.test.ts`
Expected: PASS. If the picker test fails, the real `tool_response` shape differs from what `pickerApproved` accepts. Look at `PostToolUse-AskUserQuestion.json`, add a case for its exact shape to `pickerApproved` in `src/guards/guards.ts` (and a matching unit test in `test/guards/guards.test.ts`), then re-run.

- [ ] **Step 4: Run everything**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures test/hooks/fixtures.test.ts src/guards test/guards
git commit -m "test: pin hook handling to captured Claude Code payloads"
```
