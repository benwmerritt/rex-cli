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
A physical store / location. This account has three (all BBQ Adelaide Weber
stores). Inventory is tracked per Outlet.
_Avoid_: store, branch, location, shop.

**SOH (Stock on Hand)**:
Physical units present at an Outlet (`stock_on_hand`). Distinct from
**Available** (sellable) and **On Order** (incoming). Never conflate these three.

**Price Group**:
A pricing layer on a Product — **Standard** (a percentage adjustment) or
**Fixed** (explicit per-Product price points). Price Groups are fields on the
Product (`price_groups`, `fixed_price_groups`), NOT a separate resource.

**Promotion**:
Not a first-class object. A sale = writing promotional/web prices (or Fixed
Price Group values) on Products and restoring them later.
_Avoid_: campaign, deal (as if they were resources).

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
