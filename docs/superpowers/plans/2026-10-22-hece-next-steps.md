# hece: next steps (handoff)

> **For the next agent:** this is the starting point. It summarises where hece stands on 2026-10-22, every known open issue, the plans that come next, and how the user likes to work. Read it first, then the spec (`docs/superpowers/specs/2026-10-18-hece-design.md`). Don't redo finished work.

---

## 1. Where hece stands

**Repo:** https://github.com/harungokcegoz/hece (public, MIT). Local checkout: `/Users/harungokcegoz/Documents/repos/hece-cli`. `main` is at `6bf4ae0`.

| Done | What it is | Where |
|---|---|---|
| v0.1 plan 1: core engine | State files, flow model, preferences, the two guards, `hece hook`, `hece mcp`, `hece status`, six skills on top of superpowers, the Claude Code plugin at the repo root | plan `docs/superpowers/plans/2026-10-18-hece-core-engine.md`, smoke `docs/notes/2026-10-18-smoke.md` |
| `hece` launch command | `hece` runs Claude Code with hece loaded; claude args pass through; installed with `npm link` | `src/launch/main.ts` |
| Portable skill | Brand-neutral `staying-in-the-loop` skill for any chat or agent app (soft guards) | `portable/staying-in-the-loop/SKILL.md` |
| v0.1 plan 2a: the window | `hece` opens a tmux window with Activity (plain language), Claude, and Flow. It re-fits the layout on attach and resize, reattaches instead of starting a second Claude, and falls back to plain mode when needed | plan `docs/superpowers/plans/2026-10-20-hece-frame-mvp.md`, smoke `docs/notes/2026-10-20-frame-smoke.md` |

**Status:** 355 tests pass and typecheck and build are clean. CI on Ubuntu and macOS was queued on the merge commit; check that it went green.

**Spec amendments made along the way:**
- **D9:** Activity speaks plain language. It combines agent intent from `activity_note` with rule-based action lines.
- **D10:** the MVP panels are plain ANSI; Ink comes in with interactive panels.

## 2. Verify first (not yet seen working)

1. **A real feature inside the window.** Run `cd <project> && hece` and go through discuss → plan → one slice. Watch Activity fill with `Now: …` lines and plain actions, watch Flow move, then check that `/exit` closes the whole window. Every part has tests, but nobody has watched it live yet.
2. **A real picker capture.** The `AskUserQuestion` PostToolUse fixtures in `test/fixtures/claude-code/` were *built* from the transcript shape, not captured from a real hook. Re-capture with `HECE_CAPTURE=1 hece --no-frame`: answer one picker with `Continue` and one with `Redo`, then replace the two fixtures. While doing it, check whether an agent-supplied `tool_input.answers` could ever reach `tool_response.answers`. If it could, that's self-approval.
3. **CI** on `6bf4ae0`.

## 3. Open issues (prioritised backlog)

### P1: truthfulness of Activity (hece's core promise: never mislead)
- `$((x<<y))` followed by a newline is read as a heredoc and **can hide a later command**, such as a force-push. Skip `<<` inside `$((…))`. (`src/activity/describe.ts`)
- `[[ a > b ]]` is shown as "writing b". Don't treat `>` inside `[[ … ]]` or `(( … ))` as a redirect.
- `>|` isn't recognised as a write, because the command is split on `|` first.
- `tee <file>` isn't reported as a write.
- `git clean -n` and `git push --dry-run` are described as if they really ran.
- Short secrets (under 24 chars) in Grep patterns are echoed, and Glob targets are echoed raw.
- Old notes all keep the "Now:" prefix, so history reads as current. Put "Now:" only on the newest note.

### P1: window robustness
- **The hook node path is pinned.** `process.execPath` (a versioned Homebrew Cellar path) is written into the hooks and panes. After `brew upgrade node`, open windows break. Resolve `node` from PATH, or use the `hece` bin.
- A SIGKILL between `split-window` and `set -p @hece_role` leaves an untagged pane that dedupe never removes. Chain `split-window … \; set -p …` in one tmux call.
- Lock edge cases in `src/frame/lock.ts`: a takeover race with 3 or more waiters on a stale lock, and a fit running longer than 10 s losing its lock by age. Dedupe repairs the result, but tighten this.
- The "already open" hint (`tmux -L … attach`) can't be run from inside tmux. Suggest `switch-client`, or prefix with `TMUX=`.
- Reattaching silently ignores new claude args. Print one line saying so.
- The home-folder note is skipped in plain mode, and may be hidden by the alternate screen.

