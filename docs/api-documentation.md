# API documentation standard

Thor keeps its API reference beside the code. Every source file starts with a
module overview, and every named callable documents its contract with standard
JSDoc tags. The source remains useful in an editor while also being ready for a
future API-reference generator.

## Module documentation

Place a JSDoc block before imports. Explain the module's responsibility, its
important boundaries, and any invariant a maintainer must preserve.

```ts
/**
 * Compiles runtime query IR into backend-specific SQL.
 *
 * Dialects own syntax; the compiler owns statement structure and bind order.
 *
 * @module sql/compiler
 */
```

## Callable documentation

Document every parameter by its source name and state what is returned. Add
`@typeParam` when a generic name carries domain meaning, `@throws` for thrown
exceptions or typed Effect failures, and `@example` when the contract is easier
to understand from use than from prose.

```ts
/**
 * Compiles immutable query IR for a target database.
 *
 * @param ir - Query representation to lower.
 * @param dialect - Backend syntax and capabilities.
 * @returns SQL text, positional bind order, and a stable cache key.
 * @throws {CapabilityError} When the dialect cannot execute the query shape.
 */
```

For Effect-returning functions, describe failures as traveling through the
Effect error channel. Constructors document parameters but do not need an
`@returns` tag. Use `@returns Nothing.` for ordinary `void` functions.

## Stability Tags

Package-facing contracts use exactly one release-stability tag:

- `@stable` means compatible evolution is required across v1 minor releases.
- `@experimental` means the API is public and usable, but may change before a
  later stability promotion. Unsafe-hot modes and inspectable output shapes are
  experimental by default.
- `@internal` means no compatibility guarantee. Low-level IR, optimizer,
  compiler, and cache representations belong here even when TypeScript needs to
  expose a supporting declaration.

Tags classify compatibility; they do not change JavaScript or TypeScript
visibility. Avoid exporting `@internal` declarations from package entry points
unless a public structural type requires them.

`scripts/check-api-stability.mjs` uses the TypeScript compiler API to enforce the
reviewed V1 anchors and terminal-method policy. Update the source tag and the
checker together when deliberately promoting or adding a public API family.

## Maintenance

Run the audit before submitting a change:

```sh
pnpm docs:check
```

The checker covers all TypeScript modules in `packages/thor/src` and
`packages/cli/src`. It checks module tags, exported declarations, named helper
functions, class members, interface callables, parameter tags, and return tags.
