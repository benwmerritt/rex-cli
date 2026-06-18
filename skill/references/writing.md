# Writing with rex

Writes hit a **live** retail system (changes propagate to POS and the Shopify
connector). Default to `--dry-run` until you've confirmed the diff.

## The write model

`update` is partial and safe: it re-fetches the current record, computes the
diff, and PUTs **only** the fields that actually changed. A no-op sends nothing.
Nested objects are sent whole; arrays are replace-whole (pass the full array).

Every applied write is appended to `~/.local/state/rex/audit.jsonl`
(before→after) for forensics and rollback.

Writes are **not auto-retried** on 5xx/network error (Retail Express has no
idempotency key, so a retried POST/PUT could double-create). On a `7 api`
failure, re-`get` the record to confirm state before retrying.

## Three input shapes

```bash
# 1. one-off: <id> + --set
rex product update 124001 --set short_description="Weber Q2200" --set brand=Weber

# 2. batch: JSON array of {id, ...only the fields to change}
cat > /tmp/changes.json <<'EOF'
[ {"id":124001,"brand":"Weber","product_type":"Portable BBQs"},
  {"id":124002,"brand":"Weber"} ]
EOF
rex product update --file /tmp/changes.json --dry-run   # preview all
rex product update --file /tmp/changes.json             # apply all

# 3. stream: NDJSON on stdin (one object per line)
jq -c '.nodes[] | {id, brand:"Weber"}' enrich.json | rex product update --stdin
```

Use `--description-file <path>` for long descriptions to avoid shell-escaping.

## `--set` value coercion

- `key=value` → string by default.
- `true`/`false` → boolean; `null` → null.
- numeric → number **only** for known-numeric fields (prices, dimensions,
  quantities). Leading-zero SKUs/barcodes stay strings.
- `key:=<json>` → explicit JSON: `tags:='["a","b"]'`, `meta:='{"k":1}'`.
- Nested: `a.b=1`; array append: `xs[]=1`.
- Price groups and attributes are NOT addressable via `--set` (manage price
  groups through the price fields below; attributes are read-only).

## Price gate

Writing any money field requires `--allow-price`, else the command refuses with
exit `8` (and in `--dry-run`, reports them under `priceGated`). Gated fields:
`price_ex, sell_price_inc, web_price_inc, rrp_inc, promotional_price_inc,
promotional_price_expiry, price_groups, fixed_price_groups, buy_price_ex,
supplier_buy_ex, cogs_ex, direct_costs_ex, markup_target`.

```bash
rex product update 124001 --set web_price_inc=499 --allow-price --dry-run
```

## create / disable

```bash
rex product create --set short_description="New SKU" --set supplier_sku=ABC123
rex product disable 124001     # soft-disable (hides from POS/reports/web)
```

`create` gates price fields the same way. There is no hard delete.

## Other writable resources

`customer` (create/update), `purchase-order` (create/update), `transfer`
(create), `loyalty-reason` / `stock-reason` (create/update). Same dry-run, diff,
audit behaviour. Only `product` exposes `disable`.
