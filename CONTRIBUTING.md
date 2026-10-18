# Contributing to hece

Thanks for your interest! hece is early, so issues, ideas and pull requests all help.

## Development setup

You need Node.js **22.12 or newer** for development (the test runner requires it). Using hece only needs Node 20+.

```bash
git clone https://github.com/harungokcegoz/hece.git
cd hece
npm install
npm test          # vitest
npm run typecheck
npm run build     # tsc → dist/
```

To try your changes in Claude Code:

```bash
npm run build
cd /some/test/project
claude --plugin-dir /path/to/hece
```

## Project layout

```
src/state      atomic JSON state under .hece/state/
src/flow       pure flow transitions + text renderer
src/prefs      preferences: presets, merge, validation
src/guards     the two guards + human-approval detection
src/hooks      `hece hook`: Claude Code hook handler
src/mcp        `hece mcp`: MCP server for the agent
src/status     `hece status`
skills/        markdown skills the agent follows
.claude-plugin/, hooks/, .mcp.json   Claude Code plugin wiring
adapters/      other agents (planned)
docs/superpowers/   design spec and implementation plans
```

## Ground rules

- **Prompts ask, code enforces.** Anything that would break the user's trust if it failed belongs in code, with a test. That covers skipping a stop, self-approval and silent failure.
- **The hook must never break the agent.** It always exits 0 and writes nothing in projects without a hece flow.
- **Fail visibly.** Log and show problems; never swallow them silently.
- **Test first.** Write the failing test, then the code. Bug fixes need a regression test.
- **Small pull requests.** One concern per PR, in the spirit of the tool.

## Hook payload fixtures

`test/fixtures/claude-code/` holds real Claude Code hook payloads, so a Claude Code update that changes their shape fails a test. To capture new ones:

```bash
HECE_CAPTURE=1 claude --plugin-dir /path/to/hece
# payloads land in .hece/state/captures/ (the home directory is replaced by ~)
```

Check every captured file for personal data before committing it.

## Commits and pull requests

- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`).
- Run `npm test && npm run typecheck && npm run build` before opening a PR.
- Describe *why* the change is needed, not only what changed.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
