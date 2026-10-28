# Subagent build: one-by-one or parallel

Date: 2026-10-28

## Intent

The main hece chat should only orchestrate: discuss, plan, dispatch, review, talk to the user. All code is written by subagents. This keeps the main session's context window small and cost low, so it can carry a whole feature without degrading.

Before build, the user chooses how slices run:

- **One by one** (default): each slice goes to its own subagent. The main chat reviews it and stops; the user approves before the next slice. Same loop as today, only the executor changes.
- **Parallel**: all slices go to subagents at once. When every one is done, the main chat reviews them together and sends one report for the user to approve.

Separately, every hece session uses superpowers plus one optimisation skill pack (ponytail or caveman) chosen in preferences, so subagents write less code and spend fewer tokens.

## Goals

- A new step between plan approval and the first slice: mode, model, effort.
- Subagents execute every slice in both modes; the main chat never edits code during build.
- Parallel mode: run independent slices at the same time, review them as one batch, one approval.
- Preference `optimize: ponytail | caveman`, default `ponytail`.
- README explains the new step, both modes and the preference.

## Non-goals

- Saving the mode/model/effort as preferences (asked every time).
- Git worktrees or merge tooling for parallel slices.
- Adapters for other agents (Codex, Gemini, OpenCode); the portable skill only gets a short note.

## Anti-goals

- The agent choosing parallel by itself to skip the per-slice stop. The mode is the user's answer, like an approval.
- Losing the user's understanding: parallel still ends in a review the user approves, and the main chat still explains each slice.
- Caveman-style terse output in messages to the user. The optimisation pack applies to subagents; the main chat keeps following hece:communicate.

## Constraints (existing project rules)

- Approvals and redo requests are human-only: recorded by hooks from the user's message or picker answer, never by an MCP tool.
- Hooks always exit 0 and write nothing without `.hece/state/flow.json`. Panels never write state.
- No new runtime dependencies. Test first.

## Decided by the user

1. Two modes, chosen per execution: one by one (default) and parallel.
2. Both modes execute slices in subagents; the main chat orchestrates and reviews.
3. Parallel: all slices run, then the main chat reviews everything and informs the user once.
4. Model and effort are asked in both modes.
5. `optimize` preference picks ponytail or caveman; ponytail by default.
6. README documents all of this.

## Calls made in design (the user can override)

- **Where the optimisation pack applies:** subagent prompts tell the subagent to use the chosen skill (`ponytail:ponytail` or caveman's skill). The main chat does not switch to caveman speech.
- **The packs (decided by the user: JuliusBrussee's caveman):**
  - `ponytail` → skill `ponytail:ponytail`; install `/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`.
  - `caveman` → skill `caveman:caveman`; install `/plugin marketplace add JuliusBrussee/caveman` then `/plugin install caveman@caveman`.
- **Caveman's own hooks:** the caveman plugin turns itself on at SessionStart and SubagentStart, so once installed it also affects the main chat. hece can't switch that off; the flow skill says hece:communicate wins for every message to the user, and the README says so.
- **Missing plugin:** if the chosen pack isn't installed, hece says so in one line with the install command and continues without it. Missing superpowers still stops, as today.
- **The new step:** after the user approves the plan, the orchestrator asks three questions with the picker (AskUserQuestion): mode (`One by one` first), model (first option = `delegate.build`), effort (`low | medium | high`; first option `medium`). Asked every time, not stored in preferences.
- **Recording the mode:** the mode answer is read by the PostToolUse hook from the picker's `tool_response`, the same way approvals are, and stored in flow state (`plan.mode: 'one-by-one' | 'parallel'`). There is no MCP tool to set it. If no mode was recorded, hece treats it as one by one. Model and effort are not safety-relevant and not stored: the orchestrator passes them to each subagent dispatch. (Recording them via `flow_set_plan` would reset plan approval.)
- **Shared files in parallel mode:** slices whose `files` overlap are not run at the same time. The orchestrator groups them so overlapping slices run one after another; everything else runs at once. The orchestrator computes the grouping from the plan's `files`.
- **State in parallel mode:** several slices may be `working` at once. `flow_start_slice` allows that only when `plan.mode` is `parallel`. A `stopped` slice blocks edits only in one-by-one mode; in parallel mode edits are blocked once every slice is stopped or approved (that's the batch waiting for the user). `currentSlice` stays as the most recently started slice for display.
- **Batch approval:** in parallel mode, `continue` approves every stopped slice at once (`hece: the user approved slices 1–4`).
- **Batch redo:** the user can redo specific slices by typing `redo 2 4` or picking `Redo` (then the orchestrator asks which). The hook marks those slices `redoRequested`; the orchestrator re-dispatches them to subagents and stops again when they're done. Plain `redo` with one stopped slice behaves as today.
- **"Main chat never edits code" is a skill rule, not a guard.** Hooks can't cheaply tell a subagent's edit from the main chat's, and the rule is about cost, not safety. `decideTool` doesn't change for it.
- **When slices stop in parallel mode:** the orchestrator calls `flow_finish_slice` as each subagent returns. `approve()` in parallel mode does nothing while any slice is `todo` or `working`, so a `continue` typed mid-batch can't approve half a batch; the hook says the batch is still running.
- **Redo with several slices stopped:** typed `redo 2 4` marks exactly those slices. Picking `Redo` (or plain `redo`) with one stopped slice works as today; with several stopped, the hook marks nothing and replies `hece: say which slices, e.g. redo 2 4`. No second picker to recognise.
- **Mode lifecycle:** a mode answer counts only after the plan is approved and before any slice has started, and only from a picker whose first option is exactly `One by one` (same strictness as `Continue`). `Parallel` is recorded only when the user picks it. `setPlan` carries `mode` over, so a plan change mid-build keeps it; no switching modes mid-build.
- **Panels:** the Flow panel shows each working slice; no new panel.
- **Skill changes:** `skills/flow/SKILL.md` gains the new step and both build loops; rule 4 ("dispatch exactly one slice at a time") becomes mode-dependent. `portable/staying-in-the-loop/SKILL.md` gets one line noting the parallel option as soft guidance.

## Left to the builder

- Exact wording of picker questions and context lines.
- Test layout, as long as guards, approve, redo and the hook's mode capture are each covered.
