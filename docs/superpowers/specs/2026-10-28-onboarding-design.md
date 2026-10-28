# Onboarding: `hece setup`, `hece prefs`, `hece doctor` (epic #30)

Amends the main spec §8 (`2026-10-18-hece-design.md`). Where the two disagree, this document wins.

## Why

New users should be able to see what hece does and choose their settings without editing YAML. The settings must apply to **every session in every repo**, so the wizard writes the global preferences file. The user specifically wants to be asked about **guards**, **skills**, and **models and effort, chosen according to their vendor**.

## Goals

- `hece setup`: a plain terminal wizard, one choice per screen. It writes `~/.config/hece/preferences.yaml` (or `$XDG_CONFIG_HOME/hece/…`). This is the file `prefsFiles().global` already resolves, and every repo already reads it.
- `hece prefs`: reopens a single screen and saves only that answer.
- `hece doctor`: checks the install and prints a fix for each problem.
- First run: `hece` with no global file starts the wizard automatically.
- Works over SSH from a phone.

## Non-goals

- Per-repo setup in the wizard. The project file `.hece/preferences.yaml` still works, but it's edited by hand.
- LLM-driven onboarding (main spec D8).
- Installing plugins for the user. The wizard and doctor print the install command; the user runs it.
- Launching Codex, Gemini or OpenCode. Their adapters are still "planned".

## Anti-goals (a failure even if it works)

- The wizard overwrites hand-edited keys the user didn't touch.
- The global file freezes every default, so later improvements to hece's defaults never reach the user.
- The wizard nags on every launch, or blocks scripts and non-TTY runs.
- It's unusable on a narrow phone screen, or where arrow keys don't come through.

## Screens (`hece setup`)

One choice per screen. Up/Down or number keys pick an option, Enter confirms, `b` goes back, and Esc exits with nothing saved (first run: see below). Each screen fits in 40 columns with labels of 30 characters or less, and long text wraps using `displayWidth` from `src/panels/`.

1. **What hece is.** Three lines, then Enter.
2. **Agent (vendor).** Lists claude / codex / gemini / opencode with ✓/✗ for whether each is on PATH. Only claude can be picked; the others show "not supported yet" (see Decisions).
3. **Preset.** involved / learning / custom, each with a small rendered example of a slice stop at that preset's depth.
4. **Custom only:** one screen for each of discussion.first, discussion.pushback, plan.slice_size, slice_stop.depth, check_questions, side_chats.open_in, review.final, review.show_minor and flow_recap. Each shows the options and a one-line example.
5. **Skills.** The optimisation pack (`optimize`: ponytail / caveman), with one line on what each does. The screen also shows whether superpowers and the chosen pack are installed, and prints the install command for anything missing. hece needs superpowers, so there's nothing to choose for it.
6. **Models and effort.** Three screens: orchestrator, build, review. Each asks for a model, then an effort. The model and effort lists come from the vendor table (below) for the agent chosen on screen 2. On the orchestrator screens the first option is "Claude Code's own setting" (`default`).
7. **Guards.** Two switches, each with a one-line note on what turning it off gives up:
   - `guards.stops`: blocks code edits during discussion, before a plan is approved, and while a slice waits for the user.
   - `guards.files`: blocks the agent from editing `.hece/` and hece's config dir.
8. **Layout.** The left and right widgets.
9. **Summary.** Shows the exact YAML that will be written and its path. Enter saves, `b` goes back.
10. **Doctor.** Runs the same checks as `hece doctor` and shows the result. It never blocks saving.

## Vendor table

A single table in code, keyed by agent, lists the allowed models and effort levels. The wizard reads it, and the prefs validator also reads it so that effort values are checked against the chosen agent.

- **claude:** models `opus`, `sonnet`, `haiku`, `fable` (aliases that `claude --model` accepts); effort `low | medium | high | xhigh | max` (from `claude --help`).
- **codex / gemini / opencode:** filled in when their adapters land. Until then they can't be selected.

## Preference changes

