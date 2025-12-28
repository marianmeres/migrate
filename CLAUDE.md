# Claude Code Instructions

## Package Summary

**@marianmeres/migrate** - A versioning framework for incremental, bi-directional changes (migrations, undo/redo, progress tracking).

## Quick Reference

- **Entry point:** `src/mod.ts`
- **Core files:** `src/migrate.ts` (Migrate, Version classes), `src/semver.ts` (semver utilities)
- **Tests:** `tests/*.test.ts` (9 tests total)
- **Runtime:** Deno and Node.js

## Key Concepts

- Versions normalized to semver format
- Each version has `up()` and `down()` migration functions
- `up()` is greedy (goes as far as possible), `down()` is conservative (one step)
- `uninstall()` removes everything including initial version

## Common Commands

```bash
deno task test       # Run tests
deno task npm:build  # Build NPM package
deno task publish    # Publish to JSR and NPM
```

## Documentation

- [README.md](README.md) - Overview and examples
- [API.md](API.md) - Complete API reference
- [AGENTS.md](AGENTS.md) - Machine-readable reference
