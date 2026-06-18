import { describe, expect, it } from "bun:test";
import { buildProgram } from "../src/cli/program";

describe("program", () => {
  it("builds a program named rex", () => {
    expect(buildProgram().name()).toBe("rex");
  });

  it("registers the top-level commands and resources", () => {
    const names = buildProgram().commands.map((c) => c.name());
    for (const n of ["auth", "config", "api", "product", "customer", "order", "inventory", "supplier", "outlet"]) {
      expect(names).toContain(n);
    }
  });

  it("inventory is list-only (no get/create), products are full CRUD", () => {
    const cmds = buildProgram().commands;
    const sub = (name: string) =>
      cmds.find((c) => c.name() === name)!.commands.map((c) => c.name());
    expect(sub("inventory")).toEqual(["list"]);
    expect(sub("product")).toContain("disable");
    expect(sub("customer")).toContain("update");
    expect(sub("customer")).not.toContain("disable");
  });

  it("exposes global options including --human and --all", () => {
    const opts = buildProgram().options.map((o) => o.long);
    expect(opts).toContain("--human");
    expect(opts).toContain("--all");
    expect(opts).toContain("--allow-price");
  });
});
