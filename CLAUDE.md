# Claude Code Instructions

## Package Summary

**@marianmeres/migrate** - A versioning framework for incremental, bi-directional changes (migrations, undo/redo, progress tracking).

## Quick Reference

- **Entry point:** `src/mod.ts`
- **Core files:** `src/migrate.ts` (Migrate, Version classes)
- **Semver utilities:** re-exported from the standalone `@marianmeres/semver` package (not vendored here)
- **Tests:** `tests/*.test.ts`, `node:test` + `node:assert/strict` (20 tests total)
- **Stack:** erasable-only TypeScript, Node LTS (`.node-version`), pnpm, Biome. Published to
  npm (`dist/` built by `tsc`) and JSR (`.ts` source via `jsr.json`)

## Key Concepts

- Versions normalized to semver format
- Each version has `up()` and `down()` migration functions
- `up()` is greedy (goes as far as possible), `down()` is conservative (one step)
- `uninstall()` removes everything including initial version

## Common Commands

```bash
pnpm test              # Run tests on Node
pnpm run test:deno     # Same suite on Deno, resolved as JSR consumers see it
pnpm run ci            # typecheck + lint + test (the gate)
pnpm run build         # dist/ for npm
pnpm run rp            # Release (patch) and publish to npm and JSR
```

## Documentation

- [README.md](README.md) - Overview and examples
- [API.md](API.md) - Complete API reference
- [AGENTS.md](AGENTS.md) - Machine-readable reference
