import { describe, expect, it } from "bun:test";
import { ValidationError } from "../../src/core/errors";
import { Output, type Writer } from "../../src/core/output";

function capture(): { writer: Writer; text: () => string } {
  const chunks: string[] = [];
  return { writer: { write: (s) => void chunks.push(s) }, text: () => chunks.join("") };
}

describe("Output (json mode)", () => {
  it("pretty-prints results to stdout with a trailing newline", () => {
    const out = capture();
    const err = capture();
    new Output({ mode: "json" }, out.writer, err.writer).result({ id: 1, name: "x" });
    expect(out.text()).toBe('{\n  "id": 1,\n  "name": "x"\n}\n');
    expect(err.text()).toBe("");
  });

  it("emits compact JSON when pretty is false", () => {
    const out = capture();
    new Output({ mode: "json", pretty: false }, out.writer, capture().writer).result({ a: 1 });
    expect(out.text()).toBe('{"a":1}\n');
  });

  it("line() always emits compact NDJSON (one object per line)", () => {
    const out = capture();
    const o = new Output({ mode: "json" }, out.writer, capture().writer);
    o.line({ id: 1 });
    o.line({ id: 2 });
    expect(out.text()).toBe('{"id":1}\n{"id":2}\n');
  });

  it("writes errors to stderr as a stable envelope and returns the exit code", () => {
    const out = capture();
    const err = capture();
    const code = new Output({ mode: "json" }, out.writer, err.writer).error(
      new ValidationError("nope", { details: { profile: "x" } }),
    );
    expect(code).toBe(6);
    expect(out.text()).toBe("");
    expect(JSON.parse(err.text())).toEqual({
      error: { code: "validation", message: "nope", details: { profile: "x" } },
    });
  });
});

describe("Output (human mode)", () => {
  it("renders a list envelope as a table with a page footer", () => {
    const out = capture();
    new Output({ mode: "human" }, out.writer, capture().writer).result({
      nodes: [
        { id: 1, name: "Widget" },
        { id: 2, name: "Gadget" },
      ],
      pageInfo: { page: 1, pageSize: 250, total: 2 },
    });
    const text = out.text();
    expect(text).toContain("ID");
    expect(text).toContain("NAME");
    expect(text).toContain("Widget");
    expect(text).toContain("(page 1 · 2 of 2)");
  });

  it("still emits JSON errors to stderr in human mode", () => {
    const err = capture();
    new Output({ mode: "human" }, capture().writer, err.writer).error(new ValidationError("x"));
    expect(JSON.parse(err.text()).error.code).toBe("validation");
  });
});
