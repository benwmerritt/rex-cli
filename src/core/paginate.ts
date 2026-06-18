import type { QueryValue, RexClient } from "./client";

/** The list envelope Retail Express actually returns (verified live). */
export interface RexListResponse<T> {
  data: T[];
  page_number: number;
  page_size: number;
  total_records: number;
}

/** rex's normalised pagination metadata (maps from the REX envelope). */
export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}

export interface ListEnvelope<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

export const MAX_PAGE_SIZE = 250;

export interface PageOptions {
  query?: Record<string, QueryValue>;
  page?: number;
  pageSize?: number;
}

/** Fetch a single page and map it to rex's `{ nodes, pageInfo }` envelope. */
export async function fetchPage<T>(
  client: RexClient,
  path: string,
  opts: PageOptions = {},
): Promise<ListEnvelope<T>> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? MAX_PAGE_SIZE;
  const res = await client.get<RexListResponse<T>>(path, {
    query: { ...opts.query, page_number: page, page_size: pageSize },
  });
  return {
    nodes: res.data ?? [],
    pageInfo: {
      page: res.page_number ?? page,
      pageSize: res.page_size ?? pageSize,
      total: res.total_records ?? (res.data ?? []).length,
    },
  };
}

export interface PaginateOptions {
  query?: Record<string, QueryValue>;
  pageSize?: number;
  startPage?: number;
  maxPages?: number;
}

/**
 * Iterate every record across pages (drives `--all`). Dedupes by `id` while
 * streaming, since `page_number` paging over a live-mutating dataset can repeat
 * or skip rows — so `--all` is best-effort, not a consistent snapshot. Stops on
 * the first short page or once `total_records` is reached.
 */
export async function* paginate<T>(
  client: RexClient,
  path: string,
  opts: PaginateOptions = {},
): AsyncGenerator<T, void, void> {
  const pageSize = opts.pageSize ?? MAX_PAGE_SIZE;
  let page = opts.startPage ?? 1;
  let fetched = 0;
  let pagesFetched = 0;
  const seen = new Set<unknown>();

  for (;;) {
    const res = await client.get<RexListResponse<T>>(path, {
      query: { ...opts.query, page_number: page, page_size: pageSize },
    });
    const items = res.data ?? [];

    for (const item of items) {
      const id = (item as { id?: unknown }).id;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      yield item;
    }

    fetched += items.length;
    pagesFetched += 1;

    if (items.length < pageSize) break;
    if (res.total_records && fetched >= res.total_records) break;
    if (opts.maxPages && pagesFetched >= opts.maxPages) break;
    page += 1;
  }
}
