# rex sales (agent workflows)

Revenue / units / gross-profit reports over a **local per-profile SQLite cache**
of orders. The REST API cannot aggregate or date-filter, so `rex sales` never
scans live — it queries the cache. Cache lives in `~/.local/state/rex/`.

## When to sync vs report

- **Report** answers a question. It is offline and fast; run it freely.
- **Sync** refreshes the cache from the API. Run it when the cache is stale (see
  the staleness contract below) or absent — not before every report.

```bash
rex sales sync                 # first run ~20 min (167k orders); resumable
rex sales sync                 # incremental after (modified_since watermark); seconds
rex sales sync --full          # re-stream and re-upsert every order
```

`--full` repairs rows in place but never deletes; for a true from-scratch
rebuild, delete the cache file (`~/.local/state/rex/sales.<profile>.db`, plus
its `-wal`/`-shm` sidecars if present) and sync again.

## Report commands

```bash
rex sales report --fy 2026 --by salesperson       # AU FY (default: current FY)
rex sales report --from 2026-01-01 --to 2026-03-31
rex sales report --last 90d --by outlet           # <n>d | <n>w | <n>m windows
rex sales report --by product --top 20            # line-level product aggregates
rex sales report --by month --sort profit         # buckets: day|month
rex sales report --product 124001                 # one product across the period
```

Flags: `--by salesperson,outlet,product,month,day` · `--sort revenue|units|profit`
(default `revenue` desc) · `--top <n>` · `--product <id>` · `--max-stale <hours>`.

## What the numbers mean

- **Sale** = committed order — status not Cancelled, Quote, or Incomplete;
  Awaiting Payment counts — valued inc-GST at `order_total` (freight
  included), dated by `created_on`; returns net off as negatives.
- **Revenue** is the headline: default sort, first column. `units` and
  `gross_profit_ex` ride along.
- **Gross profit** is ex-GST (line revenue minus cached COGS). Never present it
  alongside the inc-GST revenue as one blended figure.
- **Revenue basis differs by grouping**: product-grouped reports (and
  `--product`) sum line totals, which exclude freight; every other grouping
  sums header `order_total`, which includes it. Totals from the two bases are
  close but not identical — do not reconcile them against each other.
- Buckets and `--fy`/`--from`/`--to` are store-local (Australia/Adelaide).
  `--fy 2026` = 2025-07-01 → 2026-07-01 exclusive.

## JSON envelope

```json
{
  "period":     { "from": "2025-06-30T14:30:00.000Z", "to": "2026-06-30T14:30:00.000Z", "label": "FY2026" },
  "by":         ["salesperson"],
  "sort":       "revenue",
  "rows":       [ { "salesperson_id": 12, "salesperson_name": "Jane Doe", "revenue": 812450.00, "units": 1840, "gross_profit_ex": 214300.00, "orders": 3121 } ],
  "synced_at":  "2026-07-23T02:14:00Z",
  "stale_hours": 3.2
}
```

`period.from`/`to` are UTC instants of the Adelaide-local boundaries. Each row
carries its dimension columns — `salesperson_id`/`salesperson_name`,
`outlet_id`/`outlet_name`, `product_id`/`product_name`/`product_type_name`,
`month`, or `day` — plus the measures `revenue`, `units`, `gross_profit_ex`,
`orders`. `rows` are already sorted by `--sort` (revenue desc default) and cut
to `--top`.

## Recipe: best salesperson for FY2026

```bash
rex sales report --fy 2026 --by salesperson --top 1 \
  | jq -r '.rows[0] | "\(.salesperson_name): $\(.revenue)"'
```

## Recipe: product volume (units, not revenue)

```bash
rex sales report --fy 2026 --by product --sort units --top 10 \
  | jq -r '.rows[] | "\(.units)\t\(.product_name)"'
```

## Staleness contract (agents MUST follow)

Every report carries `synced_at` and `stale_hours`. Before quoting a number as
current:

1. Read `stale_hours`. If it exceeds your freshness bar, run `rex sales sync`,
   then re-report.
2. To enforce this in a script, add `--max-stale <hours>` — the command exits
   `9` (stale-cache) instead of returning stale rows. Sync and retry.
3. Never present stale figures as today's numbers. If you cannot sync, say the
   figures are as of `synced_at`.

Reports also exit `9` when the cache exists but the first sync never completed
(partial totals are refused, not returned). The remedy is the same: run
`rex sales sync` — it resumes from where the interrupted sync stopped — then
retry the report.

```bash
status=0
rex sales report --fy 2026 --by salesperson --max-stale 24 || status=$?
if [ "$status" -eq 9 ]; then
  rex sales sync && rex sales report --fy 2026 --by salesperson --max-stale 24
elif [ "$status" -ne 0 ]; then
  exit "$status"   # don't swallow non-staleness failures
fi
```
