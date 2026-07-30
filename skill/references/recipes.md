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

## Outlet price divergence (read-only)

Retail Express prices a Product per Outlet. An Outlet price overrides the master
price, so two outlets can sell the same product at different prices with nothing
on the product record to show it. This audit flow only reads `productprices`; it
detects divergences and a human fixes them in Admin. The linked
[outlet-pricing guidance](../SKILL.md#outlet-pricing) explains the API capability
boundary. Start a Bash shell and define this collector once; it validates and
combines every response page before either audit runs:

```bash
set -euo pipefail

collect_productprices() {
  local output_file="$1"
  shift
  : >"$output_file"

  local requested_page=1
  local body meta returned_page page_size total_records page_records
  local unique_records
  local expected_page_size="" expected_total_records="" received_records=0

  while :; do
    body=$(rex api GET productprices -q "$@" \
      page_number="$requested_page" page_size=250)
    jq -e --argjson requested "$requested_page" '
      .page_number as $page
      | .page_size as $size
      | .total_records as $total
      | (.data | type) == "array"
        and ([$page, $size, $total] | all(.[]; type == "number"))
        and all(.data[];
          .product_id as $product
          | .outlet_id as $outlet
          | .sell_price_inc as $price
          | ([$product, $outlet, $price] | all(.[]; type == "number"))
            and $product == ($product | floor)
            and $outlet == ($outlet | floor)
            and $product > 0
            and $outlet > 0
            and $price >= 0)
        and $page == ($page | floor)
        and $size == ($size | floor)
        and $total == ($total | floor)
        and $page == $requested
        and $size > 0
        and $total >= 0
        and (.data | length) <= $size
        and (.data | length) <= $total
        and ($page * $size >= $total or (.data | length) == $size)
        and ($total == 0 or (.data | length) > 0)
    ' <<<"$body" >/dev/null

    meta=$(jq -r \
      '[.page_number, .page_size, .total_records, (.data | length)] | @tsv' \
      <<<"$body")
    IFS=$'\t' read -r \
      returned_page page_size total_records page_records <<<"$meta"

    if [[ -z "$expected_page_size" ]]; then
      expected_page_size=$page_size
      expected_total_records=$total_records
    elif [[ $page_size != "$expected_page_size"
            || $total_records != "$expected_total_records" ]]; then
      printf 'productprices pagination metadata changed between pages\n' >&2
      return 1
    fi

    jq -c '.data[]' <<<"$body" >>"$output_file"
    received_records=$((received_records + page_records))
    if ((returned_page * page_size >= total_records)); then
      if ((received_records != total_records)); then
        printf 'productprices pagination returned %d of %d records\n' \
          "$received_records" "$total_records" >&2
        return 1
      fi
      unique_records=$(
        jq -r '[.product_id, .outlet_id] | @tsv' "$output_file" \
          | LC_ALL=C sort -u \
          | wc -l
      )
      if ((unique_records != total_records)); then
        printf 'productprices pagination returned %d unique keys for %d records\n' \
          "$unique_records" "$total_records" >&2
        return 1
      fi
      break
    fi
    requested_page=$((returned_page + 1))
  done
}
```

One product, in that same shell:

```bash
(
product_id=124001
prices_file=$(mktemp)
trap 'rm -f "$prices_file"' EXIT
collect_productprices "$prices_file" product_id="$product_id"

jq -s --argjson product_id "$product_id" '
         map({outlet_id,
              price_cents: (.sell_price_inc * 100 | round)})
       | map(select(.price_cents > 0)) as $rows
       | if ($rows | length) == 0 then
           {status: "no_priced_outlets", product_id: $product_id,
            consensus: null, outliers: []}
         elif ($rows | length) == 1 then
           {status: "not_comparable", product_id: $product_id,
            consensus: null,
            priced_outlet: {outlet_id: $rows[0].outlet_id,
                            price: ($rows[0].price_cents / 100)},
            outliers: []}
         else
           ($rows | length) as $count
           | ($rows | group_by(.price_cents)) as $groups
           | ($groups | map(select(length * 2 > $count))) as $majorities
           | if ($majorities | length) == 0 then
               {status: "ambiguous", product_id: $product_id,
                prices: [$groups[]
                         | {price: (.[0].price_cents / 100),
                            outlet_count: length,
                            outlet_ids: map(.outlet_id)}]}
             else
               ($majorities[0][0].price_cents) as $consensus_cents
               | {status: "ok", product_id: $product_id,
                  consensus: ($consensus_cents / 100),
                  outliers: [$rows[]
                             | select(.price_cents != $consensus_cents)
                             | {outlet_id,
                                price: (.price_cents / 100),
                                price_difference:
                                  ((.price_cents - $consensus_cents)
                                   / 100)}]}
             end
         end' "$prices_file"
)
```

Whole catalogue. `rex api` is a raw passthrough and does not paginate for you, so
reuse the collector in the same shell:

```bash
(
prices_file=$(mktemp)
trap 'rm -f "$prices_file"' EXIT
collect_productprices "$prices_file"

jq -r '[.product_id, .outlet_id,
        (.sell_price_inc * 100 | round)]
       | select(.[2] > 0)
       | @tsv' "$prices_file" \
  | LC_ALL=C sort -t $'\t' -k1,1n -k3,3n \
  | jq -Rn '
      def report($rows):
        if ($rows | length) < 2 then null
        else
          ($rows | length) as $count
          | ($rows | group_by(.price_cents)) as $groups
          | ($groups | map(select(length * 2 > $count))) as $majorities
          | if ($majorities | length) == 0 then
              {status: "ambiguous", product_id: $rows[0].product_id,
               prices: [$groups[]
                        | {price: (.[0].price_cents / 100),
                           outlet_count: length,
                           outlet_ids: map(.outlet_id)}]}
            else
              ($majorities[0][0].price_cents) as $consensus_cents
              | {status: "ok", product_id: $rows[0].product_id,
                 consensus: ($consensus_cents / 100),
                 outliers: [$rows[]
                            | select(.price_cents != $consensus_cents)
                            | {outlet_id,
                               price: (.price_cents / 100),
                               price_difference:
                                 ((.price_cents - $consensus_cents)
                                  / 100)}]}
            end
        end;

      foreach ((inputs | select(length > 0)), "__END__") as $line
        ({product_id: null, rows: []};
         del(.emit)
         | if $line == "__END__" then
             .emit = report(.rows)
           else
             ($line | split("\t")
                    | {product_id: (.[0] | tonumber),
                       outlet_id: (.[1] | tonumber),
                       price_cents: (.[2] | tonumber)}) as $row
             | if .product_id == null or .product_id == $row.product_id then
                 .product_id = $row.product_id
                 | .rows += [$row]
               else
                 .emit = report(.rows)
                 | .product_id = $row.product_id
                 | .rows = [$row]
               end
           end;
         .emit // empty)
      | select(.status == "ambiguous"
               or (.outliers | length) > 0)'
)
```

In the single-product result, zero positive-priced outlets returns
`no_priced_outlets`; one returns `not_comparable`. The whole-catalogue report
intentionally omits products with fewer than two positive-priced outlets, so
those two statuses do not appear there. The collector rejects truncated pages,
metadata changes, or duplicate product/outlet keys instead of silently producing
an incomplete audit. The catalogue pipeline sorts on disk and emits one JSON
object per finding, keeping only one product's outlet rows in memory at a time.

With at least two priced outlets, a price held by more than half of them is the
consensus and the rest are outliers. If there is no strict majority, the result
is `ambiguous` and no outliers are inferred. Prices are normalized to integer
cents before grouping and comparison. Rows that normalize to `0` are skipped as
"not priced at that outlet" — including them buries the real findings under
every unstocked line. Report clear outliers in both directions as potential
findings pending human confirmation: above consensus may be an overcharge; below
may be lost margin. `price_difference` is the signed
outlet-price-minus-consensus difference in currency units, calculated with those
integer-cent values; it is not a percentage.

## Low-stock report (read-only)

```bash
rex inventory list --all \
  | jq -c 'select(.available <= .msl and .msl > 0)
           | {product_id, outlet_id, available, msl}'
```

## Agent-assisted stocktake

Use this when the operator is physically counting stock and wants to avoid
selecting the same outlet and product screen repeatedly. The operator gives an
absolute count; `rex` calculates the variance to submit to WMS.

```bash
# 0. confirm the profile can actually submit before the count starts.
#    Stop here if it cannot: offer `begin --local` rather than counting into a
#    session that can never be posted.
if ! rex doctor | jq -e '.capabilities["stocktake.submit"].status == "available"' >/dev/null; then
  rex doctor | jq '.capabilities["stocktake.submit"].blockedBy'
  exit 1
fi

# 1. start the day's session once for the outlet
rex stocktake begin --outlet "Example Outlet"

# 2. count products as the operator says them
rex stocktake count weber q 2200 6
rex stocktake count 124001 3

# 3. review and preview before the live WMS submit
rex stocktake review
rex --dry-run stocktake submit

# 4. submit creates a Retail Express stocktake awaiting authorisation
rex stocktake submit
```

After the dry run, inspect the JSON before submitting: confirm the submitted
line count, each product id and variance value, and any zero-variance products
that were skipped from the WMS submission. Zero-variance lines remain visible in
local review/audit context only, so the operator can confirm they were counted
without sending no-op lines to Retail Express.

If a product name is ambiguous, stop and ask the operator to choose from the
JSON `matches`. Prefer product ids or barcodes when scanning. Never use direct
stock adjustments for this workflow unless explicitly requested.

Safety:
- Use a dedicated tenant-scoped profile for each Retail Express tenant.
- If `rex stocktake submit` times out, check WMS for an existing
  awaiting-authorisation stocktake before retrying; the request may have reached
  the server.

## Stocktake without WMS credentials

The plain `stocktake begin` and `stocktake submit` need the REST API key, the
WMS SOAP credentials, and a stocktake user id. Everything else — `begin
--local`, `count`, `review`, `export`, and `--dry-run submit` — needs only the
REST key. So when WMS is missing, count anyway and hand back a worksheet: the
physical count is the expensive part, and it is not wasted.

```bash
rex stocktake begin --outlet "Example Outlet" --local
rex stocktake count 124001 6
rex stocktake export | jq '.worksheet.adjustments'
rex stocktake abort            # once the operator has entered them by hand
```

Report the blocker in the operator's terms: which credentials are missing (from
`details.missing`), that they come from Retail Express support, and that the
Web Services Interface licence must be enabled. Do not ask them to send the
credentials to you.

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
