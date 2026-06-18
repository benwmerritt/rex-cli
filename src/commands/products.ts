import type { Command } from "commander";
import type { ContextDeps } from "../cli/context";
import { PRICE_FIELDS } from "../core/fields";
import { registerCrud } from "./crud";

/** Products = the standard CRUD surface + searchable + gated price fields. */
export function registerProduct(program: Command, deps: ContextDeps): void {
  registerCrud(program, deps, {
    name: "product",
    alias: "p",
    path: "products",
    resource: "product",
    description: "Manage products",
    writable: true,
    searchable: true,
    priceFields: PRICE_FIELDS,
    listOptions: (cmd) => cmd.option("--include-inventory", "embed basic inventory in each product"),
  });
}
