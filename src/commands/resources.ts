import type { Command } from "commander";
import type { ContextDeps } from "../cli/context";
import { registerCrud } from "./crud";

/**
 * Register every non-product resource. Verbs are deliberately conservative on a
 * live system: only products expose `disable` (a confirmed soft-delete);
 * elsewhere we wire create/update only where the REST API documents it, and
 * leave everything else read-only. `rex api` remains the escape hatch.
 *
 * Paths/shapes were verified live (price groups, stock_receipts,
 * supplier_invoices and productattributevalues do NOT exist as endpoints).
 */
export function registerResources(program: Command, deps: ContextDeps): void {
  // --- read-only reference data ---
  registerCrud(program, deps, {
    name: "outlet",
    path: "outlets",
    description: "Outlets (stores/locations)",
  });
  registerCrud(program, deps, {
    name: "product-type",
    alias: "pt",
    path: "producttypes",
    description: "Product types",
  });
  registerCrud(program, deps, {
    name: "attribute",
    alias: "attr",
    path: "productattributes",
    description: "Product attribute definitions",
  });
  registerCrud(program, deps, {
    name: "barcode",
    path: "productbarcodes",
    description: "Product barcodes",
  });
  registerCrud(program, deps, {
    name: "supplier",
    alias: "sup",
    path: "suppliers",
    description: "Suppliers",
  });

  // --- inventory: list-only, per product/outlet ---
  registerCrud(program, deps, {
    name: "inventory",
    alias: "inv",
    path: "inventory",
    description: "Inventory (stock-on-hand/available per outlet)",
    getById: false,
    listOptions: (cmd) =>
      cmd.option("--modified-since <ts>", "only rows changed since an ISO timestamp"),
  });

  // --- customers: CRUD + search (no disable — DELETE semantics unconfirmed) ---
  registerCrud(program, deps, {
    name: "customer",
    alias: "c",
    path: "customers",
    description: "Customers",
    searchable: true,
    create: true,
    update: true,
  });

  // --- orders: read + includes ---
  registerCrud(program, deps, {
    name: "order",
    alias: "o",
    path: "orders",
    description: "Orders",
    listOptions: (cmd) =>
      cmd.option("--include <names...>", "embed related data: items, fulfilments, payments"),
  });

  // --- procurement ---
  registerCrud(program, deps, {
    name: "purchase-order",
    alias: "po",
    path: "purchaseorders",
    description: "Purchase orders",
    create: true,
    update: true,
  });
  registerCrud(program, deps, {
    name: "transfer",
    alias: "xfer",
    path: "transfers",
    description: "Stock transfers",
    create: true,
  });

  // --- loyalty + adjustments ---
  registerCrud(program, deps, {
    name: "loyalty-reason",
    path: "loyaltyadjustmentreasons",
    description: "Loyalty adjustment reasons",
    create: true,
    update: true,
  });
  registerCrud(program, deps, {
    name: "loyalty-history",
    path: "loyaltyhistory",
    description: "Loyalty point history (read-only)",
  });
  registerCrud(program, deps, {
    name: "stock-reason",
    path: "stockadjustmentreasons",
    description: "Stock adjustment reasons",
    create: true,
    update: true,
  });
}
