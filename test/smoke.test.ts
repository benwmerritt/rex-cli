import { describe, expect, it } from "bun:test";
import { buildProgram } from "../src/cli/program";

describe("program", () => {
  it("builds a program named rex", () => {
    expect(buildProgram().name()).toBe("rex");
  });

  it("registers the top-level commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toContain("auth");
    expect(names).toContain("config");
    expect(names).toContain("api");
  });

  it("exposes global options including --human and --all", () => {
    const opts = buildProgram().options.map((o) => o.long);
    expect(opts).toContain("--human");
    expect(opts).toContain("--all");
    expect(opts).toContain("--allow-price");
  });
});
