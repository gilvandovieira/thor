# Property and fuzz testing

Thor uses `fast-check` for the query invariants in Epic H. The generators cover
all statement forms in the current runtime IR across PostgreSQL, SQLite, and
MySQL compilation:

- nested `and`/`or`/`not` predicates;
- comparisons, `IN`, null checks, named parameters, and inline values;
- selections with raw aggregate expressions, ordering, limits, and offsets;
- insert, update, and delete statements with `RETURNING` requirements.

Run the focused suite with:

```sh
pnpm test:property
```

Every property has a deterministic default seed and 100 generated cases. A
failure reports its fast-check seed and shrink path. Re-run a seed or increase
the local search budget with:

```sh
FC_SEED=1414025042 FC_NUM_RUNS=1000 pnpm test:property
```

The properties prove normalization idempotence, complete and deterministic
parameter binding, value-independent cache keys, shape-sensitive keys,
capability preservation, pre-driver rejection of unsupported operations, and
order preservation for volatile calls.

Join generation is intentionally pending: the v0 runtime IR does not yet have a
join node. It will join these generators when Epic G6 adds the corresponding IR
and compiler surface; raw aggregate expressions exercise the aggregate compile
path available today.