- **New group `effort`:** `{ orchestrator, build, review }`. Defaults: `default`, `medium`, `high`. Validated against the vendor table for `agent`; `orchestrator` also accepts `default`.
- **`delegate.orchestrator` default changes from `opus` to `default`** (agreed): hece doesn't override the user's Claude Code model unless they pick one.
- **`guards` becomes a group:** `{ stops: on|off, files: on|off }`. The old `guards: on|off` still loads and sets both (no migration needed). Every reader of `prefs.guards` (`decideTool`, `renderFlow` callers in hooks, MCP, status and panels) moves to the right field: stops logic uses `guards.stops`, the `.hece`/config check uses `guards.files`, and the status line shows `guards: on`, `off` or `partial`.
- **Review model:** the wizard's review screen writes `review.reviewer_model`, the key the review skill reads. `delegate.review` is not read anywhere today; leave it.
- **Orchestrator model and effort take effect** (agreed): `claudeArgs` adds `--model <delegate.orchestrator>` only when it isn't `default`, and the same for `--effort <effort.orchestrator>`. If the user passed their own `--model` / `--effort` on the command line, that wins. With no prefs file, launch is unchanged from today.
- **Build effort:** in the flow skill's before-build picker, the effort question puts `effort.build` first, the same way the model question puts `delegate.build` first.
- **Review effort (my call):** `skills/review-findings/SKILL.md` passes `effort.review` to the reviewer dispatch, next to `review.reviewer_model`. No setting is stored without something reading it.

## Saving

- **Presets own their settings** (agreed). Picking `involved` or `learning` removes the custom-only keys (discussion, plan, slice_stop, check_questions, side_chats, review.final, review.show_minor, flow_recap) from the file, so the preset fully applies. In `hece prefs`, changing one of those keys while the preset isn't `custom` switches `preset` to `custom` and fills in the other custom-only keys from the old preset's values, so nothing else changes.
- The wizard writes only the keys that differ from `presetDefaults(preset)`, plus `preset` itself.
- Other keys already in the file that the wizard didn't show (e.g. hand-edited ones) are kept unchanged. `hece prefs` changes only the one key it edits.
- The file is written atomically (temp file + rename, the same as state files). Comments in an existing file may be lost; the summary screen says so if the file already had comments.
- If the existing file has errors, the wizard starts from defaults, lists the errors on screen 1, and keeps unknown keys as they are.

## `hece prefs`

`hece prefs` shows a list of the screens (Agent, Preset, Skills, Models, Guards, Layout, plus the custom-only screens). Pick one, change it, and it saves right away. `hece prefs <name>` jumps straight to that screen.

## `hece doctor`

Prints one line per check (`✓`, or `✗` plus a fix):

- Node ≥ 20
- tmux on PATH (✗ means no panels, not an error)
- `dist/cli.js` built
- `claude` on PATH
- superpowers installed (`superpowers@…` key in `~/.claude/plugins/installed_plugins.json`)
- the `optimize` pack installed (`ponytail@…` / `caveman@…` there)
- preferences load with no errors (both files)
- hece's plugin wiring: the hooks and MCP declarations in the package root exist and point at a built CLI

Exits 1 if anything other than tmux failed. Does not use the network.

`doctor` is currently in `CLAUDE_SUBCOMMANDS` (`src/frame/main.ts`), so `hece doctor` passes through to `claude doctor`. hece's own doctor takes that name (my call). Its last line says `Claude Code's own check: claude doctor`.

## First run

`hece` and `hece --no-frame` run the wizard before launching only when stdin and stdout are both TTYs and the global file doesn't exist. Esc on first run writes `preset: involved`, so the wizard doesn't come back, and prints "Defaults saved. Change them any time with `hece prefs`." `hece status`, hooks, MCP and non-TTY runs never start the wizard.

## Decisions

- **No Ink (my call).** The spec named Ink, but hece's panels already draw plain ANSI with their own width helpers, and Ink would add React and Ink as dependencies. The wizard uses `readline.emitKeypressEvents` + raw mode, with the existing `color` / `displayWidth` helpers.
- **Non-Claude agents can't be picked yet (my call).** No adapter exists, and `agent` is not read anywhere today, so choosing Codex would silently do nothing.
- **Number keys as well as arrows** (agreed): some mobile SSH apps drop arrow keys.
- **Guards split in two** (agreed).
- **First run starts the wizard automatically, and Esc skips it** (agreed). This closes the open question in #30.

## Left to the builder

- The exact wording of each screen and example. It must follow hece:communicate (short, plain).
- The module layout under `src/` (e.g. `src/setup/`, `src/doctor/`), and how the screens are tested (pure render functions plus a key-sequence driver are enough).
- How to detect "file had comments" (a simple `#` scan is fine).
