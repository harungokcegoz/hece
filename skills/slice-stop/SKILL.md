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
7. Offer the choices with the native picker (AskUserQuestion): `Continue`, `Ask about this`, `Side chat`, `Redo`. The first option's label must be exactly `Continue`, because that's how hece records the approval. The picker's answer is recorded by hece. Continue only after you receive `hece: the user approved slice N`. If the user picked Continue but no such line arrives, ask them to type `continue`.

Then stop. Make no edits until hece reports approval.

- **Ask about this:** answer in at most 5 lines, then offer the same choices again.
- **Side chat:** tell the user to open a side chat with `claude --resume <session id> --fork-session` in another terminal (the id is in `flow_get` under `sessions`). The main chat stays focused.
- **Redo:** needs the user. When they pick `Redo` or type `redo`, hece replies `hece: the user asked to redo slice N`. Then ask what to change in one question, call `flow_start_slice(N)` again, and stop again at the end.
