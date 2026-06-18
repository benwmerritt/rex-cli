/**
 * Field classification for Retail Express products, derived from the live API
 * response shape. Single source of truth for:
 *   - which fields are price-touching (gated behind --allow-price)
 *   - which fields are numeric / boolean (for safe --set coercion)
 */

/** Money fields — writing any of these requires --allow-price. */
export const PRICE_FIELDS: ReadonlySet<string> = new Set([
  "price_ex",
  "sell_price_inc",
  "web_price_inc",
  "rrp_inc",
  "promotional_price_inc",
  "promotional_price_expiry",
  "buy_price_ex",
  "supplier_buy_ex",
  "cogs_ex",
  "direct_costs_ex",
  "markup_target",
  "price_groups",
  "fixed_price_groups",
]);

/** Fields that should coerce a numeric-looking --set value to a number. */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  // pricing / cost
  "price_ex",
  "sell_price_inc",
  "web_price_inc",
  "rrp_inc",
  "promotional_price_inc",
  "buy_price_ex",
  "supplier_buy_ex",
  "cogs_ex",
  "direct_costs_ex",
  "markup_target",
  // dimensions / logistics
  "carton_quantity",
  "weight",
  "length",
  "breadth",
  "depth",
  "cubic",
  "shipping_cubic",
  "lead_time",
  "loyalty_ratio",
  // inventory
  "available",
  "stock_on_hand",
  "on_order",
  "allocated",
  "msl",
]);

/** Fields that should coerce true/false to booleans (true/false coerce anyway, but listed for intent). */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  "disabled",
  "core_product",
  "requires_assembly",
  "voucher_product",
  "export_to_web",
  "prevent_disabling",
  "require_serial_number",
  "has_package_products",
]);

/** The top-level field name of a possibly-nested path (e.g. "price_groups[0].value" → "price_groups"). */
export function topLevelField(path: string): string {
  return path.split(/[.[]/, 1)[0] ?? path;
}

/** Split changed paths into price-gated vs freely-writable. */
export function classifyChanged(changedKeys: string[]): { price: string[]; safe: string[] } {
  const price: string[] = [];
  const safe: string[] = [];
  for (const key of changedKeys) {
    if (PRICE_FIELDS.has(topLevelField(key))) price.push(key);
    else safe.push(key);
  }
  return { price, safe };
}
