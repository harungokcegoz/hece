# OpenCode adapter (planned)

Not implemented yet. hece v0.1 supports Claude Code only.

An adapter tells hece how to:

- launch the agent with hece's MCP server (`hece mcp`);
- install hece's skills in the agent's format;
- map the agent's hook events, if it has them, to `hece hook`. Without blocking hooks, the guards are *soft*: the skills ask the agent to stop, but code can't enforce it;
- delegate slices to a cheaper model, if the agent supports subagents.

See the design spec, §10.8: [`docs/superpowers/specs/2026-10-18-hece-design.md`](../../docs/superpowers/specs/2026-10-18-hece-design.md).
Want to build it? Open an issue first so we can agree on the approach.
