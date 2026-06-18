/**
 * Read-only live smoke test against the Retail Express API.
 *
 * Credentials come from the environment (never hard-coded):
 *   REX_API_KEY=... bun scripts/smoke.ts
 *
 * It only performs GETs (the auth token endpoint is also a GET). It never writes catalogue
 * data. Use it to confirm auth, headers, pagination, and parsing for real.
 */
import { createAuth } from "../src/core/auth";
import { RexClient } from "../src/core/client";
import { fetchTransport } from "../src/core/transport";

const apiKey = process.env.REX_API_KEY;
if (!apiKey) {
  console.error("Set REX_API_KEY (read-only smoke).");
  process.exit(2);
}
const baseUrl = process.env.REX_BASE_URL ?? "https://api.retailexpress.com.au";
const version = process.env.REX_VERSION ?? "v2.1";
const profile = process.env.REX_PROFILE ?? "smoke";

const auth = createAuth({ apiKey, baseUrl, version, profile, transport: fetchTransport });
const client = new RexClient({ baseUrl, version, apiKey, auth });

function preview(data: unknown, max = 900): string {
  const s = JSON.stringify(data, null, 2);
  return s.length > max ? s.slice(0, max) + "\n  …(truncated)" : s;
}

async function main() {
  console.log(`base=${baseUrl} version=${version}`);
  console.log("\n== auth: GET /v2/auth/token ==");
  const token = await auth.ensureToken();
  console.log("OK — bearer token acquired:", token.slice(0, 10) + "…");

  const reads: Array<[string, Record<string, string | number>]> = [
    ["outlets", { page_size: 5 }],
    ["producttypes", { page_size: 5 }],
    ["products", { page_size: 2 }],
  ];

  for (const [path, query] of reads) {
    console.log(`\n== GET /${path} ${JSON.stringify(query)} ==`);
    try {
      const data = await client.get(path, { query });
      console.log(preview(data));
    } catch (err) {
      const e = err as Error & { details?: unknown };
      console.error(`FAILED: ${e.message}`, e.details ? JSON.stringify(e.details) : "");
    }
  }
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
