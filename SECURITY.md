# Security policy

hece runs as a hook on every tool call your coding agent makes, and its guards are part of its promise. A guard bypass counts as a security issue.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through GitHub's [private vulnerability reporting](https://github.com/harungokcegoz/hece/security/advisories/new).

Include what you did, what you expected, and what happened. A minimal reproduction is ideal, for example a hook payload or a sequence of MCP tool calls.

## Scope

- In scope: ways for the agent to edit files while guards should block it, to approve its own plan or slice, to change hece's state or preferences through the guarded edit tools, or to make the hook break the agent.
- Out of scope: edits through Bash or other tools that aren't guarded. The guards are a tripwire, not a sandbox, by design.
