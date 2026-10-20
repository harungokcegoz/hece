# hece

**Stay in the loop while AI agents build.**

*hece* is Turkish for "syllable". *Hecelemek* means to spell a word out syllable by syllable. hece does that to features: it breaks them into pieces small enough to understand, discuss and defend.

> **Status: early (v0.1).** `hece` opens one terminal window: Activity on the left, Claude Code in the middle, your flow on the right. The panels are read-only for now. See the [roadmap](#roadmap).

![The hece frame prototype: an Activity panel on the left, Claude Code in the middle, and a Flow panel on the right with Build as the current step](docs/images/frame-prototype.png)

<sub>**Early prototype from the feasibility spike.** The shipped window has the same layout. Activity and Sessions are on the left, the real Claude Code runs unchanged in the middle, and the Flow panel on the right shows the current step. Claude moved the flow to *Build* by calling hece's MCP server.</sub>

---

## Why

AI coding agents got fast and reliable enough that many of us moved from *building with them* to *watching them build*. Features ship and tests pass. Afterwards you can't answer *how did you connect A to B?*, *what is the flow?* or *why this approach?*

The cause is size and pace, not the agent's quality. Plans and explanations arrive in chunks too big to digest, so approval becomes trust instead of understanding. Over the years that turns into skill atrophy: you can describe what you want, but you can't build, debug or defend it.

hece keeps you in the loop without giving up the agent.

## What it does

- **Discussion first.** It works like talking with a senior: one decision per turn, you propose, the agent proposes, and either side pushes back with reasons.
- **Chunked plans.** Each slice is one behavior you can see working, touching about 1–3 files.
- **A stop after every slice.** The agent explains what changed and how it connects, point first, with real names and a diagram when it helps. Then it waits for you.
- **Guards** (optional, on by default). Code enforces the two rules that matter: no edits before you approve the plan or while a slice waits for you, and the agent can't approve its own work.
- **Check questions** (optional). One skippable question per slice about the wiring.
- **Review and recap** (optional). A fresh reviewer walks you through findings one at a time, then you get an A → B → C recap of the flow.
- **Delegate** (optional). A strong model discusses, plans and reviews; cheaper models build slices.

```
discuss ─▶ plan ─▶ build: [ slice 1 ─▶ slice 2 ─▶ … ] ─▶ review ─▶ recap ─▶ done
                          each slice: working ─▶ stopped ─▶ approved (by you)
```

**Prompts ask, code enforces.** Judgment and style live in markdown skills. Anything that would break your trust if it failed lives in code:

```
skills (markdown)  ── how to behave: pacing, explanations, diagrams, pushback
hece hook          ── runs on every tool call: blocks edits while you're needed,
                      records your approval ("continue" or the picker)
hece mcp           ── the agent reports progress: phases, decisions, slices
.hece/state/       ── plain files; `hece status` shows exactly what hece believes
```

## Requirements

- [Claude Code](https://claude.com/claude-code)
- The [superpowers](https://github.com/obra/superpowers) plugin. hece builds on its brainstorming, planning, subagent and review skills:
  ```
  /plugin install superpowers@claude-plugins-official
  ```
- Node.js 20 or newer
- [tmux](https://github.com/tmux/tmux) for the three-pane window (`brew install tmux` on macOS). Without it, `hece` still works, just without panels.

## Quick start

```bash
git clone https://github.com/harungokcegoz/hece.git
cd hece && npm install && npm run build && npm link
```

Then, in any project:

```bash
cd your-project
hece
```

`hece` opens the window. The **Activity** panel tells you what Claude is doing in plain words ("Now: saving only a hash of the token…", "changing src/auth/reset.ts", "running the tests"), and the **Flow** panel shows where you are. Use `hece --no-frame` for Claude Code with hece but without panels. Inside an existing tmux session, or when piping (`hece -p …`), hece runs without panels automatically.

It accepts the same arguments as `claude`, for example `hece -c` to continue your last session. Running `hece` again reattaches to the open window.

Ask Claude to build something with hece, for example *"Let's build a CLI that prints a greeting, using hece."* To see where you are, run this from your project root:

```bash
hece status
```

To approve the plan or a slice, type `continue` (or `ok`, `next`, `go`, `approve`), or pick **Continue** in the picker.

## Without the CLI: the portable skill

You don't use Claude Code, or don't want to install anything? [`portable/staying-in-the-loop/SKILL.md`](portable/staying-in-the-loop/SKILL.md) is the same approach as a single, brand-neutral skill file for any chat or agent app. It covers the discussion, small slices, a stop after every slice, how you approve, explanations with diagrams, review and recap.

- **Apps that support skills** (Claude Code, Codex, Gemini CLI and others): copy the `portable/staying-in-the-loop/` folder into your skills directory, e.g. `~/.claude/skills/` or `~/.agents/skills/`.
- **Any other app** (ChatGPT, Claude.ai projects, Cursor rules, …): paste the contents of `SKILL.md` into the custom instructions, project instructions or rules file.

Without hece's hooks, the rules are kept by the agent itself (soft guards) and not enforced by code. For hard guards, use the CLI.

## Preferences

`~/.config/hece/preferences.yaml` holds your global defaults. `.hece/preferences.yaml` in a project overrides them and can be committed to share a setup with your team.

```yaml
preset: involved            # involved | learning | custom
slice_stop: { depth: short } # line | short | detailed
check_questions: off        # off | non-routine | every
flow_recap: false
review: { final: on, reviewer_model: opus, show_minor: false }
delegate: { orchestrator: opus, build: sonnet, review: opus }
guards: on
```

A typo like `gaurds: off` is reported by name, and the safe default (guards on) stays.

## Agent support

| Agent | Status | Guards | Delegate |
|---|---|---|---|
| Claude Code | **v0.1** | hard (hooks) | subagents with a model per slice |
| Codex CLI | planned | soft unless hooks exist | decided in its adapter spec |
| Gemini CLI | planned | soft unless hooks exist | decided in its adapter spec |
| OpenCode | planned | soft unless hooks exist | decided in its adapter spec |

See [`adapters/`](adapters/). Contributions for other agents are very welcome.

## Roadmap

1. **Core engine** ✅: state, flow, preferences, guards, hook, MCP server, skills, Claude Code plugin.
2. **Frame:** ✅ the three-pane window with plain-language Activity and the live Flow (2a). Next (2b): panel keys that talk to Claude (Enter = continue), side chats, and arrow navigation.
3. **Onboarding:** `hece setup`, `hece prefs`, `hece doctor`.
4. **Release:** bundled plugin install (no build step), npm package, more agents.

The design is in [`docs/superpowers/specs/`](docs/superpowers/specs/) and the implementation plans are in [`docs/superpowers/plans/`](docs/superpowers/plans/).

## Privacy

hece sends nothing anywhere. Its state lives in `.hece/state/` inside your project, which hece adds to `.gitignore` automatically.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Harun Gökçegöz
