# Cache keys and optimization strategies

Thor separates three identities that have different correctness boundaries:

```txt
IR structural hash
  = normalized, dialect-independent query shape

compiled cache key
  = dialect id : versioned dialect profile : IR structural hash

execution plan key
  = compiled cache key : execution mode : decode mode
```

The server-side prepared-statement name uses the compiled key. Modes do not
change SQL, so including them there would create duplicate prepared statements.
Mode and decode identity are composed at the execution-plan layer instead.

Parameter values, IR diagnostic ids, codecs, and tracing annotations never
participate in structural or compiled cache keys. Named and inline values remain
separate from the compiled SQL shape.

## Required strategy audit

| Strategy | Implementation |
|---|---|
| Normalized IR by query identity | `queryStructuralHash` projects normalized structural material and memoizes it in a `WeakMap<QueryIR, string>` |
| Structural hashes | FNV-1a digest shared by IR and profile hashing |
| Required capabilities | Builder IR carries `bigint` bits; readable arrays are frozen and memoized by bitset |
| Precompiled stable shapes | `PreparedExecutionPlan` snapshots the shape and precomputes its structural guard, decoder, parameters, and metadata |
| Compiled SQL cache | Fluent execution caches by IR and dialect identity; prepared handles cache per dialect profile |
| Prepared metadata | Drivers receive the value-independent compiled key and cache statements with collision protection |
| Shape/value separation | Compiler keys exclude values; static handles reject captured values and bind named arguments per call |
| Shallow fluent updates | Builders path-copy the statement record and only replace the clause being changed |
| Pure authoring hot path | Schema, builder, IR, guard, hash, and compiler work remain outside Effect |
| Decoder reuse | Selection arrays key compiled Effect Schema decoders; prepared plans retain the decoder directly |
| Metadata reuse | Tables retain one hidden metadata object and one bound column object per declaration |
| Identifier interning | Stable table names, column names, and result aliases use a bounded 4,096-entry intern pool |
| Guard memoization | Results are cached by IR identity, capability-matrix identity, and emulation policy |

The focused unit invariants live in `cache-key.test.ts` and
`optimization-strategies.test.ts`. Generative cache-key properties remain part
of Epic H3; they extend this coverage rather than blocking the Epic F runtime
implementation.
