# Onboarding (setup, prefs, doctor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `hece setup` (a wizard that writes the global preferences file), `hece prefs` (edit one screen), `hece doctor` (install checks), the wizard on first run, and the preference changes they need: effort per role, orchestrator model/effort at launch, and guards split in two.

**Architecture:** Preferences gain a vendor table (`src/prefs/vendors.ts`) and a save module (`src/prefs/save.ts`) that writes only what differs from the preset. The wizard is a pure key reducer plus a renderer (`src/setup/tui.ts`), a list of screen definitions (`src/setup/screens.ts`) and a runner (`src/setup/main.ts`), driven by Node's `readline` keypress events in raw mode. It uses no Ink and adds no new dependencies. Doctor is a pure check list with its dependencies injected (`src/doctor/main.ts`).

**Tech Stack:** TypeScript (ESM, Node ≥ 20), `yaml` (already a dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-onboarding-design.md` (amends `2026-10-18-hece-design.md` §8). Read both.

## Global Constraints

- Node ≥ 20. No new runtime dependencies (no Ink, no React).
- The wizard writes only the global file: `prefsFiles(env, root).global` (`$XDG_CONFIG_HOME/hece/preferences.yaml` or `~/.config/hece/preferences.yaml`). It never reads or writes the project file.
- Every screen fits in 40 columns, and option labels are at most 30 characters. Text wraps with `wrapLine` / `displayWidth` from `src/panels/fit.ts`, and colours come from `color` in `src/panels/color.ts`.
- Keys: Up/Down (also `k`/`j`) move, `1`–`9` pick directly, Enter confirms, `b` goes back, Esc quits, Ctrl-C aborts.
- All user-facing copy follows `skills/communicate/SKILL.md`: short and plain.
- Install commands, verbatim: superpowers `/plugin install superpowers@claude-plugins-official`; ponytail `/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`; caveman `/plugin marketplace add JuliusBrussee/caveman` then `/plugin install caveman@caveman`.
- Claude effort levels: `low | medium | high | xhigh | max`. Claude models: `opus`, `sonnet`, `haiku`, `fable`.
- Commits: conventional style (`feat(setup): …`). No AI co-author or attribution lines.
- After `src/` changes: `npm run typecheck && npm test && npm run build`.

## Review Focus

1. **The global file exists but isn't valid YAML** (or isn't a mapping). Saving would destroy what the user wrote. Expect: the wizard shows the error and refuses to save, with "Fix or delete <path>". `hece prefs` does the same. → Task 4 and Task 8 tests.
2. **Old `guards: off` plus hand-edited keys in the global file.** Expect: they load as both guards off. A wizard save turns `guards` into a mapping and leaves every untouched key unchanged. → Task 2 and Task 4 tests.
3. **Non-TTY or print-mode runs with no global file** (`hece -p "…"`, `echo x | hece`, `hece status`, hooks, MCP). Expect: the wizard never starts and nothing is written. → Task 9 test.
4. **Ctrl-C mid-wizard.** Expect: the terminal leaves raw mode, nothing is written, the exit code is 130, and Claude is not launched. → Task 8 test.
5. **Terminal narrower than 40 columns, or a CJK locale.** Expect: lines wrap to the width, nothing overflows or throws, and the cursor marker stays visible. → Task 6 test.

---

### Task 1: Vendor table, `effort` group, orchestrator default

**Files:**
- Create: `src/prefs/vendors.ts`
- Modify: `src/prefs/schema.ts`
- Test: `test/prefs/prefs.test.ts`

**Interfaces:**
- Produces:
  - `interface Vendor { label: string; bin: string; supported: boolean; models: readonly string[]; efforts: readonly string[] }`
  - `const VENDORS: Record<Prefs['agent'], Vendor>`: claude is `{ label: 'Claude Code', bin: 'claude', supported: true, models: ['opus','sonnet','haiku','fable'], efforts: ['low','medium','high','xhigh','max'] }`. codex/gemini/opencode have bins `codex`/`gemini`/`opencode`, `supported: false`, and empty lists.
  - `Prefs.effort: { orchestrator: string; build: string; review: string }`. Defaults: `default`, `medium`, `high`.
  - `presetDefaults(...).delegate.orchestrator === 'default'`

- [ ] **Step 1: Write the failing tests** in `test/prefs/prefs.test.ts`:

```ts
describe('effort and orchestrator', () => {
  it('defaults: orchestrator uses Claude Code\'s own setting', () => {
    const p = presetDefaults('involved')
    expect(p.delegate.orchestrator).toBe('default')
    expect(p.effort).toEqual({ orchestrator: 'default', build: 'medium', review: 'high' })
  })
  it('accepts vendor effort levels and rejects others', () => {
    expect(validatePrefs({ effort: { build: 'xhigh' } }, 'x').errors).toEqual([])
    expect(validatePrefs({ effort: { orchestrator: 'default' } }, 'x').errors).toEqual([])
    expect(validatePrefs({ effort: { build: 'default' } }, 'x').errors[0]).toMatch(/"effort.build"/)
    expect(validatePrefs({ effort: { review: 'huge' } }, 'x').errors[0]).toMatch(/allowed: low \| medium \| high \| xhigh \| max/)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/prefs` and confirm the new tests FAIL (`effort` is undefined).
- [ ] **Step 3: Implement.** Add the `VENDORS` table. Then in `schema.ts`, add the `effort` group to `Prefs` and `INVOLVED`, and set `delegate.orchestrator: 'default'`. Add the RULES `'effort.orchestrator': e('default', ...VENDORS.claude.efforts)`, `'effort.build'` and `'effort.review'`: `e(...VENDORS.claude.efforts)`. Put a comment above them: `// shortcut: effort is checked against Claude's levels only; validate against VENDORS[agent] once another adapter is supported`.
- [ ] **Step 4: Run** `npx vitest run test/prefs` and confirm it PASSES. Fix existing tests that pinned `orchestrator: 'opus'`.
- [ ] **Step 5: Commit** with `feat(prefs): vendor table, effort per role, orchestrator follows Claude Code by default`.

### Task 2: Split guards into `stops` and `files`

**Files:**
- Modify: `src/prefs/schema.ts`, `src/guards/guards.ts`, `src/hooks/handle.ts:55,103`, `src/flow/render.ts:16,39`, `src/mcp/server.ts` (every `prefs().prefs.guards`), `src/status/main.ts:15`, `src/panels/views.ts:9`, `src/panels/main.ts:121`
- Test: `test/prefs/prefs.test.ts`, `test/guards/guards.test.ts`, `test/flow/render.test.ts`, plus existing tests whose `Prefs` / `renderFlow` call sites the type change breaks

**Interfaces:**
- Produces:
  - `Prefs.guards: { stops: boolean; files: boolean }` (default both `true`)
  - `renderFlow(s: FlowState, opts: { guards: Prefs['guards'] }): string` prints `guards: on`, `guards: off`, or `guards: partial`
  - `flowPanelLines(flow, opts: { guards: Prefs['guards']; idle; home? })`
  - `setPhase` / `setPlan` / `startSlice` keep `opts: { guards: boolean }`. Callers pass `prefs.guards.stops`.

- [ ] **Step 1: Write the failing tests:**

```ts
// prefs.test.ts
it('legacy guards: off sets both switches', () => {
  expect(validatePrefs({ guards: 'off' }, 'x')).toEqual({ flat: { 'guards.stops': false, 'guards.files': false }, errors: [] })
  expect(resolvePrefs([{ raw: { guards: { files: false } }, source: 'g' }]).prefs.guards).toEqual({ stops: true, files: false })
})
// guards.test.ts
it('files guard alone blocks .hece edits but not code edits during discuss', () => { /* prefs.guards = { stops: false, files: true }: edit .hece/preferences.yaml → deny; edit src/a.ts in discuss → allow */ })
it('stops guard alone blocks code edits in discuss but allows .hece edits', () => { /* { stops: true, files: false } */ })
// render.test.ts
it('shows partial when one guard is off', () => {
  expect(renderFlow(emptyFlow(), { guards: { stops: true, files: false } })).toContain('guards: partial')
})
```

- [ ] **Step 2: Run** `npx vitest run test/prefs test/guards test/flow` and confirm FAIL.
- [ ] **Step 3: Implement.**
  - **Schema:** RULES `'guards.stops'` and `'guards.files'` are BOOL. In `validatePrefs`'s walk, a top-level `guards` holding a bool-like value is checked with the BOOL rule and sets both flat keys.
  - **`decideTool`:** for non-edit tools, allow. Next: if `files` is on and the edit touches hece files, deny. Next: if `stops` is off, allow. Otherwise run the existing phase logic.
  - **`handle.ts:103`:** use `(ctx.prefs.guards.stops || ctx.prefs.guards.files)`.
  - **Flow-function callers in `mcp/server.ts`:** pass `prefs().prefs.guards.stops`.
  - **`renderFlow` callers:** pass the whole `guards` object.
- [ ] **Step 4: Run** `npm run typecheck && npm test` and confirm both PASS (update broken fixtures to the object form).
- [ ] **Step 5: Commit** with `feat(guards): split into stops and files; old on/off still loads`.

### Task 3: Model and effort take effect (launch flags, skills)

**Files:**
- Modify: `src/launch/main.ts`, `skills/flow/SKILL.md:43-45`, `skills/review-findings/SKILL.md:8`
- Test: `test/launch/launch.test.ts`, `test/skills/skills.test.ts`

**Interfaces:**
- Consumes: `Prefs['delegate']`, `Prefs['effort']` (Task 1)
- Produces: `claudeArgs(argv: string[], root: string, prefs?: Pick<Prefs, 'delegate' | 'effort'>): string[]`

- [ ] **Step 1: Write the failing tests:**

```ts
// launch.test.ts
const P = (o: string, e: string) => ({ delegate: { orchestrator: o, build: 'sonnet', review: 'opus' }, effort: { orchestrator: e, build: 'medium', review: 'high' } })
it('adds --model/--effort only when set', () => {
  expect(claudeArgs([], '/r', P('default', 'default'))).toEqual(['--plugin-dir', '/r'])
  expect(claudeArgs([], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--model', 'opus', '--effort', 'high'])
})
it('the user\'s own flags win', () => {
  expect(claudeArgs(['--model', 'haiku'], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--effort', 'high', '--model', 'haiku'])
  expect(claudeArgs(['--effort=low'], '/r', P('opus', 'high'))).toEqual(['--plugin-dir', '/r', '--model', 'opus', '--effort=low'])
})
it('launch reads the global prefs file', () => { /* write delegate.orchestrator: sonnet to <root>/.config-test/hece/preferences.yaml; launch(['--no-frame']); stdout argv contains '--model','sonnet' */ })
// skills.test.ts
it('flow picker offers effort.build first; review passes effort.review', () => {
  expect(read('flow')).toContain('effort: first option `effort.build`')
  expect(read('review-findings')).toContain('`effort.review`')
})
```

- [ ] **Step 2: Run** `npx vitest run test/launch test/skills` and confirm FAIL.
- [ ] **Step 3: Implement.**
  - **`claudeArgs`:** put the flags between `--plugin-dir root` and `argv`. A user flag counts as present if argv has the exact string (`--model`) or it starts with `--model=`.
  - **`runLaunch`:** pass `loadPrefs(process.env, resolveRoot(process.env)).prefs`. Ignore load errors there; the flow skill reports them.
  - **Flow skill line 45:** becomes "effort: first option `effort.build` (its value), then up to three others from `low`, `medium`, `high`."
  - **Review-findings:** add "with effort `effort.review`" after `review.reviewer_model`.
- [ ] **Step 4: Run** `npx vitest run test/launch test/skills` and confirm PASS.
- [ ] **Step 5: Commit** with `feat(launch): pass orchestrator model and effort from preferences`.

### Task 4: Saving the global file

**Files:**
- Create: `src/prefs/save.ts`
- Modify: `src/state/store.ts` (extract `writeFileAtomic(file: string, text: string): void`; `writeJsonAtomic` calls it)
- Test: `test/prefs/save.test.ts`

**Interfaces:**
- Consumes: `presetDefaults`, `resolvePrefs` (schema)
- Produces:
  - `CUSTOM_KEYS: readonly string[]` = `['discussion.first','discussion.pushback','plan.slice_size','slice_stop.depth','check_questions','side_chats.open_in','review.final','review.show_minor','flow_recap']`
  - `flatten(p: Prefs): Record<string, string | boolean>` (dotted keys, the same shape as `validatePrefs().flat`)
  - `interface GlobalFile { path: string; raw: Record<string, unknown>; hadComments: boolean; error?: string; errors: string[] }`. `error` is set when the file can't be read or parsed, or isn't a mapping. `errors` lists validation errors.
  - `readGlobal(file: string): GlobalFile` (a missing file gives `raw: {}` with no error)
  - `startPrefs(g: GlobalFile): Prefs` = `resolvePrefs([{ raw: g.raw, source: g.path }]).prefs`, global only
  - `nextRaw(raw: Record<string, unknown>, next: Prefs, touched: readonly string[]): Record<string, unknown>`
  - `promoteToCustom(p: Prefs, touched: readonly string[]): { prefs: Prefs; touched: string[] }`
  - `saveGlobal(g: GlobalFile, raw: Record<string, unknown>): void` throws if `g.error` is set, then writes `YAML.stringify(raw)` atomically

- [ ] **Step 1: Write the failing tests:**

```ts
it('writes only what differs from the preset, plus preset', () => {
  const p = { ...presetDefaults('involved'), optimize: 'caveman' as const }
  expect(nextRaw({}, p, ['optimize', 'layout.left'])).toEqual({ preset: 'involved', optimize: 'caveman' })
})
it('a touched key set back to the default is removed', () => {
  expect(nextRaw({ optimize: 'caveman' }, presetDefaults('involved'), ['optimize'])).toEqual({ preset: 'involved' })
})
it('keeps untouched and unknown keys', () => {
  expect(nextRaw({ layout: { left: 'none' }, mystery: 1 }, presetDefaults('involved'), ['optimize']))
    .toEqual({ preset: 'involved', layout: { left: 'none' }, mystery: 1 })
})
it('a non-custom preset removes custom-only keys', () => {
  expect(nextRaw({ check_questions: 'every', plan: { slice_size: 'medium' } }, presetDefaults('learning'), ['preset'])).toEqual({ preset: 'learning' })
})
it('legacy guards scalar becomes a mapping when a guard is touched', () => {
  const p = presetDefaults('involved'); p.guards = { stops: false, files: true }
  expect(nextRaw({ guards: 'off' }, p, ['guards.stops'])).toEqual({ preset: 'involved', guards: { stops: false } })
})
it('editing a custom key under a preset switches to custom and keeps the old values', () => {
  const p = presetDefaults('learning'); p.check_questions = 'every'
  const r = promoteToCustom(p, ['check_questions'])
  expect(r.prefs.preset).toBe('custom')
  expect(resolvePrefs([{ raw: nextRaw({}, r.prefs, r.touched), source: 'g' }]).prefs)
    .toMatchObject({ preset: 'custom', check_questions: 'every', flow_recap: true, review: { show_minor: true } })
})
it('refuses to save over a file that does not parse', () => {
  /* write "a: [" to file; g = readGlobal(file); g.error matches /invalid YAML/; expect(() => saveGlobal(g, {})).toThrow(); file text unchanged */
})
it('notices comments', () => { /* "# mine\npreset: learning\n" → hadComments true, raw { preset: 'learning' } */ })
```

- [ ] **Step 2: Run** `npx vitest run test/prefs/save.test.ts` and confirm FAIL (module missing).
- [ ] **Step 3: Implement** `save.ts`.
  - `readGlobal` reuses the read/parse error wording from `load.ts`'s `readYaml`. Export `readYaml` from `load.ts` rather than copying it.
  - `nextRaw` builds the output:
    1. Clone `raw`, then set `preset`.
    2. If `out.guards` isn't a mapping and a `guards.*` key was touched, replace it with `{}`.
    3. For each touched dotted key, set the value if it differs from `presetDefaults(next.preset)`, and delete it otherwise.
    4. If the preset isn't `custom`, delete every `CUSTOM_KEYS` entry.
    5. Drop groups left empty.
  - `hadComments` is `/^\s*#|\s#/m`.
- [ ] **Step 4: Run** `npx vitest run test/prefs test/state` and confirm PASS.
- [ ] **Step 5: Commit** with `feat(prefs): save the global file with only what changed`.

### Task 5: `hece doctor`

**Files:**
- Create: `src/doctor/main.ts`
- Modify: `src/cli.ts` (route `doctor` before the frame fallthrough; add a USAGE line)
- Test: `test/doctor/doctor.test.ts`

**Interfaces:**
- Produces:
  - `interface Check { ok: boolean; label: string; fix?: string; optional?: boolean }`
  - `interface DoctorDeps { nodeVersion: string; onPath(bin: string): boolean; exists(file: string): boolean; plugins: Set<string> | null; prefsErrors: string[]; pkgRoot: string; optimize: Prefs['optimize'] }`
  - `runChecks(d: DoctorDeps): Check[]`, in this order: Node ≥ 20, tmux (optional), built (`<pkgRoot>/dist/cli.js`), claude on PATH, superpowers, optimize pack, preferences, plugin wiring (`.claude-plugin/plugin.json` and `hooks/hooks.json` under `pkgRoot`)
  - `formatChecks(c: Check[]): string`: `✓ label` or `✗ label`, then an indented `  fix`. The last line is `Claude Code's own check: claude doctor`.
  - `installedPlugins(env: NodeJS.ProcessEnv, home?: string): Set<string> | null` reads `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json`. It returns the names before `@` from the keys of `json.plugins`, or `null` if the file is unreadable.
  - `runDoctor(): Promise<void>` sets exit code 1 if a non-optional check failed

- [ ] **Step 1: Write the failing tests.**
  - **All green:** deps where everything is ok give eight `ok` checks.
  - **Missing superpowers:** `plugins = new Set(['ponytail'])` gives a superpowers check with `ok: false` and `fix` equal to the verbatim install command.
  - **`optimize: 'caveman'`, not installed:** the fix contains `/plugin install caveman@caveman`.
  - **tmux missing:** the check is `optional`, and `runDoctor` via `runCli(['doctor'], …)` with `PATH` stripped of tmux exits with status 0 when nothing else fails. Use a fake `claude` bin, as `launch.test.ts` does.
  - **`plugins === null`:** the superpowers fix reads "couldn't read Claude Code's plugin list".
  - **`nodeVersion: 'v18.20.0'`:** the Node check fails.
  - **`runCli(['doctor'])`:** stdout ends with `Claude Code's own check: claude doctor\n`.
- [ ] **Step 2: Run** `npx vitest run test/doctor` and confirm FAIL.
- [ ] **Step 3: Implement.** `runDoctor` builds the real deps:
  - **`onPath`:** `spawnSync(bin, ['--version'])` with status 0.
  - **`pkgRoot`:** `pluginRoot()`.
  - **`prefsErrors` and `optimize`:** from `loadPrefs(process.env, resolveRoot(process.env))`.
- [ ] **Step 4: Run** `npx vitest run test/doctor test/frame` and confirm PASS (frame tests still pass; `doctor` stays in `CLAUDE_SUBCOMMANDS`, harmlessly).
- [ ] **Step 5: Commit** with `feat(doctor): hece doctor checks the install`.

### Task 6: Wizard engine: key reducer and renderer

**Files:**
- Create: `src/setup/tui.ts`
- Test: `test/setup/tui.test.ts`

**Interfaces:**
- Produces:
  - `interface Option { label: string; value: string | boolean; note?: string; disabled?: string; preview?: string[] }`
  - `interface Key { name?: string; sequence?: string; ctrl?: boolean }` (the shape of readline's keypress `key`)
  - `type Step = { kind: 'move'; cursor: number } | { kind: 'pick'; index: number } | { kind: 'back' } | { kind: 'quit' } | { kind: 'abort' } | { kind: 'none' }`
  - `onKey(cursor: number, options: Option[], key: Key): Step`
  - `renderScreen(title: string, lines: string[], options: Option[], cursor: number, width: number): string[]`
  - `interface Io { keys: AsyncIterator<Key>; write(s: string): void; width(): number; close(): void }`
  - `ask(io: Io, title: string, lines: string[], options: Option[], initial: number): Promise<{ kind: 'pick'; value: string | boolean } | { kind: 'back' | 'quit' | 'abort' }>`
  - `terminalIo(): Io`: `readline.emitKeypressEvents(stdin)`, `setRawMode(true)`, hides the cursor. `close()` restores raw mode and the cursor and pauses stdin. It is safe to call twice.

- [ ] **Step 1: Write the failing tests:**

```ts
const opts: Option[] = [{ label: 'a', value: 'a' }, { label: 'b', value: 'b', disabled: 'not yet' }, { label: 'c', value: 'c' }]
it('down skips disabled, stops at the end', () => {
  expect(onKey(0, opts, { name: 'down' })).toEqual({ kind: 'move', cursor: 2 })
  expect(onKey(2, opts, { name: 'down' })).toEqual({ kind: 'none' })
  expect(onKey(2, opts, { name: 'k' })).toEqual({ kind: 'move', cursor: 0 })
})
it('number keys pick directly, not disabled ones', () => {
  expect(onKey(0, opts, { name: '3', sequence: '3' })).toEqual({ kind: 'pick', index: 2 })
  expect(onKey(0, opts, { name: '2', sequence: '2' })).toEqual({ kind: 'none' })
})
it('enter, b, escape, ctrl-c', () => {
  expect(onKey(2, opts, { name: 'return' })).toEqual({ kind: 'pick', index: 2 })
  expect(onKey(0, opts, { name: 'b' })).toEqual({ kind: 'back' })
  expect(onKey(0, opts, { name: 'escape' })).toEqual({ kind: 'quit' })
  expect(onKey(0, opts, { name: 'c', ctrl: true })).toEqual({ kind: 'abort' })
})
it('renders numbered options, marks the cursor, shows its preview and the key hint', () => {
  const out = renderScreen('Preset', ['pick one'], [{ ...opts[0], preview: ['example'] }, opts[2]], 0, 40).map(stripAnsi)
  expect(out).toEqual(expect.arrayContaining(['› 1. a', '  2. c', 'example']))
  expect(out.at(-1)).toMatch(/↑↓.*Enter.*b back.*Esc/)
})
it('fits narrow and CJK widths', () => {
  for (const w of [20, 39]) for (const l of renderScreen('設定 settings', ['長い説明文がここに入ります long text here'], opts, 0, w)) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(w)
})
it('ask returns the picked value using a fake io', async () => { /* keys: down, return → { kind: 'pick', value: 'c' }; write called with a clear-screen + frame per key */ })
```

- [ ] **Step 2: Run** `npx vitest run test/setup/tui.test.ts` and confirm FAIL.
- [ ] **Step 3: Implement.** A disabled option renders dim, followed by `— <disabled>`. Each frame is written as `\x1b[2J\x1b[H` plus the lines joined with `\r\n` (raw mode needs `\r`). `ask` redraws on `move`, and on resize: `terminalIo` listens to `process.stdout` `resize` and pushes a `{ name: 'resize' }` key, which `onKey` maps to `{ kind: 'move', cursor }` at the same cursor.
- [ ] **Step 4: Run** `npx vitest run test/setup` and confirm PASS.
- [ ] **Step 5: Commit** with `feat(setup): keyboard picker that works over phone SSH`.

### Task 7: Screen definitions

**Files:**
- Create: `src/setup/screens.ts`
- Test: `test/setup/screens.test.ts`

**Interfaces:**
- Consumes: `Option` (Task 6), `VENDORS` (Task 1), `Prefs`
- Produces:
  - `interface SetupContext { onPath(bin: string): boolean; plugins: Set<string> | null; fileErrors: string[] }`
  - `interface Screen { id: string; group: string; key?: string; title: string; lines(p: Prefs, c: SetupContext): string[]; options(p: Prefs, c: SetupContext): Option[]; when?(p: Prefs): boolean }`. `key` is the dotted pref key the screen sets; `intro` has no key.
  - `SCREENS: readonly Screen[]`, in spec order. Each entry below is `id` (group); the pref key is given where it isn't obvious from the id.
    - `intro` (intro)
    - `agent` (agent)
    - `preset` (preset)
    - custom-only screens, group = their own id, `when: p => p.preset === 'custom'`:
      - `discussion-first` → `discussion.first`
      - `pushback` → `discussion.pushback`
      - `slice-size` → `plan.slice_size`
      - `stop-depth` → `slice_stop.depth`
      - `check-questions`
      - `side-chats` → `side_chats.open_in`
      - `review-final`
      - `review-minor` → `review.show_minor`
      - `recap` → `flow_recap`
    - `optimize` (skills)
    - models group, six screens:
      - `orchestrator-model` → `delegate.orchestrator`
      - `orchestrator-effort` → `effort.orchestrator`
      - `build-model` → `delegate.build`
      - `build-effort` → `effort.build`
      - `review-model` → `review.reviewer_model`
      - `review-effort` → `effort.review`
    - guards group: `guard-stops`, `guard-files`
    - layout group: `layout-left`, `layout-right`
  - `setKey(p: Prefs, key: string, value: string | boolean): Prefs` (on a clone)
  - `PREFS_NAMES: readonly string[]` = the distinct `group` values minus `intro`

- [ ] **Step 1: Write the failing tests.**
  - **Intro:** `intro.lines` includes each `fileErrors` entry.
  - **Agent screen:** with `onPath = b => b === 'claude'`, labels are `claude ✓`, `codex ✗`, and so on. codex, gemini and opencode have `disabled: 'not supported yet'`.
  - **Preset screen:** each of its three options has a non-empty `preview`.
  - **Custom-only screens:** `when` is false for `involved` and true for `custom`.
  - **Optimize screen:** with `plugins = new Set(['ponytail'])`, `lines` contain the superpowers install command. `plugins = null` shows "couldn't read Claude Code's plugin list".
  - **Orchestrator screens:** the first option is `{ label: "Claude Code's own setting", value: 'default' }`, followed by the four models or five efforts.
  - **Build and review effort screens:** options are exactly the five Claude efforts.
  - **`setKey`:** `setKey(p, 'guards.files', false).guards` equals `{ stops: true, files: false }`, and `p` is unchanged.
  - **`PREFS_NAMES`:** contains `agent`, `preset`, `skills`, `models`, `guards`, `layout` and each custom screen id.
  - **Label length:** every option label of every screen, for every vendor and preset, is ≤ 30 by `displayWidth`.
- [ ] **Step 2: Run** `npx vitest run test/setup/screens.test.ts` and confirm FAIL.
- [ ] **Step 3: Implement.** Copy is the builder's call (spec "Left to the builder"). The guard screens carry the one-line "what off gives up" note from the spec. The preset previews are a 3–5 line slice-stop example at that preset's `slice_stop.depth`, with a check question for `learning`.
- [ ] **Step 4: Run** `npx vitest run test/setup` and confirm PASS.
- [ ] **Step 5: Commit** with `feat(setup): wizard screens for agent, preset, skills, models, guards, layout`.

### Task 8: `hece setup` and `hece prefs`

**Files:**
- Create: `src/setup/main.ts`
- Modify: `src/cli.ts` (route `setup` and `prefs`; USAGE lines)
- Test: `test/setup/main.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 6 and 7
- Produces:
  - `interface SetupDeps { io: Io; file: string; ctx: SetupContext; doctor(): Check[]; out(s: string): void }`
  - `runWizard(d: SetupDeps, opts: { firstRun: boolean }): Promise<'saved' | 'skipped' | 'cancelled' | 'aborted'>`
  - `runPrefsEdit(d: SetupDeps, name?: string): Promise<'saved' | 'cancelled' | 'aborted'>`
  - `runSetup(argv: string[]): Promise<void>` and `runPrefs(argv: string[]): Promise<void>` (CLI wrappers)

- [ ] **Step 1: Write the failing tests.** Each test uses a fake `Io` fed a key list and a temp `file`.
  - **Enter through:** Enter through every screen on a fresh file writes `{ preset: 'involved' }` → returns `'saved'`.
  - **Pick caveman:** picking caveman on `optimize` writes `optimize: caveman` and nothing else beyond `preset`.
  - **`b` on screen 3:** returns to screen 2 with its earlier answer preselected. `b` on the first screen stays put.
  - **Esc mid-wizard, not first run:** `'cancelled'`, and the file is not created.
  - **Esc, first run:** `'skipped'`, and the file holds `preset: involved`. `out` received "Defaults saved. Change them any time with `hece prefs`."
  - **Ctrl-C:** `'aborted'`, nothing written, `io.close` called.
  - **Summary screen:** shows the YAML and the path. With `hadComments` it also shows the "comments will be lost" note. With `readGlobal(...).error` it shows "Fix or delete <path>", offers only Exit, and nothing is written.
  - **`runPrefsEdit(d, 'check-questions')`** under `learning`: picking `every` saves a file that resolves to `preset: custom` with learning's other values (via `promoteToCustom`).
  - **Unknown name:** `runPrefsEdit(d, 'nope')` prints the valid names and returns `'cancelled'`.
  - **`runPrefsEdit(d)` with no name:** shows the `PREFS_NAMES` list first.
  - **Non-TTY:** `runCli(['setup'])` with stdin not a TTY exits 1 with "hece setup needs a terminal".
- [ ] **Step 2: Run** `npx vitest run test/setup/main.test.ts` and confirm FAIL.
- [ ] **Step 3: Implement.**
  - Walk `SCREENS`, skipping those whose `when` is false. Keep a history stack for `b`. The `touched` list is every `key` shown. Then show the summary (YAML from `nextRaw`) and the doctor screen (`formatChecks(d.doctor())` plus Continue). Finally call `saveGlobal`.
  - Always `io.close()` in `finally`.
  - `runPrefsEdit` runs only that group's screens, then `promoteToCustom`, then saves (no summary).
  - The CLI wrappers set `process.exitCode = 130` on `'aborted'`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run test/setup` and confirm PASS.
- [ ] **Step 5: Commit** with `feat(setup): hece setup wizard and hece prefs`.

### Task 9: First run, docs

**Files:**
- Modify: `src/cli.ts`, `README.md` (Quick start and Preferences sections), `docs/superpowers/specs/2026-10-18-hece-design.md` §8 (one line at the top: "Amended by `2026-10-28-onboarding-design.md`.")
- Test: `test/setup/first-run.test.ts`

**Interfaces:**
- Consumes: `runWizard` (Task 8), `interactiveClaude` (`src/frame/main.ts`), `prefsFiles`
- Produces: `needsFirstRun(argv: string[], o: { stdinTTY: boolean; stdoutTTY: boolean; globalExists: boolean }): boolean` = `!o.globalExists && interactiveClaude(argv, o)`

- [ ] **Step 1: Write the failing tests:**

```ts
it('first run only for an interactive claude session with no global file', () => {
  const tty = { stdinTTY: true, stdoutTTY: true }
  expect(needsFirstRun([], { ...tty, globalExists: false })).toBe(true)
  expect(needsFirstRun(['--no-frame'], { ...tty, globalExists: false })).toBe(true)
  expect(needsFirstRun([], { ...tty, globalExists: true })).toBe(false)
  expect(needsFirstRun(['-p', 'hi'], { ...tty, globalExists: false })).toBe(false)
  expect(needsFirstRun([], { stdinTTY: false, stdoutTTY: true, globalExists: false })).toBe(false)
  expect(needsFirstRun(['update'], { ...tty, globalExists: false })).toBe(false)
})
it('piped hece never writes the global file', () => { /* runCli(['--no-frame'], { stdin: 'x', env: { HECE_CLAUDE_BIN: fake } }); expect global file absent */ })
```

- [ ] **Step 2: Run** `npx vitest run test/setup/first-run.test.ts` and confirm FAIL.
- [ ] **Step 3: Implement.** In `cli.ts`'s fallthrough (before `runLaunch` / `runFrame`): if `needsFirstRun`, run `runWizard({ firstRun: true })`. On `'aborted'`, set exit code 130 and return without launching. On anything else, continue. Strip `--no-frame` before calling `needsFirstRun`, the same way the existing branch does. README: add `hece setup`, `hece prefs [name]` and `hece doctor` to Quick start, and say in Preferences that the wizard writes the global file.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build` and confirm all PASS. Then `hece doctor` prints the check list against this VPS's real install.
- [ ] **Step 5: Commit** with `feat(setup): run the wizard on first launch; docs`.
