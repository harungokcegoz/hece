# Smoke test: the hece window (frame MVP)

- **Date:** 2026-10-21
- **Setup:** macOS, tmux 3.8 (Homebrew), Claude Code 2.1.304, `hece` linked globally (`npm link`), demo project `/tmp/hece-demo`.

## What worked

| Check | Result |
|---|---|
| Real tmux layout, built detached and inspected | Activity 40 cols · Claude 122 cols · Flow 36 cols. Pane titles are set and every command runs. |
| `hece` in a full-screen terminal | One window with three panes. Claude runs unchanged in the middle with hece loaded, and both panels read the real state ("Nothing yet…", "No flow yet…"). |
| UTF-8 in the user's terminal | `·` and the panel glyphs render correctly. |
| Narrow terminal (the app's Terminal panel) | Side panels are dropped, so Claude keeps its width. The status bar shows the F1/F2/F3 hint. |
| Reattach | A second `hece` in the same project attached to the open window, with no second Claude. |

## Issues found

1. **The layout is fixed when a window first opens.** If a window starts in a narrow terminal (no side panels), reattaching from a wide terminal keeps the panel-less layout. Widening the terminal doesn't bring the panels back either. **Fix:** re-check the width on `client-attached` and `client-resized`, and add any missing side panels once there's room.
2. **Each pane's heading is doubled.** The pane border says "Activity" and the panel prints "Activity" again (Flow: "Flow", then "hece"). **Fix:** drop the inner heading, because the tmux border title already names the pane.
3. **Starting in the home folder.** `hece` run from `~` works, but flow state would go to `~/.hece`. **Fix:** print a one-line note when the project root is the home folder.
4. **An empty `LANG` turns glyphs into `_`.** In a shell with no locale set, tmux falls back to ASCII and `·`/✓/▸/■ become `_`. The user's terminal was fine. **Fix:** pass `-u` to tmux to force UTF-8.

## Not verified yet

- Activity filling with `Now: …` lines and plain actions, and Flow moving, during a real flow inside the window. Each panel is covered by tests (`hece panel … --once`) but hasn't been watched live.
- `/exit` in Claude closing the whole window.
