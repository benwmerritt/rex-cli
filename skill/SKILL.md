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
- **Errors → stderr** as `{ "error": {code,message,details} }` with a stable **exit code**: `0` ok · `2` usage · `3` auth · `4` ratelimit · `5` notfound · `6` validation · `7` api · `8` write-gated · `9` stale-cache. Branch on it.
- Pipe to `jq`. Use `--human` only when a person reads the output; never parse it.

## Auth

`export REX_API_KEY=<key>` (or `rex auth login <name> --key <key>`), then verify
with `rex auth test` → `{ok:true, outlets:N}`. Pick a tenant with `--profile`.

## Commands

`rex <resource> <action> [args] [flags]`. Resources: `product` (p), `inventory`
(inv), `customer` (c), `order` (o), `supplier` (sup), `outlet`, `product-type`
(pt), `attribute` (attr), `barcode`, `purchase-order` (po), `transfer` (xfer),
`loyalty-reason`, `loyalty-history`, `stock-reason`, `stocktake` (st), `sales`
(local-cache stats — see Sales stats below). Full list + flags:
[references/commands.md](references/commands.md).

```bash
rex product get 124001
rex product list --search weber --page-size 50 | jq '.nodes[].id'
rex product list --all > products.ndjson      # every page, NDJSON stream
rex inventory list --filter product_id=124001  # SOH/available per outlet
```

## Two credential sets

The REST API key covers everything in the catalogue. Stocktake **submission**
additionally needs a WMS SOAP account (client GUID, username, password, service
URL) plus a Retail Express user id. WMS credentials come from Retail Express
support — they cannot be derived from the API key, looked up through the REST
API, or guessed. Check before promising a workflow:

```bash
rex doctor    # {credentials:{...}, capabilities:{...}, blocked:[...], nextSteps:[...]}
```

If `rex doctor` reports `stocktake.submit` blocked, say so plainly, name the
missing fields from `blockedBy`, and offer the local path below rather than
starting a count that cannot be posted. Never ask the human to paste WMS
credentials into a chat, issue, or commit — they configure them privately with
`rex config wms <profile>`.

## Agent stocktake workflow

Use when the human is physically counting products and wants the agent to enter
counts. Set the outlet once, then treat the last token of each `count` command
as the absolute counted quantity.
Profile names may contain only letters, numbers, dot, underscore, and hyphen.
Invalid characters cause `Unsafe profile name for filesystem path` errors.

Setup is the human's job, not yours — a password passed as a flag is visible in
`ps` and shell history, so have them export the values instead and never echo
them back:

```bash
# the human runs this once, privately, with REX_WMS_* exported for the four
# credential flags; --stocktake-user-id has no env fallback here
rex config wms <profile> --stocktake-user-id <rex-user-id>
```

```bash
rex stocktake begin --outlet "Example Outlet"   # user id can come from config
rex stocktake count weber q 2200 6              # "we have six"
rex stocktake count 124001 3                    # exact product id is safest
rex stocktake review
rex --dry-run stocktake submit                  # preview WMS variance payload
rex stocktake submit                            # creates Awaiting Authorisation stocktake
```

### When WMS is not configured

`begin` fails with `details.missing`, `details.source`, and
`details.stillAvailable`. Read those and offer the degraded path — the count is
still worth doing, only the posting is blocked:

```bash
rex stocktake begin --outlet "Example Outlet" --local
rex stocktake count 124001 6
rex --dry-run stocktake submit    # variances still computed
rex stocktake export              # {worksheet:{adjustments,alreadyMatching,totals}}
```

Hand the operator `worksheet.adjustments` to enter in the Retail Express UI,
then `rex stocktake abort`. A local session can never be submitted, even after
credentials arrive — begin a fresh session for that.

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

## Outlet pricing

Retail Express prices a Product **per Outlet**. Where an outlet price exists it
**overrides** the master price on the product record, and nothing on that record
reveals the override. Two outlets routinely end up selling the same product at
different prices with no visible cause.

In the vendor documentation last checked on **2026-07-30**, the REST v2.1
operation list exposes `productprices` as GET-only, and the published V2
Warehouse Management, Webstore, Accounting, and Inventory Planning SOAP method
lists expose no outlet-price write. Correcting one is a human action in Retail
Express Admin. This is a capability of those documented versions, not a missing
credential; `rex doctor` will not unblock it. Exact vendor sources and version
scope:
[the outlet-pricing workflow](../docs/workflows/outlet-pricing.md#what-cannot-be-done).

Audit them with the paginated procedure in the recipes reference. It fetches and
combines every `productprices` page before calculating a result; a raw
`rex api GET productprices -q product_id=<id>` call returns only one page.
Divergence rule: after filtering to rows with `sell_price_inc > 0`, zero or one
remaining row means there is no comparable outlet-price divergence. With at
least two rows, a price held by more than half of them is the consensus and the
rest are outliers, in **either** direction. If no price has that strict majority,
report an ambiguous divergence and do not classify outliers. Treat `0` as "not
priced at that outlet" and skip it. Full audit recipe, single product and whole
catalogue:
[references/recipes.md](references/recipes.md#outlet-price-divergence-read-only).

**Always check, and always say so.** Whenever you inspect a specific product,
read its per-outlet prices too and report any divergence unprompted — with the
outlet ids, both prices, and the signed price difference in currency units
(outlet price minus consensus). Describe a clear outlier as a potential loss of
margin or potential overcharge until a human confirms whether the difference is
intentional and names the target price. Consensus detects a potential outlier;
it does not authorize a correction. Record an approved exception when the
confirmed target intentionally differs from consensus. Nobody goes looking for
a silent price gap they were not told about.

Two things not to do:

- **Never write the product master to "fix" an outlet price.** Setting
  `sell_price_inc` on the product record does not clear or overwrite an outlet
  override. The outlet keeps its old price, the master silently changes, and you
  have made a live pricing write that fixed nothing.
- **Never report an outlet price as fixed before verification.** You cannot make
  that change yourself. Hand back the product id, the outlet id, the current
  price, and the human-confirmed target price, then rerun the same all-pages
  `productprices` procedure once the human says they have done it. Compare the
  combined response with that target, not automatically with consensus, before
  calling it resolved or verifying an approved exception.

## Sales stats

Revenue / units / gross-profit reports come from a **local SQLite cache** (the
REST API cannot aggregate or date-filter orders), so `rex sales sync` once, then
`rex sales report ...` answers offline. Every result embeds `synced_at` +
`stale_hours`; check `stale_hours` and re-sync before quoting numbers as current.

```bash
rex sales report --fy 2026 --by salesperson --top 1   # top rep for FY2026 (omit --fy for the current FY)
```

Sync/report commands, JSON envelope, staleness contract, and recipes:
[references/sales.md](references/sales.md).

## Escape hatch

Any un-wrapped endpoint (price groups live on products; high-volume log streams
are intentionally not wrapped): `rex api <METHOD> <path> [--data ...] [-q k=v]`.
