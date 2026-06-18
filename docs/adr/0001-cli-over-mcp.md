# CLI over MCP for the Retail Express integration

The prior research scoped this as an MCP server. We built a **CLI** instead: it
composes trivially from a Claude Code skill (`Bash(rex:*)`), pipes to `jq`, and
needs no running server. The one CLI cost — each invocation is a fresh process,
so the 60-minute bearer token must be cached to disk — is cheap to solve, and a
proven agent-CLI pattern (the user's Linear CLI) already works well with their
agents.
