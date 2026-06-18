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
rex stocktake begin --outlet "Mile End" --user-id 4
rex stocktake count weber q 2200 6
rex stocktake review
rex --dry-run stocktake submit
rex api GET outlets                            # raw call to any endpoint
```

Commands follow `rex <resource> <action>`. Resources: `product` (p), `inventory`
(inv), `customer` (c), `order` (o), `supplier` (sup), `outlet`, `product-type`
(pt), `attribute` (attr), `barcode`, `purchase-order` (po), `transfer` (xfer),
`loyalty-reason`, `loyalty-history`, `stock-reason`, `stocktake` (st).

`rex --help` lists everything; `rex <resource> --help` shows a resource's actions.

## Output

- JSON to stdout. Lists are `{ "nodes": [...], "pageInfo": { page, pageSize, total } }`; single records are the object.
- `--human` prints tables instead.
- Errors go to stderr as JSON with a stable exit code: `2` usage, `3` auth, `4` rate-limit, `5` not-found, `6` validation, `7` api, `8` write-blocked.
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

## Stocktake

Stocktake counts use the legacy Retail Express WMS SOAP `CreateStocktake`
method. The CLI accepts absolute counted quantities, calculates the outlet
variance from current inventory, then submits a stocktake in Retail Express
awaiting manual authorisation.

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
environment variables when both are present:

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
rex stocktake begin --outlet "Gepps X"
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
