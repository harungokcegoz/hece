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
