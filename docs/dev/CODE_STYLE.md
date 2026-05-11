# Code Style

Most style is auto-enforced by tsconfig + eslint + prettier — run `task check` to validate, `task format` to auto-fix. This file captures the project-specific choices and the conventions to follow when tooling doesn't speak up.

## TypeScript
- Strict type checking
- ES modules (`import`/`export`)
- Explicit return types on exported functions

## Naming
- `PascalCase` for classes and types
- `camelCase` for functions and variables
- Descriptive, self-documenting names — the goal is to make in-code comments largely unnecessary

## Files
- Lowercase with hyphens (e.g., `note-tools.ts`)
- Tests co-located with their source, `.test.ts` suffix

## Imports
- ES module style with `.js` extension on relative imports — Node's ESM resolver requires this even for `.ts` source. Yes, the `.js` in `import { ... } from '../config.js'` is intentional even though the file on disk is `config.ts`.
- Group imports logically (third-party first, then internal); within a group, keep them sorted

## Comments
- JSDoc for public APIs
- Inline comments only for complex logic
- **CRITICAL: All comments answer WHY, never WHAT.** A comment describing what the code does restates the obvious; a comment explaining why the code exists is captured intent that survives refactors.

## Formatting

Auto-enforced by prettier: 2-space indentation, semicolons required, single quotes preferred. Run `task format` to apply.

## Error handling

For generic principles (real failure boundaries vs defensive code for impossible internal states), see the global engineering rules — they apply across all projects, not just this one.
