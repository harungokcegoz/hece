# hece — design spec

- **Date:** 2026-10-18
- **Status:** Draft, awaiting review
- **Name:** *hece* (Turkish: "syllable"; *hecelemek* = to spell out syllable by syllable). Break features into pieces small enough to say — and understand — properly.

---

## 1. Problem

AI coding agents got fast and reliable enough that developers moved from *building with them* to *watching them build*. Features ship, tests pass, and afterwards the developer can't answer: *How did you connect A to B? What is the flow? Why this approach?*

Two costs:

1. **Now:** insecurity. You approve work you don't understand because it's too big and too fast to digest, so approval becomes trust instead of understanding.
2. **Long term:** skill atrophy. After years of this, a developer can describe what they want but can't build, debug or defend it.

The root cause is **size and pace**, not the agent's quality. Explanations and plans arrive in chunks larger than a person can absorb.

## 2. Goals

- **G1 — Awareness while building.** You always know where you are in the flow, what just changed, and how it connects to what existed.
- **G2 — Understanding through discussion.** Decisions are made in a peer debate (you propose, the agent proposes, either can push back with reasons), the way you'd work with a senior.
- **G3 — Controlled pace.** Everything is chunked: one decision per turn, small slices, a stop after each slice.
- **G4 — Clear, short communication.** Point first, specific, never superficial; diagrams where they explain better than text.
- **G5 — Use the tools people already have.** hece frames existing agent CLIs; it does not replace them.
- **G6 — Open source, vendor-visible.** Claude Code first; Codex CLI, Gemini CLI and OpenCode are visible first-class targets from day one.

**Success looks like:** after a feature built with hece, the developer can explain its flow, defend its key decisions and debug it without the agent.

## 3. Non-goals (v0.1)

- A GUI or desktop app (terminal first; a GUI only if the terminal version proves itself).
- Our own coding agent. The agent loop stays in Claude Code / Codex / Gemini / OpenCode.
- A learning log or spaced repetition. Memory is left to the host CLI.
- Side chats returning results to the main chat. Side chats are throwaway.
- Cross-vendor workers (e.g. a Claude orchestrator dispatching Codex workers).
- Native Windows (tmux). WSL may work but is untested.
- Behaviour evals, headless tmux tests and panel snapshot tests (see §12).

