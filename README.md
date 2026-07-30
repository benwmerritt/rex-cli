# rex

A command-line tool for the Retail Express POS REST API (v2.1). Read and write your
catalogue — products, inventory, pricing, customers, orders, suppliers, purchase
orders, transfers, and loyalty — from the terminal or scripts.

Output is JSON by default, and writes have guardrails (dry-run, price gating,
soft-delete, an audit log).

## Install

Building requires [Bun](https://bun.sh).

```bash
git clone https://github.com/benwmerritt/rex-cli && cd rex-cli
bun install
bun run compile          # builds a standalone ./rex binary
cp rex ~/.local/bin/     # put it on your PATH
```

During development you can run from source: `bun run dev -- product list`.

## Setup

Authenticate once; the key is stored in `~/.config/rex/config.toml` (chmod 600):

```bash
rex auth login mystore --key <api-key>
rex auth test            # -> {"ok":true,"outlets":3}
```

Alternatively set `REX_API_KEY` in your environment or a project `.env` file.

## Usage

```bash
rex product list --search weber --page-size 20
rex product get 124001
rex product list --all > products.ndjson      # all pages, one JSON object per line
rex inventory list --filter product_id=124001
rex order list --include items,payments
rex stocktake begin --outlet "Example Outlet" --user-id 4
rex stocktake count weber q 2200 6
rex stocktake review
rex --dry-run stocktake submit
rex api GET outlets                            # raw call to any endpoint
```

Commands follow `rex <resource> <action>`. Resources: `product` (p), `inventory`
(inv), `customer` (c), `order` (o), `supplier` (sup), `outlet`, `product-type`
(pt), `attribute` (attr), `barcode`, `purchase-order` (po), `transfer` (xfer),
`loyalty-reason`, `loyalty-history`, `stock-reason`, `stocktake` (st), `sales`
(local-cache stats — see [Sales stats](#sales-stats)).

`rex --help` lists everything; `rex <resource> --help` shows a resource's actions.

## Output

- JSON to stdout. Lists are `{ "nodes": [...], "pageInfo": { page, pageSize, total } }`; single records are the object.
- `--human` prints tables instead.
- Errors go to stderr as JSON with a stable exit code: `2` usage, `3` auth, `4` rate-limit, `5` not-found, `6` validation, `7` api, `8` write-blocked, `9` stale-cache.
- `list` returns one page; use `--page`/`--page-size`, or `--all` to stream every page as NDJSON.

## Writing

Writes change a live system, so they're cautious by default:

```bash
rex product update 124001 --set brand=Weber --dry-run   # preview the diff, send nothing
rex product update 124001 --set brand=Weber             # apply
rex product update --file changes.json                  # batch: JSON array of {id, ...fields}
rex product disable 124001                              # soft-disable (not a hard delete)
```

- `update` re-fetches the record and sends only the fields that changed.
- Price fields require `--allow-price`.
- Every write is appended to `~/.local/state/rex/audit.jsonl`.

## Outlet pricing

Retail Express prices a product per outlet, and an outlet price silently
overrides the master price on the product record. `rex api` returns one page at
a time, so use the
[paginated audit recipe](skill/references/recipes.md#outlet-price-divergence-read-only)
to combine every `productprices` page before comparing outlets.

As last verified on 2026-07-30, Retail Express REST v2.1 `productprices` is
GET-only and the documented V2 SOAP interfaces expose no outlet-price write.
Correcting one is a human action in Retail Express Admin; writing the product
master does not clear the override. Sources, version scope, detection, and the
audit recipe:
[docs/workflows/outlet-pricing.md](docs/workflows/outlet-pricing.md).

## Sales stats

Sales reports run against a local per-profile SQLite cache, not live API calls —
the REST API can neither aggregate nor filter orders by date. Sync once, then
query offline (see [ADR 0007](docs/adr/0007-local-sales-cache.md)).

```bash
rex sales sync                 # first run ~20 min (167k orders); resumable
rex sales sync                 # incremental after; catches edits via modified_since
rex sales sync --full          # re-stream and re-upsert every order
```

`sync` pages `modified_since` forward from the last watermark, so a run that dies
resumes where it stopped and later runs are seconds, not minutes. `--full`
repairs rows in place but never deletes; for a true from-scratch rebuild, delete
the cache file (`~/.local/state/rex/sales.<profile>.db`) and sync again.

```bash
rex sales report --fy 2026 --by salesperson       # AU financial year (default: current)
rex sales report --from 2026-01-01 --to 2026-03-31
rex sales report --last 90d --by outlet           # 90d / 12w / 6m windows
rex sales report --by product --top 20            # busiest 20 products
rex sales report --by month --sort profit         # month buckets, gross-profit desc
rex sales report --product 124001                 # one product's history
```

- A **Sale** is a committed order — status not Cancelled, Quote, or Incomplete
  (Awaiting Payment counts) — valued at inc-GST `order_total` (freight
  included), dated by `created_on`; returns net off as negatives.
- **Revenue** is the headline stat — default sort, first column — with units and
  gross profit riding along.
- **Gross profit** is ex-GST (line revenue minus recorded COGS from the cache);
  it is never mixed with the inc-GST revenue figure.
- Product-grouped reports (and `--product`) sum line totals, which exclude
  freight; other groupings sum header `order_total`, which includes it — the
  two bases are close but not reconcilable against each other.
- Buckets and `--fy`/`--from`/`--to` use the store-local calendar
  (Australia/Adelaide). `--fy 2026` = 2025-07-01 through 2026-07-01 (exclusive).

Every result carries `synced_at` and `stale_hours`. `--max-stale <hours>` exits
`9` (stale-cache) instead of reporting stale numbers as current — run
`rex sales sync` first. Reports also exit `9` while the first sync has never
completed, rather than serve partial totals. The cache lives in
`~/.local/state/rex/`.

## Stocktake

Stocktake counts use the legacy Retail Express WMS SOAP `CreateStocktake`
method. The CLI accepts absolute counted quantities, calculates the outlet
variance from current inventory, then submits a stocktake in Retail Express
awaiting manual authorisation.

**WMS is a second credential set, not the REST API key.** The client GUID,
username, password, and service URL come from Retail Express support or your
account admin, and the account needs the Web Services Interface licence enabled.
Nothing in `rex` can derive them. Check what the active profile can do with:

```bash
rex doctor
```

The normal flow — plain `rex stocktake begin` through `rex stocktake submit` —
needs all three: the API key, the WMS credentials, and a stocktake user id.
Counting does not. With only the API key, `rex stocktake begin --local` counts
against live stock on hand and computes variances; `review`, `export`, and
`--dry-run submit` all work from there, producing a worksheet to enter by hand
in the Retail Express UI.

### Handling timeouts and network failures

Timeouts or network failures during `rex stocktake submit` do not guarantee WMS
did not receive the request. Do not blindly retry a submit after an unclear
failure; first check Retail Express for an awaiting-authorisation stocktake, or
contact support, before resubmitting to avoid duplicate stocktakes.

Configure WMS once on an existing REST profile:

```bash
export REX_WMS_CLIENT_ID=<guid>
export REX_WMS_USERNAME=<wms-user>
export REX_WMS_PASSWORD=<wms-password>
export REX_WMS_URL=<wms-service-url>

rex config wms default --stocktake-user-id <retail-express-user-id>
```

The same values can be passed as flags when appropriate. Flags override
environment variables when both are present — but a password in argv is visible
to `ps` and lands in shell history, so prefer the environment form above:

```bash
rex config wms default \
  --client-id <guid> \
  --username <wms-user> \
  --password <wms-password> \
  --url <wms-service-url> \
  --stocktake-user-id <retail-express-user-id>
```

Daily workflow:

```bash
rex stocktake begin --outlet "Example Outlet"
rex stocktake count weber q 2200 6
rex stocktake count 124001 3
rex stocktake review
rex --dry-run stocktake submit
rex stocktake submit
```

`rex config wms default` stores WMS credentials on the `default` profile.
Stocktake sessions are also stored per profile, so use the same `--profile` or
`REX_PROFILE` from `begin` through `submit`. **Critical:** profiles must be
tenant-scoped. Do not reuse the same profile for different Retail Express
tenants, and do not rely on changing `REX_API_KEY` alone as the tenant boundary.
WMS credentials persist in profiles across API key changes, so a reused profile
can submit stocktakes to the wrong WMS tenant. If you rotate the API key on an
existing profile, rerun `rex config wms <profile>` with the matching WMS
credentials before using stocktake again.

`count` updates the staged line if the same product is counted again. Only
non-zero variances are submitted; zero-variance lines are kept in the review but
skipped on submit. The WMS account must have the Retail Express Web Services
Interface enabled.

### Counting without WMS

When the WMS credentials aren't available, `begin` fails with the exact fields
missing, where they come from, and what still works. Pass `--local` to count
anyway:

```bash
rex stocktake begin --outlet "Example Outlet" --local
rex stocktake count 124001 6
rex stocktake review                 # submit.available: false, with the reason
rex --dry-run stocktake submit       # variance preview still works
rex stocktake export                 # worksheet for manual entry
rex stocktake abort                  # once the adjustments are entered by hand
```

A local session never submits, even if WMS credentials appear later — its counts
were never bound to a WMS identity, so it cannot vouch for which tenant they
belong to. Configure WMS and begin a fresh session to submit.

## Configuration

`~/.config/rex/config.toml` holds named profiles. Pick one with `--profile`, a
`REX_PROFILE` env var, or a `.rex.toml` in your project. Resolution order:
`--profile` → `REX_API_KEY`/`REX_PROFILE` env → `.rex.toml` → default profile.

## Agent skill

The repo includes an agent skill under `skill/` so AI coding agents (Claude Code,
Pi) can use `rex`. Install it by copying `skill/` into your agent's skills
directory (e.g. `~/.claude/skills/rex-cli/`). Regenerate the command reference
with `bun run docs`.

## License

MIT © Ben Merritt
