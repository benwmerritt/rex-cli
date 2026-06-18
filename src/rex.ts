#!/usr/bin/env node
import { buildProgram } from "./cli/program";
import { loadDotenv } from "./core/dotenv";

// Auto-load a project .env (so REX_API_KEY can live in a file) before the
// program reads the environment. Real env vars always win.
loadDotenv();

// Thin entry: build the program and run it. All logic lives in buildProgram so
// tests can construct the program without executing argv.
await buildProgram().parseAsync(process.argv);
