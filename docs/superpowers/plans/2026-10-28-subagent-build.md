# Subagent Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before build, the user picks one-by-one or parallel plus model and effort; subagents execute every slice; an `optimize: ponytail | caveman` preference picks the subagents' skill pack.

**Architecture:** The mode is human-only state (`plan.mode`), captured by the PostToolUse hook from a picker whose first option is `One by one`, like approvals. Flow functions (`startSlice`, `approve`, `requestRedo`) and `decideTool` branch on `plan.mode === 'parallel'`; one-by-one keeps today's behaviour exactly. The rest is skill text and README.

**Tech Stack:** TypeScript, Node ≥20, vitest, zod (MCP schemas).

**Spec:** `docs/superpowers/specs/2026-10-28-subagent-build-design.md`

## Global Constraints

- No new runtime dependencies.
- Test first: failing test (RED), then passing (GREEN).
- Approvals, redo requests and the mode are recorded only by hooks from the user's message or picker answer in the main session (`fromMain`), never by an MCP tool.
- Hooks always exit 0 and write nothing without `.hece/state/flow.json`. Panels never write state.
- Activity never shows raw command text or secrets. When unsure, be vague, never wrong.
- One-by-one behaviour (and every existing test) stays unchanged; absent `plan.mode` means one by one.
- Commits: no `Co-Authored-By` trailer, no AI attribution.
- Every task ends with `npm test && npm run typecheck && npm run build` passing.

## Review Focus

1. Typed `continue` while parallel slices are still running → nothing is approved; the hook says the batch is still running. (Task 2, Task 4)
2. A mode picker whose first option is `Parallel`, or which only offers `Parallel` → no mode recorded. (Task 3)
3. A plan change mid-build in parallel mode → mode kept, and a fresh mode answer after re-approval is ignored because slices have started. (Task 2)
4. `redo 2 9` where only 2 is stopped → only 2 marked; `redo 9` alone → nothing marked, hook names the waiting slices. (Task 2, Task 4)
5. Tool events while several slices are working → Activity tags them with no slice instead of guessing. (Task 4)

---

### Task 1: `optimize` preference

**Files:**
- Modify: `src/prefs/schema.ts` (`Prefs`, `INVOLVED`, `RULES`)
- Test: `test/prefs/prefs.test.ts`

**Interfaces:**
- Produces: `Prefs['optimize']: 'ponytail' | 'caveman'`, default `'ponytail'` in every preset.

- [ ] **Step 1: Write the failing tests**

```ts
it('defaults optimize to ponytail and accepts caveman', () => {
  expect(presetDefaults('involved').optimize).toBe('ponytail')
  expect(presetDefaults('learning').optimize).toBe('ponytail')
  expect(validatePrefs({ optimize: 'caveman' }, 'x')).toEqual({ flat: { optimize: 'caveman' }, errors: [] })
  expect(validatePrefs({ optimize: 'grunt' }, 'x').errors[0]).toContain('ponytail | caveman')
})
```

- [ ] **Step 2: Run** `npx vitest run test/prefs/prefs.test.ts` — expect FAIL (`optimize` undefined).
- [ ] **Step 3: Implement** — add `optimize: 'ponytail' | 'caveman'` to `Prefs`, `optimize: 'ponytail'` to `INVOLVED`, `optimize: e('ponytail', 'caveman')` to `RULES`.
- [ ] **Step 4: Run** the test file — expect PASS; then the full check.
- [ ] **Step 5: Commit** `feat(prefs): add optimize preference (ponytail | caveman)`

---

### Task 2: Flow state for parallel mode

**Files:**
- Modify: `src/flow/types.ts`, `src/flow/flow.ts`, `src/flow/render.ts:33`
- Test: `test/flow/flow.test.ts`, `test/flow/render.test.ts`

**Interfaces:**
- Produces:
  - `type BuildMode = 'one-by-one' | 'parallel'`; `Plan.mode?: BuildMode`.
  - `chooseMode(s: FlowState, mode: BuildMode, now: number): FlowState | null` — human-only. Returns `null` (no change) unless `s.plan?.approved` and every slice is `todo`.
  - `batchRunning(s: FlowState): boolean` — `plan.mode === 'parallel'` and some slice is `todo` or `working` and some slice is `stopped`.
  - `Approved` gains `{ what: 'slices'; ns: number[] }`.
  - `requestRedo(s, now, ns: number[] = []): { state: FlowState; requested: number[]; waiting: number[] }` — `waiting` = the stopped slice numbers.

