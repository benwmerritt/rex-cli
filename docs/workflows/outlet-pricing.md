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

As last verified on **2026-07-30**, the documented Retail Express interfaces
below expose no outlet-price write. This conclusion is scoped to REST v2.1 and
the linked V2 SOAP specifications available on that date; re-check the vendor
documentation before relying on it for a later API version.

| Interface | Outlet price write |
| --- | --- |
| [REST v2.1](https://developer.retailexpress.com.au/getting-started) [`productprices`](https://developer.retailexpress.com.au/api-details) | No — the vendor's published operation list documents GET only |
| Legacy SOAP: [Warehouse Management V2](https://www.retailexpressmedia.com/documentation/api/v2/Retail%20Express%20-%20V2%20Warehouse%20Management%20System%20API.pdf) | No — on-demand methods cover stocktake, dispatch, fulfilment, and receiving |
| Legacy SOAP: [Webstore V2](https://www.retailexpressmedia.com/documentation/api/v2/Retail%20Express%20-%20V2%20Web%20Store%20API.pdf) | No — product and pricing methods are retrieval operations |
| Legacy SOAP: [Accounting V2](https://www.retailexpressmedia.com/documentation/api/v2/Retail%20Express%20-%20V2%20Accounting%20API.pdf) | No — prices appear only as read fields |
| Legacy SOAP: [Inventory Planning V2](https://www.retailexpressmedia.com/documentation/api/v2/Retail%20Express%20-%20V2%20Inventory%20Planning%20System%20API.pdf) | No — writes cover ITOs, purchase orders, and suppliers |

The vendor's [legacy API index](https://developer.retailexpress.com.au/legacy-apis)
identifies those four SOAP interfaces, while its
[version guidance](https://developer.retailexpress.com.au/getting-started#versions)
identifies v2.1 as the latest documented REST version at verification time. No
credential changes the capability of those versions, so `rex doctor` has
nothing to report about it. Correcting an outlet price is a human action in
Retail Express Admin.

Writing the product master does **not** fix an outlet override. The override
persists, the master changes, and a live pricing write has been made for no
benefit. Do not use it as a workaround.

## Detect

Fetch and combine every `productprices` page for the product before comparing
outlets. The
[single-product audit recipe](../../skill/references/recipes.md#outlet-price-divergence-read-only)
does this explicitly; a raw `rex api GET productprices` call returns only one
page.

One row per outlet, each with its own `sell_price_inc`. Normalize those values to
integer cents before comparison. Among rows above zero cents, fewer than two
rows means there is no comparable outlet-price divergence. With at least two
rows, a price held by more than half of them is the consensus and the rest are
outliers. If no price has that strict majority, the result is ambiguous: report
the competing prices and outlet counts and do not classify outliers. For a clear
consensus, report outliers in both directions as potential findings pending
human confirmation — above consensus may be an overcharge; below may be lost
margin.

Rows at `0` mean "not priced at that outlet" and are skipped; including them
buries real findings under every unstocked line.

The same recipes reference includes the whole-catalogue command. A full sweep is
roughly sixty requests and is cheap enough to run on a schedule.

## Correct

1. Report the potential finding with its product id, outlet ids, and current
   prices. For a strict-majority result, also include the consensus price and
   signed price difference in currency units (outlet price minus consensus). For
   an ambiguous result, report each competing price and its outlet count instead;
   do not emit consensus-derived fields.
2. A human confirms the target price. For an ambiguous divergence, or when an
   intentional outlet price differs from consensus, record the approved target
   as an exception; do not infer a correction from consensus alone.
3. If a change is required, a human makes it in Retail Express Admin. Nothing in
   `rex` can do this step.
4. Re-read every `productprices` page for the product and compare the outlet row
   with the human-confirmed target. Only call the price fixed when that read-back
   matches. If an approved exception intentionally remains different from
   consensus, report it as verified rather than as an unresolved outlier.
