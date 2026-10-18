# Claude Code hook payload fixtures

Every file here except the two `PostToolUse-AskUserQuestion*.json` files was captured from real
Claude Code (`HECE_CAPTURE=1`, Claude Code 2.1.x, 2026-10-19). The home directory is replaced by `~`.

The two picker fixtures were constructed from the structured AskUserQuestion result Claude Code
records (`{ questions, answers }`), because an interactive capture wasn't possible.
Replace them with a real capture when convenient: run `HECE_CAPTURE=1 claude --plugin-dir <repo>`
and answer a picker.
