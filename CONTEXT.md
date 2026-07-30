# rex — Retail Express CLI

The bounded context of `rex`: a command-line tool over the Retail Express POS
REST API (v2.1), built for AI agents to run retail-backend workflows. This file
is the glossary — the canonical language of the domain. It holds no
implementation detail.

## Language

**Product**:
The catalogue master record (Retail Express "product master"). Identified by a
numeric `id`. Carries descriptive fields, prices, attributes, and per-outlet
inventory.
_Avoid_: item, listing, SKU.

**SKU**:
A supplier or manufacturer identifier *on* a Product (`supplier_sku`,
`manufacturer_sku`). A SKU is not the Product and is not a stable primary key.
_Avoid_: code, part number (when you mean the product itself).

**Outlet**:
A physical store / location. Inventory is tracked per Outlet.
_Avoid_: store, branch, location, shop.

**SOH (Stock on Hand)**:
Physical units present at an Outlet (`stock_on_hand`). Distinct from
**Available** (sellable) and **On Order** (incoming). Never conflate these three.

**Price Group**:
A pricing layer on a Product — **Standard** (a percentage adjustment) or
**Fixed** (explicit per-Product price points). Price Groups are fields on the
Product (`price_groups`, `fixed_price_groups`), NOT a separate resource.

**Outlet price**:
A Product's price *at one Outlet* (`productprices`, one row per Outlet). Where
one exists it overrides the Product's master price at the point of sale, and the
Product record does not reveal that it is being overridden. Readable through the
documented current APIs; correction is a human action in Retail Express Admin.
Capability boundary last verified 2026-07-30; see
`docs/workflows/outlet-pricing.md`.
_Avoid_: local price, store price, price override (as if a distinct object).

**Price divergence**:
Two or more Outlets holding different Outlet prices for the same Product. The
price held by a strict majority of priced Outlets is the *consensus*; the others
are *outliers*. If no price has a strict majority, there is no consensus and the
divergence is *ambiguous*. An outlier above consensus is a potential overcharge;
one below is potential lost margin, pending human confirmation. Rows priced at
zero mean "not priced at that Outlet", not "free". Fewer than two positive-priced
Outlets is not a comparable divergence. Consensus detects potential outliers; it
does not replace the human-confirmed target price.
_Avoid_: mismatch, discrepancy (unqualified), error (it may be deliberate).

**Promotion**:
Not a first-class object. Running a promotion = writing promotional/web prices
(or Fixed Price Group values) on Products and restoring them later.
_Avoid_: campaign, deal (as if they were resources), "sale" (reserved for
revenue events).

**Soft-disable**:
`rex product disable` (DELETE) hides a Product from POS, reports, and the web
connector. It is reversible-in-spirit, not a destruction.
_Avoid_: delete, remove, archive.

**Profile / Tenant**:
A Retail Express account, holding one API key. A `rex` profile maps to one
tenant. Selecting the wrong profile writes to the wrong business.
_Avoid_: workspace, org, environment.

**Attribute**:
Product metadata definitions (size, colour, brand, custom). Read-only via the
API; attribute *values* are embedded on the Product and on the attribute
definition, not a separate endpoint.

**Audit log**:
The local append-only JSONL record (`~/.local/state/rex/audit.jsonl`) of every
write rex performs, before→after. The forensic trail, not a REX concept.

**Sale**:
A revenue event: a committed Order — status not Cancelled, Quote, or
Incomplete — valued at `order_total` (inc GST, freight included), dated by
`created_on`. Awaiting Payment counts (accrual basis). Returns appear as
negative Orders / line quantities and net off; payments are irrelevant to
Sale figures.
_Avoid_: transaction, invoice; "sale" meaning a Promotion or Quote.

**Salesperson**:
The Retail Express user credited with an Order (`sales_person`). The unit of
"who sold it" in stats; not the same as a WMS or CLI user.
_Avoid_: salesman, staff member, rep.

**Gross Profit**:
Per line: ex-GST revenue (`order_item_total / (1 + tax_rate)`, where
`tax_rate` is a decimal fraction — `0.1` = 10% GST) minus COGS (per-unit
`cogs_ex` × quantity) as recorded at time of sale. Only as accurate as
buy-price hygiene. Revenue figures are inc-GST; Gross Profit is always
ex-GST. Never mix the two bases.
_Avoid_: margin (when you mean the dollar figure), profit (unqualified).

**Sales cache**:
The local per-profile SQLite snapshot of Orders + lines that `rex sales`
reports read. It is a copy, not the source of truth; every report carries its
sync watermark. Freshness is the caller's responsibility.
_Avoid_: database (as if authoritative), sync (as a noun for the store).

**WMS**:
The legacy Retail Express SOAP web service, reached with its own credential set
(client GUID, username, password, service URL) and gated behind the Web Services
Interface licence. Sourced from Retail Express support; never derivable from the
API key. Its only use here is creating a Stocktake, which REST does not expose.
_Avoid_: "the API" (unqualified), warehouse system.

**Capability**:
Something `rex` can do given the credentials on the active Profile — reported by
`rex doctor` as `available` or `blocked`, with the fields that would unblock it.
A missing credential is a fact about the Profile, not a defect.
_Avoid_: permission, feature flag, scope.

**Local stocktake session**:
A Stocktake session opened with `--local`, without WMS. It runs under the active
Profile against that tenant's live stock, and counts, computes variances, and
exports a manual-entry worksheet. It is never submittable: it records no WMS
identity, and one cannot be attached afterwards.
_Avoid_: offline mode, draft, dry run (which is a preview of a real submit).
