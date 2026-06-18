# TypeScript on Bun, built to both a single binary and an npm package

`bun build --compile` produces a standalone `rex` binary (fast cold-start, no
runtime needed for Homebrew distribution), while `bun build --target node`
bundles an npm-installable CLI. To keep the npm path working under plain Node we
deliberately use only cross-runtime APIs (`node:*` modules + global `fetch`) and
avoid Bun-only runtime APIs in `src/`.
