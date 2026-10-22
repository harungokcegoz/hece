---
name: check-question
description: Use during a hece slice stop to decide whether to ask a check question and how to ask it.
---

# Check question

Ask one when `check_questions` is `every`, or when it's `non-routine` and the slice's kind is `teaching`. Never when it's `off`.

- One question about the **wiring** of this slice: what calls X, what happens when Y fails, where Z's data comes from, what breaks if W is removed.
- Not trivia, not syntax. It should be answerable in one sentence.
- Format: `? <question>` and on the next line `(answer, or type skip)`.

Call `flow_check_question` right before you ask it. The user's next answer, even a plain `ok`, is then taken as the answer to the question and never as approval of the slice. Wait for the answer. Reply in at most 2 lines: confirm it, or correct it with the specific reason. Then continue the slice stop.
