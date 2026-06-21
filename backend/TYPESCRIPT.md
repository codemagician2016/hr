# TypeScript on the backend

The backend is set up for **gradual** TypeScript adoption. No existing
JavaScript is type-checked; new files can be written in `.ts` whenever
the writer wants the extra safety.

## Status (2026-04-25)

- `typescript`, `ts-node`, `@types/node`, `@types/express` installed
- `tsconfig.json` checked in with `allowJs + checkJs=false` (plain JS
  stays invisible to the checker)
- `npm run typecheck` runs `tsc --noEmit` — passes with zero errors
  today because there are no `.ts` source files yet
- CI does not enforce `typecheck` yet (opt-in — flip on once we have
  real `.ts` files)

## How to add a new `.ts` file

1. Write it as `src/.../foo.ts` using regular TypeScript.
2. Import it from existing JS with `require('./foo')` — works because
   Node resolves it via the ts-node loader in dev and the compiled
   `.js` in prod (when we add a build step).
3. Run `npm run typecheck` locally before committing.

## Migration strategy (use when ready)

1. **Start with leaf modules**: pure-function utilities with no
   dependencies on other files (e.g. `src/lib/defaultServices.js`).
   Rename to `.ts`, add type annotations on exports, run typecheck.
2. **Work outward**: once leaf modules compile cleanly, rename the
   controllers that import them, then the routes, then the top-level
   `index.js`.
3. **Don't rename everything in one PR.** Migrate one file per PR so
   reviews stay small and rollbacks are cheap.
4. **Never flip `checkJs` to true until migration is >80% done.** It
   would flood the checker with errors from untyped JS.

## Not set up yet (opt-in later)

- A build step (`tsc` → `dist/`). Today `ts-node` handles runtime; when
  we have many `.ts` files, add `npm run build` and deploy the `dist/`
  output instead.
- CI typecheck. Add a `typecheck` step to `.github/workflows/ci.yml`
  once the first `.ts` files land.
- Strict mode tuning. Current config is `strict: true` but
  `noImplicitAny: false` to keep the early migration friendly; tighten
  later.
