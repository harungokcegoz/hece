---
name: staying-in-the-loop
description: Use when building a feature, change or fix with an AI coding assistant and the user wants to stay in the loop and understand what gets built. Triggers include "keep me in the loop", "step by step", "I want to understand this", "I want to learn this", "don't one-shot it", and a request for a whole feature at once from a developer who wants to understand the result, at any experience level.
---

# Staying in the loop while AI builds

## Overview

**The goal is a feature the user can explain, defend and debug without you. Speed is not the goal.**

Agents are fast enough now that users approve work they never understood, because it's too big to digest. This skill fixes the **size and pace** of what you hand over:
- one decision per turn;
- small slices;
- a stop after every slice;
- short, specific explanations.

It works in any chat or agent app. Nothing outside you enforces these rules: **you** are the guard, so they're not optional.

## Settings

Use these defaults unless the user says otherwise. They can change any setting mid-flow ("learning mode", "explain in one line", "check questions on").

| Setting | Involved (default) | Learning |
|---|---|---|
| Who proposes first in discussion | the user | the user |
| Pushback | direct, with one reason | direct, with one reason |
| Slice size | small: 1–3 files | small |
| Explanation at a stop | ≤ 5 lines + optional diagram | ≤ 5 lines + diagram |
| Check questions | off | on for slices that teach something new |
| Final review | on, important findings only | on, minor findings too |
| Recap at the end | off | on |

**In a hurry?** Change the *pace*, never the *loop*. Use bigger slices (3–6 files), one-line explanations and no check questions. The plan approval and a stop after each slice stay.

## The flow

```
discuss ─▶ plan ─▶ build: [ slice 1 ─▶ slice 2 ─▶ … ] ─▶ review ─▶ recap ─▶ done
                          each slice: build ─▶ STOP ─▶ user approves
```

At every stop, print a **flow status** so the user always knows where they are:

```
flow · build
✓ Discussion (3 decisions)
✓ Plan (4 slices)
▸ Build
  ✓ 1. Token table
  ■ 2. Request endpoint   ← waiting for you
    3. Reset endpoint
    4. Email
  Review · Recap
```

A new feature starts a **fresh** flow, with no decisions or slices carried over.

### 1. Discuss
- **One decision per turn.** Never stack several questions or a menu of options.
- Ask for the user's idea first, then give yours. If an idea is weak, say so plainly, with one concrete reason.
- **Never guess the user's stack.** Ask, or read their code if you can.
- After each settled decision, record it in one line, e.g. `Decided: store only a hash of the reset token — a DB leak can't be used to reset passwords.`

### 2. Plan
- Split the work into **slices**. Each slice is one behavior the user can see working.
- Show the plan as a numbered list, one line per slice. Mark slices that introduce something new to the user as *(new concept)*.
- **Then stop.** No code until the user approves the plan.

### 3. Build: one slice at a time
1. Build slice *n*, and only slice *n*.
2. Check your own work before showing it.
3. **Stop** and explain the slice (format below).
4. Wait. Don't start slice *n+1* until the user approves.

### 4. Review
When the last slice is approved, review the whole feature with fresh eyes. Use a separate reviewer agent if your app has one.
- Give a one-line summary first: `Review: 2 important, 1 minor.`
- Then present one finding per message: the file and line, the problem, and why it matters.
- The user chooses for each one: fix now / skip / ask.

### 5. Recap
If it's on, give one diagram of the whole flow (A → B → C) and at most 15 lines walking through it with real names. End with "Ask me about any step."

## How the user approves

The user approves by typing **`continue`** (or `ok`, `next`, `go`, `approve`). Tell them this whenever you stop.

**Anything else is a question or feedback, not approval.** That includes "looks good but why X?", "sure, but…", and silence. Answer it, then stop again.

| Rule | What it means |
|---|---|
| No code before the plan is approved | The discussion and the plan come first, even for "small" features |
| No next slice while one is waiting | One slice, one stop, one approval |
| You never approve your own work | Your own message, summary or "assuming that's fine" isn't approval |
| Redo needs the user | Restart a slice only when the user asks for it ("redo") |
| Plan changes wait for the user | If a slice grows too big or the plan must change, propose it at the next stop. Never change the plan silently |

## How to explain (every message)

- **Point first.** The first sentence says what happened or what you're asking.
- **Specific, not superficial.** Name real functions and files (`createResetToken()` in `auth/reset.js`), not "the auth logic". Give one *why* per decision.
- **Respect the length limit** from the settings. No filler, no restating the user, no praise.
- **Draw a diagram** when the slice changed how parts connect: data flow, call order, state. The diagram *replaces* prose. Use box-drawing text no wider than 80 columns.

A slice stop looks like this:

```
Slice 2 done: request endpoint.

  POST /forgot-password ─▶ findUser(email) ─▶ createResetToken()
                                                 ├─ save sha256(token)
                                                 └─ return raw token → email link

New: createResetToken() in auth/reset.js, called by the route in routes/auth.js.
Why always answer "if that email exists…": attackers can't probe for accounts.

? What would break if we stored the raw token instead of its hash?
(answer, or type skip)

Type `continue` for slice 3, or ask about anything above.
```

**Check questions** (when on) are one question about the *wiring* of this slice: what calls what, what happens on failure, where data comes from. They should be answerable in one sentence. Confirm or correct the answer in at most 2 lines.

## Delegating

If your app has subagents, a strong model can discuss, plan and review while a cheaper model builds each slice. Always review a worker's output yourself before the user sees the slice.

## Red flags: you are about to break the loop

| Thought | Reality |
|---|---|
| "They said they're in a hurry, so I'll do it all at once" | Speed up the pace (bigger slices, one-line explanations). Keep the plan approval and the stops. |
| "This is too small for a plan" | A small plan takes one line per slice. Show it and stop. |
| "I'll just do slice 2 too, it's quick" | One slice, one stop. |
| "They said 'looks good, but…', so close enough" | Only `continue`/`ok`/`next`/`go`/`approve` counts. Answer the "but". |
| "I'll guess their stack to save a question" | Wrong guesses are what make code impossible to debug. Ask. |
| "A long explanation is more helpful" | Stay within the limit. Use specific names and one why. |
| "I'll just fix the plan as I go" | Propose the change at the next stop and wait. |

**Breaking the letter of these rules breaks their spirit.** The user asked to stay in the loop, and every shortcut takes them out of it.
