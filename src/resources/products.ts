import type { RexClient } from "../core/client";
import { PRICE_FIELDS } from "../core/fields";
import {
  createResource,
  disableResource,
  getResource,
  type ListArgs,
  listResource,
  type ResourceConfig,
  streamResource,
  updateResource,
  type WriteOptions,
} from "./crud";

export interface Product {
  id: number;
  short_description?: string;
  [key: string]: unknown;
}

/** Products are the only catalogue resource with gated price fields. */
export const PRODUCT_CONFIG: ResourceConfig = {
  resource: "product",
  path: "products",
  priceFields: PRICE_FIELDS,
};

export const listProducts = (client: RexClient, args: ListArgs = {}) =>
  listResource<Product>(client, "products", args);

export const streamProducts = (client: RexClient, args: ListArgs = {}) =>
  streamResource<Product>(client, "products", args);

export const getProduct = (client: RexClient, id: number | string) =>
  getResource<Product>(client, "products", id);

export const updateProduct = (client: RexClient, desired: Record<string, unknown>, opts: WriteOptions) =>
  updateResource(client, PRODUCT_CONFIG, desired, opts);

export const createProduct = (client: RexClient, body: Record<string, unknown>, opts: WriteOptions) =>
  createResource(client, PRODUCT_CONFIG, body, opts);

export const disableProduct = (client: RexClient, id: number | string, opts: WriteOptions) =>
  disableResource(client, PRODUCT_CONFIG, id, opts);

export type { ListArgs, WriteOptions, WriteResult } from "./crud";
