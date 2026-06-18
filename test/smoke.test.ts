import { describe, expect, it } from "bun:test";
import { buildProgram } from "../src/cli/program";

describe("scaffold", () => {
  it("builds a program named rex", () => {
    const program = buildProgram();
    expect(program.name()).toBe("rex");
  });

  it("registers the ping command", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("ping");
  });
});
