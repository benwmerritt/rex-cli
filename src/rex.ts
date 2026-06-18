#!/usr/bin/env node
import { buildProgram } from "./cli/program";

// Thin entry: build the program and run it. All logic lives in buildProgram so
// tests can construct the program without executing argv. Centralised error
// handling replaces this bare catch when the error layer lands.
await buildProgram().parseAsync(process.argv);
