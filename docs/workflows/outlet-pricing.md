# Outlet Pricing Workflow

Use this when a product appears to sell for different amounts at different
outlets, or as a periodic sweep to catch drift nobody reported.

## The Two-Level Model

A Product carries a master price. Each Outlet may additionally carry its own
price for that product. Where an outlet price exists it wins at the point of
sale, and the product record gives no indication that an override is in force.

That asymmetry is the whole problem: the override is invisible from the place
most people look. A price set once during a promotion, or typed into the wrong
outlet, stays there indefinitely and silently.

## What Cannot Be Done

**No Retail Express API can write an outlet price.** This was verified against
every interface the vendor publishes:

| Interface | Outlet price write |
| --- | --- |
| REST v2.1 `productprices` | No — GET only; POST and PUT return 404 |
| Legacy SOAP: Warehouse Management | No — on-demand methods cover stocktake, dispatch, fulfilment, receiving |
| Legacy SOAP: Webstore | No — product and pricing methods are all `Get*` |
| Legacy SOAP: Accounting | No — prices appear only as read fields |
| Legacy SOAP: Inventory Planning | No — writes cover ITOs, purchase orders, suppliers |

No credential unblocks this, so `rex doctor` has nothing to report about it.
Correcting an outlet price is a human action in Retail Express Admin.

Writing the product master does **not** fix an outlet override. The override
persists, the master changes, and a live pricing write has been made for no
benefit. Do not use it as a workaround.

## Detect

Read the per-outlet rows for one product:

```bash
rex api GET productprices -q product_id=124001
```

One row per outlet, each with its own `sell_price_inc`. Divergence rule: among
rows priced above zero, the majority price is the consensus and the rest are
outliers. Report outliers in both directions — an outlet priced above consensus
is overcharging, which is as much an error as undercharging.

Rows at `0` mean "not priced at that outlet" and are skipped; including them
buries real findings under every unstocked line.

The single-product and whole-catalogue audit commands, with the `jq` that
implements this rule, are in
[the recipes reference](../../skill/references/recipes.md#outlet-price-divergence-read-only).
A full sweep is roughly sixty requests and is cheap enough to run on a schedule.

## Correct

1. Report the finding: product id, outlet id, current price, consensus price,
   and the delta.
2. A human changes the price for that outlet in Retail Express Admin. Nothing in
   `rex` can do this step.
3. Re-read `productprices` for the product and confirm the outlet row now
   matches the consensus.

Step 3 is not optional. The correction happened in a system `rex` cannot observe
until it asks again, so a price is only fixed once the read-back says so — never
because someone said they had done it.