### P2: panels
- Malformed `sessions.json` or `flow.json` shapes show raw JS error text. Validate shapes and show "<file> is unreadable".
- Width table gaps: 0x1FA70–1FAFF, 0x2600–27BF, VS16 emoji and 0x231A–23FF can overflow by one column. C1 controls aren't stripped in `fitLine`. East Asian Ambiguous glyphs take 2 columns in CJK locales.
- "Claude: waiting" stays red only at 13 columns or more. The current-line pick prefers `▸ Build` over the slice line.
- A possible last-column erase on xterm-style terminals. Keys typed into a panel pane are echoed (this resolves itself in 2b).
- The 256 KB tail read drops one valid line when it starts exactly on a line boundary.

### P2: core engine (deferred from plan 1)
- `readEvents` and `readYaml` swallow non-ENOENT errors (EACCES, EISDIR). `writeJsonAtomic` leaves a temp file behind if it throws.
- `tsconfig` doesn't typecheck `test/`.
- The prefs `RULES` lookup matches prototype keys (`constructor`). Use `Object.hasOwn`.
- `sessions.json` grows without bound.
- A lost-update race between the hook and MCP writes to `flow.json`. An approval could be lost; it's benign, because the user re-approves.
- An existing `.hece/.gitignore` without `state/` is left alone. Append the line.
- A check-question answer of `ok` or `go` is read as slice approval. A multi-question picker approves if one answer is Continue.
- `hece status` run from a subfolder doesn't walk up to find `.hece`.
- **Contributor papercut:** the repo-root `.mcp.json` is also read as a *project* MCP config when you work inside the hece repo, so the `hece` MCP server fails to connect there (`${CLAUDE_PLUGIN_ROOT}` is unset). Move the server definition into `.claude-plugin/plugin.json`.

## 4. Next plans

Each goes through brainstorming → spec amendment → writing-plans → subagent-driven development. The user decides the order. The suggested order is below.

### Plan 2b: interactive panels (spec §9, §10.5)
- **Panel keys → Claude.** Enter on a waiting slice in Flow sends the structured event `[hece] event=continue step=slice-N`. It goes over Claude Code channels when available. Otherwise it's sent as keystrokes, only when the agent is idle and the input line is empty, with a visible queue. The skills already handle `[hece] event=` lines.
- **Arrow navigation** in Flow: open a step's summary (what changed and how it connects).
- **Side chats** from a Sessions panel: `claude --resume <id> --fork-session` swapped into the middle pane, with a key to switch back. Throwaway: nothing returns to main. **Fix first:** approvals must check `session_id`, so a typed `ok` in a side chat can't approve the main flow.
- **Ink** for the interactive panels (D10).
- Fold in the P1 Activity items above.

### Plan 3: onboarding (spec §8)
- `hece setup`: a plain wizard, one thing per screen, arrow keys. It covers what hece is, picking the agent, picking a preset with a rendered example, custom settings, layout, delegate models, guards, and a summary.
- `hece prefs`: reopen any single screen.
- `hece doctor`: checks tmux, superpowers, the build, Node, and the plugin wiring.

### Plan 4: release
- **Bundling:** plugin users shouldn't need `npm run build` (`dist/` is gitignored).
- **npm publish:** the name `hece` was free on 2026-10-17. Also versioning and a CHANGELOG.
- **Adapters:** Codex CLI, Gemini CLI, OpenCode (`adapters/*/README.md` placeholders exist). Each needs a short adapter spec first.

## 5. How the user works (keep these)

- **Process:** superpowers flow. Brainstorm one question at a time, then spec, then plan, then subagent-driven execution:
  - **Sonnet** implementers, each followed by a per-task Sonnet review;
  - fix rounds go back to the same implementer;
  - an **Opus** final whole-branch review, then one fix wave, then an Opus re-review.
- **Stop after every task** and explain it hece-style: point first, a small diagram, real file and function names, one *why*, and a skippable check question. Then wait for "continue".
- **Ask before anything outward-facing:** every `git push`, every GitHub change, publishing.
- **Commits:** never add a `Co-Authored-By` trailer or any AI attribution (the user's global CLAUDE.md). The repo-local git config uses the no-reply email `94520965+harungokcegoz@users.noreply.github.com`. Keep it that way.
- **Privacy:** check every screenshot and fixture for personal info (home path, account plan, email) **before** committing, and show the user first.
- **Wording:** don't call users "junior". Write for every experience level.
- **Rulings:** record the decisions you make for the user, and list them when you finish.

## 6. Environment notes

- macOS, Node 25, tmux 3.8 (Homebrew). `hece` is linked globally with `npm link` to the repo, so run `npm run build` after changes.
- Demo project: `/tmp/hece-demo` (a git repo; `rm -rf .hece` resets it).
- Local branch `backup/pre-email-rewrite` holds the old history with the user's Gmail. **Never push it.** The user may delete it.
- `spike/` is git-ignored throwaway prototype code.
