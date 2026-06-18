---
name: rex-cli
description: Manage a Retail Express POS backend (products, inventory, pricing, customers, orders, suppliers, purchase orders, transfers, loyalty) from the command line using the `rex` CLI. Use for catalogue enrichment, pricing/promotions, inventory and order lookups, and product lifecycle in agentic workflows.
allowed-tools: Bash(rex:*), Bash(jq:*)
---

# rex — Retail Express CLI

`rex` wraps the Retail Express POS REST API (v2.1). It is **agent-first**: JSON by
default, non-interactive, file-based inputs, and strong write guardrails.

## Output contract (read this first)

- **stdout is JSON by default.** Lists are `{ "nodes": [...], "pageInfo": { "page", "pageSize", "total" } }`; single records are the object; mutations are `{ "action", "id", "changed":[...], "dryRun":bool }`.
- **Errors go to stderr** as `{ "error": { "code", "message", "details" } }` with a stable **exit code**: `0` ok · `2` usage · `3` auth · `4` ratelimit · `5` notfound · `6` validation · `7` api · `8` write-gated. Branch on the exit code.
- Pipe to `jq`: `rex product list --page-size 5 | jq '.nodes[].id'`.
- Add `--human` only when a person is reading; never parse `--human` output.

## Auth

A profile = one Retail Express account. Either:
- export `REX_API_KEY=<key>` (and optional `REX_PROFILE`), or
- `rex auth login <name> --key <key>` (stored 0600 in `~/.config/rex/config.toml`).

Verify with `rex auth test` (→ `{ok:true, outlets:N}`). Select a profile with
`--profile <name>` or a per-project `.rex.toml`.

## Command grammar

```
rex <resource> <action> [args] [flags]
rex product list | get <id> | search <q> | create | update | disable <id>
rex inventory list        # SOH/available per outlet (list-only)
rex order list --include items,fulfilments,payments
rex api <METHOD> <path>   # raw passthrough for anything un-wrapped
```

Resources: `product` (`p`), `inventory` (`inv`), `customer` (`c`), `order` (`o`),
`supplier` (`sup`), `outlet`, `product-type` (`pt`), `attribute` (`attr`),
`barcode`, `purchase-order` (`po`), `transfer` (`xfer`), `loyalty-reason`,
`loyalty-history`, `stock-reason`.

## Reading

```bash
rex product get 124001                          # one product
rex product list --search "weber" --page-size 50
rex product list --filter product_type=Widgets  # filter_by passthrough
rex product list --all > all-products.ndjson     # every page, NDJSON stream
rex inventory list --filter product_id=124001
```

`--page`/`--page-size` (max 250) for one page; `--all` streams **NDJSON** (one
object per line) across all pages — best-effort, not a consistent snapshot.

## Writing (do this carefully — it's a LIVE retail system)

Writes propagate to POS and the Shopify connector. Always:

1. **Dry-run first.** Every write supports `--dry-run`, which prints the diff and sends nothing:
   ```bash
   rex product update 124001 --set short_description="Weber Q2200 - Titanium" --dry-run
   ```
2. **Partial updates only.** `update` re-fetches the product and sends ONLY changed fields. A no-op sends nothing.
3. **Price changes are gated.** Writing `sell_price_inc`, `web_price_inc`, `price_groups`, etc. requires `--allow-price` (else exit 8). Descriptive fields write freely.
4. **Soft-disable, never delete.** `rex product disable <id>` hides a product; there is no hard delete.
5. Every applied write is appended to the audit log at `~/.local/state/rex/audit.jsonl`.

### Batch enrichment (the core loop)

Write a JSON array of `{id, ...only the fields to change}` and apply it:

```bash
cat > /tmp/changes.json <<'EOF'
[ {"id":124001,"short_description":"Weber Q2200 - Titanium","brand":"Weber"},
  {"id":124002,"product_type":"Gas BBQs"} ]
EOF
rex product update --file /tmp/changes.json --dry-run   # preview
rex product update --file /tmp/changes.json             # apply
```

Also: `--stdin` (NDJSON) for streaming, and `<id> --set key=value` for one-offs.
Use `--description-file <path>` for long descriptions (avoids shell-escaping).

### `--set` value rules

`key=value` coerces `true/false`→bool, `null`→null, and numbers→number **only**
for known-numeric fields (so SKUs/barcodes keep leading zeros). Use
`key:=<json>` for explicit JSON (`tags:='["a","b"]'`). Price groups and
attributes are NOT addressable via `--set`.

## Escape hatch

For any endpoint not wrapped (or high-volume log streams, deliberately omitted):
```bash
rex api GET products/124001/somethingexotic
rex api POST customers --data '{"first_name":"Ada"}'
```

## Gotchas

- The token endpoint is GET (handled internally); you never manage tokens.
- `list` returns one page; use `--all` for everything. Choosing wrong is the #1 reason a result looks empty.
- Price groups are NOT a resource — manage them via `product update` price fields with `--allow-price`.
- Rate limits (300/min, 100k/day) are handled (shared budget + backoff); large `--all` sweeps just take longer.

See `references/` for the full command list and per-flag detail.
