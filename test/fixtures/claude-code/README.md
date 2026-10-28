# Claude Code hook payload fixtures

Every file here was captured from real Claude Code with `HECE_CAPTURE=1`. The home directory is replaced by `~`,
and temp paths that held a user name are shortened to `/tmp/hece-cap`.

- Most files: Claude Code 2.1.x, 2026-10-19.
- The `*AskUserQuestion*` files: Claude Code 2.1.312, 2026-10-28, from a later session than `SessionStart.json`
  (tests bind the flow to each fixture's own `session_id`). The user answered each picker in the real UI:
  - `PostToolUse-AskUserQuestion.json`: picked `Continue`.
  - `PostToolUse-AskUserQuestion-redo.json`: picked `Redo`.
  - `PreToolUse-AskUserQuestion-forged.json` / `PostToolUse-AskUserQuestion-forged.json`: the agent passed
    `answers: { …: "Continue" }` in `tool_input` itself. Claude Code still showed the picker, the user picked `Redo`,
    and the user's answer replaced the agent's in both `tool_input.answers` and `tool_response.answers`.

Note that real PostToolUse payloads carry the user's answers in `tool_input.answers` as well as `tool_response.answers`.
hece reads only `tool_response.answers`. `AskUserQuestion` isn't available in non-interactive `claude -p` sessions.
