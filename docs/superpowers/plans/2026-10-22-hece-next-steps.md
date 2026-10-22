# hece: next steps (handoff)

> **For the next agent:** this is the starting point. It summarises where hece stands on 2026-10-22, every known open issue, the plans that come next, and how the user likes to work. Read it first, then the spec (`docs/superpowers/specs/2026-10-18-hece-design.md`). Don't redo finished work.

---

## 1. Where hece stands

**Repo:** https://github.com/harungokcegoz/hece (public, MIT). Local checkout: `/Users/harungokcegoz/Documents/repos/hece-cli`. `main` is at `6bf4ae0`.

| Done | What it is | Where |
|---|---|---|
| v0.1 plan 1: core engine | State files, flow model, preferences, the two guards, `hece hook`, `hece mcp`, `hece status`, six skills on top of superpowers, the Claude Code plugin at the repo root | plan `docs/superpowers/plans/2026-10-18-hece-core-engine.md`, smoke `docs/notes/2026-10-18-smoke.md` |
| `hece` launch command | `hece` runs Claude Code with hece loaded; claude args pass through; installed with `npm link` | `src/launch/main.ts` |
| Portable skill | Brand-neutral `staying-in-the-loop` skill for any chat or agent app (soft guards) | `portable/staying-in-the-loop/SKILL.md` |
| v0.1 plan 2a: the window | `hece` opens a tmux window with Activity (plain language), Claude, and Flow. It re-fits the layout on attach and resize, reattaches instead of starting a second Claude, and falls back to plain mode when needed | plan `docs/superpowers/plans/2026-10-20-hece-frame-mvp.md`, smoke `docs/notes/2026-10-20-frame-smoke.md` |

**Status:** 355 tests pass and typecheck and build are clean. CI on Ubuntu and macOS was queued on the merge commit; check that it went green.

**Spec amendments made along the way:**
- **D9:** Activity speaks plain language. It combines agent intent from `activity_note` with rule-based action lines.
- **D10:** the MVP panels are plain ANSI; Ink comes in with interactive panels.

## 2. Work lives in GitHub issues

The backlog and the next plans are tracked as **issues** in the agreed structure (see `CONTRIBUTING.md` → *Working from issues*). Each issue is one PR-sized chunk an agent can take cold. Don't duplicate the backlog here. Update the issues instead.

| Milestone | Issues |
|---|---|
| [Verify v0.1](https://github.com/harungokcegoz/hece/milestone/1) | #3 live feature in the window · #4 real picker capture + agent-supplied answers |
| [Backlog](https://github.com/harungokcegoz/hece/milestone/2): P1 Activity | #5 `$((x<<y))` hides commands · #6 redirect edge cases · #7 secrets in Grep/Glob |
| Backlog: P1 window | #10 node upgrade breaks open windows · #11 untagged pane after SIGKILL |
| Backlog: P2 | #8 dry runs · #9 "Now:" only on newest · #12 lock takeover · #13 reattach messages · #14 home note · #15–#18 panels · #19–#27 core |
| [Plan 2b](https://github.com/harungokcegoz/hece/milestone/3) | #28 approvals ignore side chats (prerequisite) · #29 epic: interactive panels |
| [Plan 3](https://github.com/harungokcegoz/hece/milestone/4) | #30 epic: onboarding (setup, prefs, doctor) |
| [Plan 4](https://github.com/harungokcegoz/hece/milestone/5) | #31 no-build plugin install · #32 npm publish · #33 epic: adapters |

**Suggested order:**
1. #3 and #4 (verify);
2. the P1 backlog;
3. #28 and then epic #29;
4. #31;
5. epics #30 and #33.

The user decides.

**How to take an issue:** read it, comment "taking this", branch `issue-<n>-<slug>`, work test-first, and open a PR with `Closes #<n>` that includes test evidence and rulings. The user approves every push and merge.

**Epics** (#29, #30, #33) start with superpowers brainstorming with the user, one question at a time. Then come a spec amendment and a plan, and then the epic is split into `agent-ready` child issues.

## 3. How the user works (keep these)

- **Process:** superpowers flow. Brainstorm one question at a time, then spec, then plan, then subagent-driven execution:
  - **Sonnet** implementers, each followed by a per-task Sonnet review;
  - fix rounds go back to the same implementer;
  - an **Opus** final whole-branch review, then one fix wave, then an Opus re-review.
- **Stop after every task** and explain it hece-style: point first, a small diagram, real file and function names, one *why*, and a skippable check question. Then wait for "continue".
- **Ask before anything outward-facing:** every `git push`, every GitHub change, publishing.
- **Commits:** never add a `Co-Authored-By` trailer or any AI attribution (the user's global CLAUDE.md). The repo-local git config uses the no-reply email `94520965+harungokcegoz@users.noreply.github.com`. Keep it that way.
- **Privacy:** check every screenshot and fixture for personal info (home path, account plan, email) **before** committing, and show the user first.
- **Wording:** don't call users "junior". Write for every experience level.
- **Rulings:** record the decisions you make for the user, and list them when you finish.

## 4. Environment notes

- macOS, Node 25, tmux 3.8 (Homebrew). `hece` is linked globally with `npm link` to the repo, so run `npm run build` after changes.
- Demo project: `/tmp/hece-demo` (a git repo; `rm -rf .hece` resets it).
- Local branch `backup/pre-email-rewrite` holds the old history with the user's Gmail. **Never push it.** The user may delete it.
- `spike/` is git-ignored throwaway prototype code.
