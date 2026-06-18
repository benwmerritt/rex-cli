import { describe, expect, it } from "bun:test";
import type { AuthProvider } from "../../src/core/auth";
import { RexClient } from "../../src/core/client";
import { fetchPage, paginate } from "../../src/core/paginate";
import type { Transport } from "../../src/core/transport";

const auth: AuthProvider = { ensureToken: async () => "T", invalidate: () => {} };

/** A client whose transport serves `pages` keyed by the page_number query param. */
function pagedClient(pages: Array<Array<{ id: number }>>, total: number) {
  const transport: Transport = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page_number") ?? "1");
    const pageSize = Number(u.searchParams.get("page_size") ?? "250");
    const data = pages[page - 1] ?? [];
    return new Response(
      JSON.stringify({ data, page_number: page, page_size: pageSize, total_records: total }),
      { headers: { "content-type": "application/json" } },
    );
  };
  return new RexClient({
    baseUrl: "https://x",
    version: "v2.1",
    apiKey: "K",
    auth,
    transport,
    sleep: async () => {},
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const ids = (arr: Array<{ id: number }>) => arr.map((x) => x.id);

describe("fetchPage", () => {
  it("maps data → nodes and the REX page fields → pageInfo", async () => {
    const client = pagedClient([[{ id: 1 }, { id: 2 }]], 42);
    const env = await fetchPage<{ id: number }>(client, "products", { pageSize: 2 });
    expect(ids(env.nodes)).toEqual([1, 2]);
    expect(env.pageInfo).toEqual({ page: 1, pageSize: 2, total: 42 });
  });
});

describe("paginate", () => {
  it("yields all records across pages and stops on a short page", async () => {
    const client = pagedClient([[{ id: 1 }, { id: 2 }], [{ id: 3 }]], 3);
    expect(ids(await collect(paginate(client, "products", { pageSize: 2 })))).toEqual([1, 2, 3]);
  });

  it("stops once total_records is reached even if pages stay full", async () => {
    const client = pagedClient([[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }, { id: 6 }]], 4);
    expect(ids(await collect(paginate(client, "products", { pageSize: 2 })))).toEqual([1, 2, 3, 4]);
  });

  it("dedupes by id across page boundaries", async () => {
    const client = pagedClient([[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]], 4);
    expect(ids(await collect(paginate(client, "products", { pageSize: 2 })))).toEqual([1, 2, 3]);
  });

  it("respects maxPages", async () => {
    const client = pagedClient([[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }]], 4);
    expect(ids(await collect(paginate(client, "products", { pageSize: 2, maxPages: 1 })))).toEqual([1, 2]);
  });
});
