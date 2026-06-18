---
name: rex-cli
description: Drive a Retail Express POS backend from the command line via the `rex` CLI — read and safely write products, inventory, pricing, customers, orders, suppliers, purchase orders, transfers, and loyalty. Use when the user mentions Retail Express / REX / their POS or retail backend, catalogue enrichment, product/pricing/inventory/order management, or asks to list, search, get, create, update, or disable any of those records.
allowed-tools: Bash(rex:*), Bash(jq:*)
---

# rex — Retail Express CLI

`rex` is an agent-first CLI over the Retail Express REST API: JSON by default,
non-interactive, with strong write guardrails. Stocktake submit uses the legacy
Retail Express WMS SOAP API because REST does not expose stocktake creation. If
`rex` isn't on PATH, build it from this repo root:
`bun install && bun run compile && cp rex ~/.local/bin/rex`.

## Output contract (read first)

- **stdout is JSON.** Lists → `{ "nodes": [...], "pageInfo": {page,pageSize,total} }`; single records → the object; writes → `{ action, id, changed, dryRun }`.
- **Errors → stderr** as `{ "error": {code,message,details} }` with a stable **exit code**: `0` ok · `2` usage · `3` auth · `4` ratelimit · `5` notfound · `6` validation · `7` api · `8` write-gated. Branch on it.
- Pipe to `jq`. Use `--human` only when a person reads the output; never parse it.

## Auth

`export REX_API_KEY=<key>` (or `rex auth login <name> --key <key>`), then verify
with `rex auth test` → `{ok:true, outlets:N}`. Pick a tenant with `--profile`.

## Commands

`rex <resource> <action> [args] [flags]`. Resources: `product` (p), `inventory`
(inv), `customer` (c), `order` (o), `supplier` (sup), `outlet`, `product-type`
(pt), `attribute` (attr), `barcode`, `purchase-order` (po), `transfer` (xfer),
`loyalty-reason`, `loyalty-history`, `stock-reason`, `stocktake` (st). Full list + flags:
[references/commands.md](references/commands.md).

```bash
rex product get 124001
rex product list --search weber --page-size 50 | jq '.nodes[].id'
rex product list --all > products.ndjson      # every page, NDJSON stream
rex inventory list --filter product_id=124001  # SOH/available per outlet
```

## Agent stocktake workflow

Use when the human is physically counting products and wants the agent to enter
counts. Set the outlet once, then treat the last token of each `count` command
as the absolute counted quantity. Before starting, WMS credentials must be
configured on the active profile with `rex config wms <profile>`.
Profile names may contain only letters, numbers, dot, underscore, and hyphen.
Invalid characters cause `Unsafe profile name for filesystem path` errors.

```bash
rex stocktake begin --outlet "Gepps X"          # user id can come from config
rex stocktake count weber q 2200 6              # "we have six"
rex stocktake count 124001 3                    # exact product id is safest
rex stocktake review
rex --dry-run stocktake submit                  # preview WMS variance payload
rex stocktake submit                            # creates Awaiting Authorisation stocktake
```

`count` calculates variance from current outlet stock and updates an existing
line if the same product is counted again. Do not create direct stock
adjustments for this workflow; Retail Express manual authorisation remains the
control point.

### Safety notes for agent-driven workflows

- Use a dedicated tenant-scoped profile for each Retail Express tenant.
- A failed response from `rex stocktake submit` does not prove WMS did not
  process the request. Blind retry can duplicate stocktakes; check Retail
  Express or contact support before resubmitting.

`list` returns ONE page; use `--all` (streams NDJSON) for everything — choosing
wrong is the #1 reason a result looks empty.

## Writing (LIVE system — propagates to POS + Shopify)

1. **Dry-run first** — `--dry-run` prints the diff and sends nothing.
2. **Partial updates** — `update` re-fetches and sends only changed fields.
3. **Price gate** — price fields need `--allow-price` (else exit 8).
4. **Soft-disable, never delete** — `rex product disable <id>`.

```bash
rex product update 124001 --set brand=Weber --dry-run   # preview
rex product update 124001 --set brand=Weber             # apply
```

Batch enrichment, `--set`/`--file`/`--stdin` rules, and the price gate:
[references/writing.md](references/writing.md). Worked agent recipes:
[references/recipes.md](references/recipes.md).

## Escape hatch

Any un-wrapped endpoint (price groups live on products; high-volume log streams
are intentionally not wrapped): `rex api <METHOD> <path> [--data ...] [-q k=v]`.