## 4. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Frame, not fork.** hece runs the real vendor CLI, unchanged, in the middle of a tmux layout and adds its own side panels. | A spike (§13) showed two-way agent↔panel communication works with tmux + MCP + hooks. Forking OpenCode would tie us to one agent and cost weeks of plumbing. Users keep their tuned setups. |
| D2 | **Build on superpowers** (MIT, obra/superpowers) for the workflow: brainstorming, writing-plans, subagent-driven-development, requesting-code-review. | Don't reinvent a proven workflow. It already supports Codex, Gemini and others. hece is the *in-the-loop layer* on top: pacing, communication rules, check questions, panels, onboarding, preferences. |
| D3 | **Orchestrator + workers.** A strong model (Opus / Fable) discusses, plans, steers and reviews; cheaper models (Sonnet / Haiku, or the vendor's equivalents) build slices. | Judgment calls (slice too big? plan needs to change?) are better made by a smart orchestrator than by code. Cost goes down. |
| D4 | **The LLM steers; code guards only two rules — and the guards are optional.** | The orchestrator is the party being supervised; its bias is to finish fast. Two guards (no edits while stopped, no self-approval) keep the stop real. Users can turn them off for a fully LLM-driven flow. |
| D5 | **TypeScript on Node.** Ink for panels, official MCP SDK, vitest. | MCP SDK is TypeScript-first; Ink is what Claude Code uses; widest contributor pool. A single binary via Bun later. |
| D6 | **State in plain files**, not sockets or a daemon. | Crash-safe, any number of readers, nothing to supervise, and you can `cat` exactly what hece believes is happening. |
| D7 | **Panel actions are structured events**, not English prompts. | In the spike, a panel "continue" phrased as English was (correctly) refused by the agent. Skills handle named events deterministically. |
| D8 | **Onboarding is a plain wizard**, not an LLM conversation. | Free, instant, identical for everyone. |
| D9 | **Activity speaks plain language, not commands** (amended 2026-10-20). Two layers: *intent lines* the agent writes through an `activity_note` MCP tool (what it is doing and why), and *action lines* translated from hook events by simple rules ("changing auth/reset.js", "running the tests"). hece's own bookkeeping calls are hidden; raw commands are not shown. | Raw tool calls (`ls -la && find …`, `ToolSearch {…}`) are noise, not understanding. Only the agent knows its intent; rules make actions readable at no cost. A summarizing model stays an optional later extra. |
| D10 | **Frame MVP panels are plain ANSI renderers**, not Ink (amended 2026-10-20). | The MVP panels are read-only: pure render functions plus a redraw-on-change loop are simpler to test. Ink comes in when panels become interactive (plan 2b). |

## 5. The flow

```
discuss ─▶ plan ─▶ build: [ slice 1 ─▶ slice 2 ─▶ … ] ─▶ review ─▶ recap ─▶ done
                          each slice: working ─▶ stopped ─▶ approved
```

### 5.1 Discuss
- Uses superpowers `brainstorming` with hece pacing: **one decision per turn**, peer pushback with reasons, either side can propose or counter-propose.
- Each settled decision is recorded with `flow_add_decision(title, choice, why)` and appears under *Discussion* in the Flow panel.
- Ends when you say to plan (typed, or a panel action).

### 5.2 Plan
- Uses superpowers `writing-plans`, constrained to **slices**: each slice is one behaviour you can see working, touching ~1–3 files (`small`) or ~3–6 (`medium`).
- Each slice carries: title, expected files, kind (`routine` | `teaching`), and assigned model.
- Recorded with `flow_set_plan([...])`. The plan becomes active only after **your** approval.

### 5.3 Build (per slice)
1. `flow_start_slice(n)`. If Delegate is on, the orchestrator dispatches the slice to a worker (superpowers `subagent-driven-development`, overlaid with "one task = one slice, stop after each"). Edits and commands stream into Activity under the slice.
2. The orchestrator **reviews the worker's output** (quiet per-slice review). If it fixed something, that is mentioned in one line at the stop.
3. `flow_finish_slice(n, summary, connects_to)`. Slice is **stopped**.
4. The agent explains the slice following the communication rules (§6), then asks a check question if one applies (§7).
5. Choices via the host's native arrow-key picker: **continue / ask about this / side chat / redo**.
6. On approval, next slice.

If the orchestrator judges a slice has grown beyond its size, it stops and proposes a split. If the plan needs to change, it proposes the change via `flow_set_plan`; the Flow panel marks the plan *changed — pending approval* until you approve.

### 5.4 Review
- **Final review** of the whole feature by a fresh reviewer agent with no build context, via superpowers `requesting-code-review`, on `review.reviewer_model`.
- Findings arrive **chunked**: one summary line ("2 important, 3 minor"), then one finding at a time — file, problem, why it matters — with choices **fix now / skip / ask about it (side chat)**.
- `review.show_minor: false` hides nitpicks.

### 5.5 Recap (optional)
A short A → B → C walkthrough of the whole feature's flow, usually with one diagram.

### 5.6 Approval sources
A slice or plan is approved only by a human action:
- a panel key (hece writes approval to state directly),
- the human's answer in the native picker (seen by a `PostToolUse` hook on the picker tool),
- a typed message matching a short continue intent (`continue`, `ok`, `next`, `go`, `approve`) seen by the `UserPromptSubmit` hook. Any other message keeps the slice stopped (it's treated as a question).

There is **no approve tool** in hece's MCP server.

## 6. Communication rules (always on, in every skill)

- **Point first.** The first sentence says what happened or what's being asked.
- **Hard length caps** by `slice_stop.depth`: `line` = 1 line, `short` ≤ 5 lines, `detailed` ≤ 15 lines (diagrams don't count toward the cap).
- **Specific, not superficial.** Name real functions and files (`refreshToken()` in `auth/session.ts`). One *why* per decision.
- **No filler.** No restating the user, no praise, no summary of the summary.
- **Diagrams where they fit:** data flow between parts, call sequences, state changes. Not for one-file tweaks. A diagram **replaces** prose. Box-drawing text only (terminals don't render Mermaid), width ≤ the middle pane.

Example slice stop:

```
Slice 3 done: refresh flow.

  request ─▶ authMiddleware ─▶ expired? ─no─▶ handler
                                  │yes
                                  ▼
                          refreshToken() ─▶ retry once

New: refreshToken() in auth/session.ts. Called from authMiddleware.
Why retry once: a second failure means the refresh token is dead → logout.

? What happens if two requests expire at the same moment?
```

## 7. Features and presets

| Feature | Always on? | Settings |
|---|---|---|
| Discussion | yes | `first: me \| agent`, `pushback: gentle \| direct` |
| Chunked plan | yes | `slice_size: small \| medium` |
| Slice stops | yes | `depth: line \| short \| detailed` |
| Check questions | no | `off \| non-routine \| every` — one skippable question per slice about the wiring |
| Side chats | no | `open_in: pane \| window` |
| Review | no | `final`, `reviewer_model`, `show_minor` |
| Flow recap | no | `true \| false` |
| Delegate | no | model per phase |
| Guards | no | `on \| off` |

| Preset | What's on |
|---|---|
| **Involved** (default) | discussion, chunked plan, slice stops (`short`), side chats, final review (no minor), guards on. No check questions, no recap. |
| **Learning** | everything above + check questions (`non-routine`), minor review findings, flow recap. |
| **Custom** | each setting chosen individually. |

## 8. Onboarding and preferences

Amended by `2026-10-28-onboarding-design.md`.

### 8.1 Onboarding (`hece setup`, runs automatically on first `hece`)
Plain Ink wizard, **one thing per screen**, arrow keys:

1. What hece is (three lines).
2. Agent: detects installed CLIs (`claude ✓ codex ✗ gemini ✗ opencode ✗`); pick one. For Claude Code, checks superpowers is installed and offers the install command if not.
3. Preset, each with a small rendered example of a slice stop in that preset.
4. Custom only: one screen per feature, example + options.
5. Layout: which widget left, which right.
6. Delegate: model per phase.
7. Guards: on/off with a one-line note on what "off" gives up.
8. Summary → save.

`hece prefs` reopens any single screen.

### 8.2 Preferences files
- Global: `~/.config/hece/preferences.yaml`
- Project (optional, committable): `.hece/preferences.yaml`, overrides global key by key.
- The agent reads them via MCP `prefs_get` at session start.

```yaml
preset: custom
agent: claude
discussion: { first: me, pushback: direct }
plan: { slice_size: small }
slice_stop: { depth: short }
check_questions: non-routine     # off | non-routine | every
side_chats: { open_in: pane }
review: { final: on, reviewer_model: opus, show_minor: false }
flow_recap: true
layout: { left: activity, right: flow }   # flow | activity | sessions | none
delegate: { orchestrator: opus, build: sonnet, review: opus }
guards: on
```

Invalid values are rejected with a message naming the key and the allowed values.

## 9. Layout

One terminal window, three panes, via tmux on a private socket (`tmux -L hece`):

```
┌─ LEFT (widget) ───────┬──── MIDDLE ─────────────────┬─ RIGHT (widget) ───────┐
│ Activity              │                             │ FLOW · Involved        │
│  edit auth/refresh.ts │   claude / codex / gemini   │ ✓ Discussion (4)       │
│  run  npm test        │   / opencode — unchanged    │ ✓ Plan (6 slices)      │
│ Sessions              │                             │ ▸ 3. Refresh flow      │
│ ▸ main                │                             │   4. Logout            │
│   side: "k8s?"        │                             │   Review · Recap       │
└───────────────────────┴─────────────────────────────┴────────────────────────┘
 guards: on · transport: channel                              F1 left  F2 agent  F3 right
```

- **Widgets:** *Flow* (phases, decisions, slices, current step; arrows + Enter open a step's summary, read-only), *Activity* (what is happening in the current slice, in plain language: the agent's intent lines plus readable action lines, grouped by slice; see D9), *Sessions* (main + side chats; arrows to switch).
- Side panels keep fixed widths on resize (re-applied on `client-resized` / `window-resized`).
- Mouse on; F1/F2/F3 focus; no tmux keybindings needed.
- **Side chats:** `claude --resume <session_id> --fork-session` in a hidden tmux window, swapped into the middle. Closing a side chat kills it; nothing returns to main.

## 10. Architecture

### 10.1 Components

| Unit | Job | Depends on |
|---|---|---|
| `cli` | `hece`, `hece setup`, `hece prefs`, `hece doctor` | all below |
| `launcher` | build layout, start agent via adapter, attach / resume / quit, detect agent exit | tmux, adapter, state |
| `state` | `.hece/state/`: `flow.json`, `events.jsonl`, `sessions.json`, `panes.json`; atomic writes | — |
| `mcp` | MCP server (stdio) the agent calls | state, prefs |
| `hooks` | one `hece hook` command handling the vendor's hook events: activity logging, approval detection, guards | state, prefs |
| `panels` | Flow / Activity / Sessions Ink widgets; watch state files | state, actions |
| `actions` | panel → agent structured events over a transport | state, tmux |
| `skills` | hece's in-the-loop skills (markdown), layered on superpowers | superpowers |
| `adapters/<vendor>` | launch args, MCP/hook wiring, skill installation, hook-event mapping, capability flags | — |
| `onboarding`, `prefs` | wizard; load / merge / validate preferences | — |

### 10.2 Data flow

```
agent ──MCP tool call──▶ mcp ──writes──▶ state ──watched──▶ panels
agent ──hooks──▶ hece hook ──appends──▶ events.jsonl ──▶ Activity
                         └─ guards: allow / deny edit
panel key ──▶ actions ──channel | keys-when-idle──▶ agent ──▶ skill handles event
```

### 10.3 MCP tools
`flow_get`, `flow_set_phase`, `flow_add_decision`, `flow_set_plan`, `flow_start_slice`, `flow_finish_slice`, `flow_report_review`, `prefs_get`. No approval tool.

### 10.4 Hooks (Claude Code adapter)
- `SessionStart` — record `session_id` (main or fork).
- `UserPromptSubmit` — log; detect typed approval (§5.6).
- `PreToolUse` — log; **guards** (when `guards: on`): deny `Edit` / `Write` / `MultiEdit` / `NotebookEdit` during discuss and plan (until plan approved) and while a slice is stopped, with a reason string (`hece: slice 3 is waiting for the user`). Shown in the Flow panel. Bash is not blocked (read-only commands are useful while answering questions); the guard is a tripwire, not a sandbox.
- `PostToolUse` — log; detect approval from the native picker's answer.
- `Stop` — mark the agent idle (used by the keystroke transport).

### 10.5 Panel → agent events
Format: `[hece] event=<name> step=<id>` plus optional fields. Events: `continue`, `redo`, `skip_question`, `fix_finding`, `skip_finding`, `plan_approved`. Side chats are handled by the launcher, not sent to the agent.

**Transports**, chosen automatically, shown in the footer:
1. **Channel** — Claude Code channels (MCP server pushes `notifications/claude/channel`). Research preview; requires a launch flag and may be blocked by org policy.
2. **Keys** — `tmux send-keys`, only when the agent is idle (Stop hook) **and** the input line is empty; otherwise the action is queued and the panel shows *queued* and why.

### 10.6 Skills vs code

**Prompts ask, code enforces.** Judgment and style live in skills; anything that would break trust if it failed, plus plumbing, lives in code.

| Concern | Skill | Code |
|---|---|---|
| Pacing, explanations, diagrams, pushback | ✓ | |
| Slice size, plan changes, reviewing workers | ✓ (orchestrator judgment) | |
| No edits while stopped / before plan approval | asks | hook (if `guards: on`) |
| No self-approval | asks | approval only from human sources (if `guards: on`) |
| Queueing, transports, fallback | | actions |
| Crash detection, resume, atomic state | | launcher, state |

hece skills (initial set): `hece:flow` (entry; how the phases map to superpowers skills and hece tools), `hece:slice-stop`, `hece:check-question`, `hece:communicate` (§6), `hece:review-findings`, `hece:recap`.

### 10.7 Repository layout

```
hece/
  src/{cli,launcher,state,mcp,hooks,panels,actions,onboarding,prefs}/
  skills/
  adapters/
    claude-code/                      # v0.1
    codex/  gemini-cli/  opencode/    # README: planned
  docs/
  test/
```

### 10.8 Vendor support (README table)

| Vendor | Status | Panels | Guards | Delegate |
|---|---|---|---|---|
| Claude Code | v0.1 | full | hard (hooks) | subagents with model per slice |
| Codex CLI | planned | decided in its adapter spec | soft (prompt only) unless hooks exist | decided in its adapter spec |
| Gemini CLI | planned | decided in its adapter spec | soft unless hooks exist | decided in its adapter spec |
| OpenCode | planned | decided in its adapter spec | soft unless hooks exist | decided in its adapter spec |

Each planned vendor gets its own short adapter spec when work on it starts; v0.1 ships only the Claude Code adapter.

## 11. Failure handling

**hece fails visibly, never silently.** Every block, queue, fallback and resume is shown in a panel.

| Situation | Handling |
|---|---|
| Agent ignores a stop | Guard denies the edit with a reason; Flow panel flags the attempt. With `guards: off`, the skill is the only check. |
| Slice grows too big | Orchestrator stops and proposes a split; you approve it like a plan change. |
| Plan changes mid-build | Proposed via `flow_set_plan`; marked *pending* until you approve. |
| Panel key while agent busy | Queued until `Stop` reports idle. |
| Half-typed input when a key action fires | Keys transport waits; panel says why. |
| Channels unavailable | Falls back to keys; footer shows transport. |
| Agent CLI exits | Launcher detects the dead pane; panel offers `r` to resume via `--resume <session_id>`. |
| hece / terminal closed | tmux keeps running → `hece` reattaches. If tmux is gone, rebuild layout from state and resume the session. |
| Corrupt state | Atomic writes (temp + rename); bad `events.jsonl` lines skipped. |
| User ignores panels | Fine. Chat is primary; typing works the same as panel keys. |

## 12. Testing (v0.1)

- **Unit (vitest):** `state` (atomic writes, bad lines skipped), `prefs` (merge, presets, validation messages), `guards` (deny while stopped / before plan approval; approval only from human sources; disabled when `guards: off`), `actions` (queue while busy, wait on non-empty input, channel → keys fallback).
- **Integration:** MCP server over real stdio with a scripted client; `hece hook` fed **captured real Claude Code payloads** stored as fixtures, so a Claude Code update that changes payloads fails loudly.
- **CI:** GitHub Actions — lint, typecheck, unit, integration on every PR.
- **Later:** headless tmux layout tests with a mock agent, panel snapshots (`ink-testing-library`), behaviour evals for skills (check Claude Code's plugin eval runner first), once the UI settles and dogfooding shows which behaviours drift.
- **Dogfooding:** once discuss → plan → build works, the rest of hece is built with hece; friction becomes issues.

## 13. Spike evidence (2026-10-17, throwaway)

Run by a Sonnet subagent, reviewed by the orchestrator, tried by the user with real Claude Code 2.1.302 (Haiku 5.5):

| Check | Result |
|---|---|
| Agent → panel (MCP tool updates Flow panel) | Pass, real Claude, ~0.2 s |
| Panel → agent (`send-keys` into the middle pane) | Pass, real Claude |
| Live activity via hooks | Pass, real Claude |
| Side chat via `--resume --fork-session` + `swap-pane` | Pass on mechanism (new session id, history visible); not yet tried by the user |
| Resize keeps side panels usable | Pass after `client-resized` hook |
| Channels push | Notification emitted correctly; not verified against real Claude |

Lessons carried into this spec: panel actions must be structured events (D7); delegated work needs orchestrator review (the worker had auto-accepted trust dialogs, removed on review).

## 14. Risks and open questions

- **Channels are a research preview.** Keys transport is the guaranteed path; its edge cases (busy agent, non-empty input) are handled by queueing.
- **superpowers coupling.** hece overlays superpowers skills ("stop after each task"). `subagent-driven-development` is designed to run tasks continuously; the overlay must reliably make it pause. Verify early in the build; pin a superpowers version range.
- **Typed-approval detection** by keywords may misfire; the native picker and panel keys are the primary approval paths.
- **Worker quality on cheap models.** Mitigated by orchestrator review per slice and the final review.
- **Other vendors' hook support** determines whether their guards are hard or soft.
- **tmux dependency** (and no native Windows).
- **npm package name** `hece` availability — check before publishing.
- **License:** MIT proposed (matches superpowers).
