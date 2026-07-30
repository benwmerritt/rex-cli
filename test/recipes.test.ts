import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PriceRow {
  product_id: number;
  outlet_id: number;
  sell_price_inc: number;
}

interface PricePage {
  page_number: number;
  page_size: number;
  total_records: number;
  data: PriceRow[];
}

const recipesPath = join(import.meta.dir, "..", "skill", "references", "recipes.md");
const recipes = readFileSync(recipesPath, "utf8");
const collectorMatch = recipes.match(/^collect_productprices\(\) \{[\s\S]*?^\}$/m);

if (!collectorMatch) {
  throw new Error("collect_productprices recipe not found");
}

const collector = collectorMatch[0];

function row(outletId: number, price = 10): PriceRow {
  return { product_id: 1, outlet_id: outletId, sell_price_inc: price };
}

function page(
  pageNumber: number,
  totalRecords: number,
  data: PriceRow[],
): PricePage {
  return {
    page_number: pageNumber,
    page_size: 2,
    total_records: totalRecords,
    data,
  };
}

function runCollector(pages: PricePage[]) {
  const dir = mkdtempSync(join(tmpdir(), "rex-price-recipe-"));
  const outputFile = join(dir, "prices.ndjson");

  try {
    for (const fixture of pages) {
      writeFileSync(
        join(dir, `page-${fixture.page_number}.json`),
        JSON.stringify(fixture),
      );
    }

    const script = `set -euo pipefail
${collector}

rex() {
  local requested_page="" arg
  for arg in "$@"; do
    case "$arg" in
      page_number=*) requested_page=\${arg#page_number=} ;;
    esac
  done
  command cat "$FIXTURE_DIR/page-$requested_page.json"
}

collect_productprices "$OUTPUT_FILE"
`;
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", script],
      env: {
        ...process.env,
        FIXTURE_DIR: dir,
        OUTPUT_FILE: outputFile,
      },
      timeout: 5_000,
    });

    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("collect_productprices documentation recipe", () => {
  it("accepts a zero-record response", () => {
    const result = runCollector([page(1, 0, [])]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

  it("collects a short final page", () => {
    const result = runCollector([
      page(1, 3, [row(1), row(2)]),
      page(2, 3, [row(3)]),
    ]);

    expect(result.exitCode).toBe(0);
    expect(
      result.output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([row(1), row(2), row(3)]);
  });

  it("collects a full final page at an exact page-size boundary", () => {
    const result = runCollector([
      page(1, 4, [row(1), row(2)]),
      page(2, 4, [row(3), row(4)]),
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim().split("\n")).toHaveLength(4);
  });

  it("rejects an early empty page", () => {
    const result = runCollector([
      page(1, 3, [row(1), row(2)]),
      page(2, 3, []),
    ]);

    expect(result.exitCode).not.toBe(0);
  });

  it("rejects metadata changes between pages", () => {
    const result = runCollector([
      page(1, 3, [row(1), row(2)]),
      page(2, 4, [row(3), row(4)]),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("metadata changed");
  });

  it("rejects duplicate product/outlet keys", () => {
    const result = runCollector([
      page(1, 3, [row(1), row(2)]),
      page(2, 3, [row(1)]),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unique keys");
  });

  it("rejects a record that changes between pages", () => {
    const result = runCollector([
      page(1, 3, [row(1, 10), row(2)]),
      page(2, 3, [row(1, 12)]),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unique keys");
  });

  it("rejects a final page that exceeds the advertised record count", () => {
    const result = runCollector([
      page(1, 3, [row(1), row(2)]),
      page(2, 3, [row(3), row(4)]),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("returned 4 of 3 records");
  });
});
