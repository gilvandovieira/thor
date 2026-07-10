# Thor documentation

The entry point for Thor's specifications and guides. The root
[`README.md`](../README.md) is the package overview; this index covers the
`docs/` folder.

## Specifications

Exactly one specification is authoritative at a time; older versions are
archived, not deleted, because the code's `spec §…` references and the delivered
epics' acceptance criteria still point at them.

| Spec | Status | Scope |
|---|---|---|
| [`thor-project-v1-spec.md`](./thor-project-v1-spec.md) | ✅ **Current** | The authoritative v1 (production-readiness) specification — Part II / Epics K–W. |
| [`thor-project-spec-v0.md`](./thor-project-spec-v0.md) | 🗄️ **Archived** | The delivered v0 foundation (Epics A–J). Retained as that foundation's acceptance reference and for its historical section numbers; superseded by the v1 spec. |

[`roadmap.md`](./roadmap.md) tracks progress against both specs as epics.

## Guides

**Queries & execution**
- [Advanced queries](./advanced-queries.md) — joins, subqueries, aggregation, CTEs, window functions, set operations, upserts.
- [Compiled queries](./compiled-queries.md) — the stable `CompiledQuery` hot-path API.
- [Query cache](./query-cache.md) — named bounded cache layers and precompilation modes.
- [Optimization strategies](./optimization-strategies.md) — the hot-path optimizations Thor applies.
- [Relations](./relations.md) — `defineRelations`, loading strategies, no hidden N+1.
- [Routines](./routines.md) — typed, capability-gated functions and procedures.

**Schema, migrations & introspection**
- [Migrations](./migrations.md) — the live migrator, policies, expand/contract.
- [Introspection](./introspection.md) — live schema reads and structural drift.
- [Dialects](./dialects.md) — the per-dialect capability summary (generated).

**Operability & contracts**
- [Observability](./observability.md) — spans, metrics, and safe parameter logging.
- [Errors](./errors.md) — the tagged error set and `catchTag` guidance.
- [API stability](./api-stability.md) — `@stable`/`@experimental`/`@internal` levels.
- [LLM skills](./skills.md) — the shipped agent guidance files.

**Performance**
- [Driver benchmarks](./driver-benchmarks.md) — cross-driver and mode/runtime benchmark results.
- [Query-builder benchmarks](./query-builder-benchmarks.md) — builder/IR/compile overhead.
- [Property testing](./property-testing.md) — the generative invariant suite.

## For contributors

- [API documentation conventions](./api-documentation.md) — the JSDoc rules enforced by `pnpm docs:check`.