- [ ] **Step 1: Write the failing tests** (in `flow.test.ts`; build fixtures with existing helpers plus `chooseMode`)

```ts
describe('parallel mode', () => {
  // plan of 3 slices, approved, chooseMode(..., 'parallel')
  it('chooseMode records the mode only after approval and before any slice starts', () => {
    expect(chooseMode(unapprovedPlan(), 'parallel', 5)).toBeNull()
    expect(chooseMode(approvedPlan(), 'parallel', 5)!.plan!.mode).toBe('parallel')
    expect(chooseMode(startSlice(parallelPlan(), 1, G, 5), 'one-by-one', 6)).toBeNull()
  })
  it('lets several slices work at once, but not restart a stopped one without redo', () => {
    const s = startSlice(startSlice(parallelPlan(), 1, G, 5), 2, G, 6)
    expect(s.plan!.slices.map((x) => x.status)).toEqual(['working', 'working', 'todo'])
    const stopped = finishSlice(s, 1, { summary: 'a', connectsTo: 'b' }, 7)
    expect(() => startSlice(stopped, 1, G, 8)).toThrow('slice 1 is waiting')
    expect(startSlice(stopped, 3, G, 8).plan!.slices[2].status).toBe('working')
  })
  it('approves nothing while the batch runs, then every stopped slice at once', () => {
    const mid = finishSlice(startSlice(startSlice(parallelPlan(), 1, G, 5), 2, G, 6), 1, info, 7)
    expect(batchRunning(mid)).toBe(true)
    expect(approve(mid, 8).approved).toBeNull()
    const done = finishSlice(startSlice(finishSlice(mid, 2, info, 8), 3, G, 9), 3, info, 10)
    const r = approve(done, 11)
    expect(r.approved).toEqual({ what: 'slices', ns: [1, 2, 3] })
    expect(r.state.plan!.slices.every((x) => x.status === 'approved')).toBe(true)
  })
  it('redoes exactly the named stopped slices', () => {
    const r = requestRedo(allStopped(), 12, [2, 9])
    expect(r.requested).toEqual([2])
    expect(r.state.plan!.slices.map((x) => !!x.redoRequested)).toEqual([false, true, false])
    expect(requestRedo(allStopped(), 12).requested).toEqual([])   // several stopped, none named
    expect(requestRedo(allStopped(), 12).waiting).toEqual([1, 2, 3])
  })
  it('keeps the mode across a plan change', () => {
    const changed = setPlan(startSlice(parallelPlan(), 1, G, 5), threeSlices, G, 6)
    expect(changed.plan!.mode).toBe('parallel')
  })
})
```

Also update the three existing `requestRedo` assertions: `requested` `1` → `[1]`, `null` → `[]`.
In `render.test.ts`: a stopped slice shows `← waiting for you` in one-by-one, and `← done` while `batchRunning` is true.

- [ ] **Step 2: Run** `npx vitest run test/flow test/mcp` — expect FAIL.
- [ ] **Step 3: Implement**
  - `setPlan`: copy `prev?.mode` onto the new plan (omit when undefined).
  - `startSlice` (guards on, parallel): skip the `busy` check; `waiting` is only slice `n` itself when stopped without `redoRequested`.
  - `approve`: when `plan.mode === 'parallel'` and the plan is approved: if any slice is `todo`/`working`, return `{ state: s, approved: null }`; else approve every stopped slice and return `{ what: 'slices', ns }`.
  - `requestRedo(s, now, ns)`: with `ns` non-empty, mark the stopped slices among `ns`; with `ns` empty, mark the single stopped slice only when exactly one is stopped.
  - `render.ts`: wait text is `'  ← done'` when `batchRunning(s)`, else today's text.
- [ ] **Step 4: Run** the tests — expect PASS; then the full check.
- [ ] **Step 5: Commit** `feat(flow): parallel build mode in flow state`

