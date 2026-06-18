# rex recipes (agent workflows)

Concrete end-to-end patterns. All previews use `--dry-run` first.

## Catalogue enrichment (read → transform → write)

Normalise a brand/type across a search result:

```bash
# 1. pull the products you want to touch
rex product list --search "weber genesis" --all > /tmp/src.ndjson

# 2. build a changes file (only the fields to change, keep id)
jq -c 'select(.brand != "Weber") | {id, brand:"Weber"}' /tmp/src.ndjson \
  | jq -s '.' > /tmp/changes.json

# 3. preview, then apply
rex product update --file /tmp/changes.json --dry-run | jq '.applied // .results | length'
rex product update --file /tmp/changes.json
```

## Run a sale, then restore (price write)

```bash
# put a product on sale (price gate → needs --allow-price)
rex product update 124001 --set web_price_inc=399 --allow-price --dry-run
rex product update 124001 --set web_price_inc=399 --allow-price
# ...later, restore (re-fetch original first if you didn't record it)
rex product update 124001 --set web_price_inc=499 --allow-price
```

The audit log (`~/.local/state/rex/audit.jsonl`) records the before value, so you
can recover the original price.

## Low-stock report (read-only)

```bash
rex inventory list --all \
  | jq -c 'select(.available <= .msl and .msl > 0)
           | {product_id, outlet_id, available, msl}'
```

## Find then act by id

```bash
ID=$(rex product search "Q2200" | jq '.nodes[0].id')
rex product get "$ID" --human
rex product update "$ID" --set product_type="Portable BBQs" --dry-run
```

## Bulk disable obsolete products

```bash
rex product list --filter disabled=false --search "discontinued" --all \
  | jq -r '.id' \
  | while read -r id; do rex product disable "$id" --dry-run; done
# drop --dry-run to apply
```

## Anything not wrapped

```bash
rex api GET orders/12345 -q include_items=true
rex api POST customers --data '{"first_name":"Ada","last_name":"Lovelace"}'
```

## Exit-code branching (in scripts/agents)

```bash
if ! rex auth test >/dev/null 2>&1; then echo "auth failed (exit $?)"; fi
rex product update 1 --set web_price_inc=10   # exits 8 without --allow-price
case $? in 0) echo ok;; 8) echo "needs --allow-price";; *) echo "error $?";; esac
```
