# rex

A command-line tool for the **Retail Express POS REST API (v2.1)**, built for agentic workflows.
`rex` lets an AI agent — or you — read and (carefully) write the Retail Express catalogue: products,
inventory, pricing, suppliers, outlets, customers, orders, purchase orders, transfers, and loyalty.

It is **agent-first**: JSON by default, non-interactive, file-based inputs, and strong write guardrails.

> Status: early development. The core spine (auth, client, products) lands first; the remaining
> resources follow the same pattern.

## Why a CLI

A CLI composes trivially from a Claude Code skill (`Bash(rex:*)`), pipes to `jq`, and needs no running
server. The one wrinkle — each invocation is a fresh process, so the 60-minute Retail Express bearer
token is cached to disk between calls — is handled for you.

## Install

```bash
# from source (requires Bun)
bun install
bun run compile        # produces a standalone ./rex binary
cp rex ~/.local/bin/rex

# or run directly during development
bun run dev -- product list
```

## Quick start

```bash
rex auth login --profile show-go     # stores the API key in ~/.config/rex/config.toml (0600)
rex auth test                        # verifies the key + token round-trip
rex product list --page-size 5       # JSON to stdout
rex product get 4711 --human         # pretty table for eyeballing
```

## Command grammar

```
rex <resource> <action> [args] [flags]
rex product list | get <id> | search <q> | create | update | disable <id>
rex inventory list ...
rex auth login | test | whoami | list | default
rex config init | path | show
rex api <METHOD> <path> [--data ...]      # raw passthrough for un-wrapped endpoints
```

Global flags: `--json` (default) / `--human`, `--profile`, `--dry-run`, `--allow-price`,
`--page` / `--page-size` / `--all`, `--verbose`.

## Output

- **JSON by default** to stdout. Lists return `{ "nodes": [...], "pageInfo": { ... } }`; `--all`
  streams NDJSON. Single records return the object.
- Errors go to **stderr** as `{ "error": { "code", "message", "details" } }` with a stable exit code
  (0 ok · 2 usage · 3 auth · 4 ratelimit · 5 notfound · 6 validation · 7 api · 8 write-gated).
- `--human` renders tables instead.

## Writing safely

`rex` mutates a **live** retail system (changes propagate to POS and the Shopify connector), so writes
are deliberately cautious:

- **Partial updates only.** `update` re-fetches the current record, diffs it, and sends only the fields
  that actually changed.
- **`--dry-run` on every write** prints the diff and sends nothing.
- **Price changes are gated** behind `--allow-price` — descriptive fields write freely, pricing does not.
- **Soft-disable, not delete.** `rex product disable <id>` maps to the API's soft-disable; there is no
  hard delete.
- Every write is appended (before → after) to a local JSONL **audit log** under
  `~/.local/state/rex/`.

## Configuration

```toml
# ~/.config/rex/config.toml   (chmod 600)
default_profile = "show-go"

[profiles.show-go]
api_key = "..."
base_url = "https://api.retailexpress.com.au"
version = "v2.1"
```

A per-project `./.rex.toml` can pin which profile to use. Resolution order:
`--profile` flag → `REX_API_KEY` / `REX_PROFILE` env → `.rex.toml` (cwd and parents) →
`default_profile`.

## License

MIT © Ben Merritt