---

### Task 3: Guards and the mode picker

**Files:**
- Modify: `src/guards/guards.ts`
- Test: `test/guards/guards.test.ts`

**Interfaces:**
- Consumes: `BuildMode`, `Plan.mode` (Task 2).
- Produces:
  - `parseRedo(text: string): number[] | null` — `'redo'` → `[]`; `'redo 2 4'` / `'redo 2, 4'` → `[2, 4]`; anything else → `null`. `isRedoIntent(text)` becomes `parseRedo(text) !== null`.
  - `pickerMode(toolResponse: unknown): BuildMode | null` — reads only `answers` for the one question whose first option label is exactly `One by one` (case-insensitive, trimmed), same rules as `approvalAnswers`. `'one by one'` → `'one-by-one'`, `'parallel'` → `'parallel'`, else `null`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('parallel guards', () => {
  it('lets edits run while a parallel batch still has working slices', () => {
    expect(decideTool(parallelOneStoppedOneWorking, prefs, edit, protect)).toEqual({ allow: true })
  })
  it('blocks edits once the whole parallel batch is waiting', () => {
    expect(decideTool(parallelAllStopped, prefs, edit, protect)).toEqual({ allow: false, reason: 'hece: slice 1 is waiting for the user' })
  })
})
describe('parseRedo', () => {
  it.each([['redo', []], ['Redo 2 4', [2, 4]], ['redo 2, 4.', [2, 4]]])('%s', (t, ns) => expect(parseRedo(t)).toEqual(ns))
  it.each(['redo it', 'please redo', 'redo 0'])('rejects %s', (t) => expect(parseRedo(t)).toBeNull())
})
describe('pickerMode', () => {
  const pick = (labels: string[], answer: string) => ({
    questions: [{ question: 'How should slices run?', options: labels.map((label) => ({ label })) }],
    answers: { 'How should slices run?': answer },
  })
  it('reads the answer to the One by one question', () => {
    expect(pickerMode(pick(['One by one', 'Parallel'], 'Parallel'))).toBe('parallel')
    expect(pickerMode(pick(['One by one', 'Parallel'], 'One by one'))).toBe('one-by-one')
  })
  it('ignores pickers that put Parallel first or offer only Parallel', () => {
    expect(pickerMode(pick(['Parallel', 'One by one'], 'Parallel'))).toBeNull()
    expect(pickerMode(pick(['Parallel'], 'Parallel'))).toBeNull()
  })
  it('ignores agent-shaped strings', () => expect(pickerMode('Parallel')).toBeNull())
})
```

- [ ] **Step 2: Run** `npx vitest run test/guards` — expect FAIL.
- [ ] **Step 3: Implement** — `decideTool`: a stopped slice blocks only if `plan.mode !== 'parallel'` or no slice is `todo`/`working`. Generalise `approvalAnswers` into `answersFor(toolResponse, firstLabel)` and use it for approval and mode.
- [ ] **Step 4: Run** — expect PASS; then the full check.
- [ ] **Step 5: Commit** `feat(guards): parallel edit rule, redo with slice numbers, mode picker`

---

### Task 4: Hook wiring

**Files:**
- Modify: `src/hooks/handle.ts`
- Test: `test/hooks/handle.test.ts`

**Interfaces:**
- Consumes: `chooseMode`, `batchRunning`, `approve` (`slices`), `requestRedo(s, now, ns)` (Task 2); `parseRedo`, `pickerMode` (Task 3).
- Produces these context lines (exact copy):
  - `hece: the user chose one by one` / `hece: the user chose parallel`
  - `hece: the user approved slices 1, 2, 3`
  - `hece: slices are still running; the user can approve once the batch is done`
  - `hece: the user asked to redo slices 2, 4` (several) — single slice keeps `hece: the user asked to redo slice 2`
  - `hece: say which slices to redo, e.g. redo 1 3 (waiting: 1, 2, 3)`

- [ ] **Step 1: Write the failing tests** (follow the existing hook test setup in `handle.test.ts`)
  - PostToolUse picker `One by one`/`Parallel` from the main session → `plan.mode` set, context line as above; from a fork or another session → nothing written, `ignored_approval` event.
  - Mode picker after a slice has started → nothing written, no context line.
  - Typed `continue` mid-batch → `flow.json` unchanged, context `hece: slices are still running…`.
  - Typed `continue` with the whole batch stopped → all approved, `approved slices 1, 2, 3`.
  - Typed `redo 2 4` → those slices marked, `redo slices 2, 4`; typed `redo` or picker `Redo` with three stopped → nothing marked, `say which slices…(waiting: 1, 2, 3)`.
  - PreToolUse while two slices are `working` → the `tool` event has `slice: null`; with one working → its number (as today).
- [ ] **Step 2: Run** `npx vitest run test/hooks` — expect FAIL.
- [ ] **Step 3: Implement**
  - `recordMode(via)`: inside `updateFlow`, require `fromMain(via)`, then `chooseMode`; emit event `mode_chosen` `{ mode, via }`.
  - PostToolUse order: check answer → redo → approval → mode (mode is a separate picker after approval).
  - UserPromptSubmit: `parseRedo(p.prompt)` replaces `isRedoIntent`; pass the numbers to `recordRedo`.
  - `recordApproval`: when `approved` is `null` and `batchRunning(flow)`, return the still-running line.
  - PreToolUse `slice`: `working.length === 1 ? working[0].n : working.length > 1 ? null : flow.currentSlice`.
- [ ] **Step 4: Run** — expect PASS; then the full check.
- [ ] **Step 5: Commit** `feat(hooks): record the build mode and batch approvals`

---

### Task 5: Skill, README, portable skill

**Files:**
- Modify: `skills/flow/SKILL.md`, `README.md` (Preferences, a new "Build modes" section after Quick start), `portable/staying-in-the-loop/SKILL.md`
- Test: `test/skills/skills.test.ts`

**Interfaces:**
- Consumes: the picker labels (`One by one` first, `Parallel`), `optimize`, the context lines from Task 4.

- [ ] **Step 1: Update the skill tests** — replace the `dispatch exactly one slice at a time` assertion with assertions that `flow` contains `One by one`, `Parallel`, `optimize`, `ponytail:ponytail`, `caveman:caveman`, `hece:communicate wins`, and `the user approved slices`.
- [ ] **Step 2: Run** `npx vitest run test/skills` — expect FAIL.
- [ ] **Step 3: Write the copy**
  - `skills/flow/SKILL.md`:
    - Before anything: if `optimize`'s pack (`ponytail:ponytail` or `caveman:caveman`) isn't available, one line with its install command (spec), continue. hece:communicate wins for every message to the user, even if caveman is active.
    - Rule 4: one by one dispatches one slice and stops after each; parallel follows the batch loop below.
    - New `### before build` (after plan approval): one AskUserQuestion with three questions — mode (first option exactly `One by one`, then `Parallel`), model (first option `delegate.build`), effort (`medium`, `low`, `high`). Wait for `hece: the user chose …`. Model and effort are not stored: keep them in the conversation and pass them to every subagent dispatch. Never call `flow_set_plan` just to record them (it would need re-approval).
    - Build: the main chat never edits code; every slice goes to a subagent (Agent tool) with `model`, `effort`, and a prompt that tells it to use the `optimize` pack and superpowers TDD.
    - Parallel loop: group slices whose `files` overlap so they run one after another; `flow_start_slice` each slice in a group and dispatch the group's subagents in one message; `flow_finish_slice` as each returns; start the next group; once all are stopped, review them, then one report covering every slice (hece:slice-stop per slice, shortest depth), and stop. Approval is `hece: the user approved slices …`; redo is `redo 2 4`.
  - README: `optimize: ponytail` line in the Preferences block; "Build modes" section: the three questions, both modes, subagents execute, how to approve/redo a batch, caveman/ponytail install commands and the caveman SessionStart note.
  - Portable skill: one line — a user may ask to run independent slices in parallel; still stop once for all of them.
- [ ] **Step 4: Run** — expect PASS; then the full check.
- [ ] **Step 5: Commit** `docs(flow): build modes in the flow skill and README`
