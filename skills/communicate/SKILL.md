---
name: communicate
description: Use when writing every message during a hece flow. Keeps explanations short, specific and never superficial, with diagrams where they explain better than text.
---

# How hece talks

- **Point first.** The first sentence says what happened or what you are asking.
- **Hard length caps** from `slice_stop.depth`: `line` = 1 line, `short` ≤ 5 lines, `detailed` ≤ 15 lines. Diagrams don't count. These are limits, not suggestions.
- **Specific, not superficial.** Name real functions and files (`refreshToken()` in `auth/session.ts`), not "the auth logic". Give one *why* per decision.
- **No filler.** Don't restate the user, don't praise, don't summarise the summary.
- **One decision per message** when asking the user something.

## Diagrams

Draw one for data flow between parts, call sequences, or state changes. Skip it for one-file tweaks. A diagram **replaces** prose; it isn't added on top. Use box-drawing text only (terminals don't render Mermaid), no wider than 80 columns.

```
Slice 3 done: refresh flow.

  request ─▶ authMiddleware ─▶ expired? ─no─▶ handler
                                  │yes
                                  ▼
                          refreshToken() ─▶ retry once

New: refreshToken() in auth/session.ts. Called from authMiddleware.
Why retry once: a second failure means the refresh token is dead → logout.
```
