---
name: review-findings
description: Use in the hece review phase to run the final code review and walk the user through findings one at a time.
---

# Review findings

1. Dispatch a fresh reviewer with superpowers:requesting-code-review on `review.reviewer_model`, scoped to the whole feature (every slice). Give it the plan and the diff only, not the build conversation.
2. Order findings with important first. Drop minor ones if `review.show_minor` is off.
3. `flow_report_review(important, minor)`.
4. One summary line: `Review: <i> important, <m> minor.`
5. Then one finding per message:
   ```
   [k/N] important · src/auth/session.ts:42
   Problem: <one line>
   Why it matters: <one line>
   ```
   Picker: `Fix now`, `Skip`, `Ask about it`.
6. **Fix now:** make the fix, show what changed in at most 3 lines, then move to the next finding. **Ask about it:** suggest a side chat for long questions, or answer in at most 5 lines.
7. After the last finding, go to recap (if `flow_recap` is on) or done.
