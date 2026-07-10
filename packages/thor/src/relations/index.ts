/**
 * Experimental relation declarations and explicit loading planner (v1 spec §13).
 *
 * The planner builds ordinary fluent queries, so every statement still travels
 * through Query IR, guards, capabilities, dialect compilation, execution, and
 * decoding. It never performs one query per parent row.
 *
 * @module relations
 */
import { Effect } from "effect"
import { GuardError, type QueryError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import type { AnyColumn } from "../schema/column.js"
import { alias, type AnyTable, type Select, type Table, tableMeta } from "../schema/table.js"
import type { ExprNode } from "../ir/query-ir.js"
import { columnRef } from "../sql/expressions.js"
import { db } from "../sql/query-builder.js"

/** @experimental Explicit relation loading strategy. */
export type RelationStrategy = "join" | "query" | "manual"

/** @experimental Relation cardinality declared by {@link one} or {@link many}. */
export type RelationKind = "one" | "many"

type NonEmptyColumns = readonly [AnyColumn, ...AnyColumn[]]

/**
 * @experimental Typed relation edge between source and target key tuples.
 * @typeParam Kind - One or many cardinality.
 * @typeParam Fields - Source columns.
 * @typeParam Target - Target table.
 * @typeParam References - Target columns matched to source fields.
 */
export interface RelationDescriptor<
  Kind extends RelationKind = RelationKind,
  Fields extends NonEmptyColumns = NonEmptyColumns,
  Target extends AnyTable = AnyTable,
  References extends NonEmptyColumns = NonEmptyColumns
> {
  readonly kind: Kind
  readonly target: Target
  readonly fields: Fields
  readonly references: References
}

/** @experimental Any declared relation edge. */
export type AnyRelation = RelationDescriptor<RelationKind, NonEmptyColumns, AnyTable, NonEmptyColumns>

/** @experimental Relation definitions grouped by physical source-table name. */
export type RelationDefinitions = Readonly<Record<string, Readonly<Record<string, AnyRelation>>>>

/**
 * @experimental Validated relation graph.
 * @typeParam Definitions - Literal relation definitions retained for inference.
 */
export interface Relations<Definitions extends RelationDefinitions = RelationDefinitions> {
  readonly _tag: "Relations"
  readonly definitions: Definitions
}

type SameLength<Fields extends NonEmptyColumns, References extends NonEmptyColumns> =
  References & { readonly length: Fields["length"] }

/**
 * Declares a to-one relation.
 *
 * @experimental
 * @typeParam Fields - Source key tuple.
 * @typeParam Target - Target table.
 * @typeParam References - Target key tuple.
 * @param target - Related target table.
 * @param config - Ordered source and target key columns.
 * @returns A typed to-one descriptor.
 */
export const one = <
  const Fields extends NonEmptyColumns,
  Target extends AnyTable,
  const References extends NonEmptyColumns
>(
  target: Target,
  config: { readonly fields: Fields; readonly references: SameLength<Fields, References> }
): RelationDescriptor<"one", Fields, Target, References> => ({ kind: "one", target, ...config })

/**
 * Declares a to-many relation.
 *
 * @experimental
 * @typeParam Fields - Source key tuple.
 * @typeParam Target - Target table.
 * @typeParam References - Target key tuple.
 * @param target - Related target table.
 * @param config - Ordered source and target key columns.
 * @returns A typed to-many descriptor.
 */
export const many = <
  const Fields extends NonEmptyColumns,
  Target extends AnyTable,
  const References extends NonEmptyColumns
>(
  target: Target,
  config: { readonly fields: Fields; readonly references: SameLength<Fields, References> }
): RelationDescriptor<"many", Fields, Target, References> => ({ kind: "many", target, ...config })

/** @param columns - Key columns. @returns Their physical names. */
const physicalNames = (columns: ReadonlyArray<AnyColumn>): ReadonlyArray<string> => columns.map((column) => column.def.name)

/** @param left - First name tuple. @param right - Second name tuple. @returns Whether tuples are equal. */
const sameNames = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

/**
 * @param relation - Relation edge to validate.
 * @param sourceName - Graph source-table name.
 * @param relationName - Graph relation name.
 * @returns Nothing.
 * @throws {GuardError} When key ownership, shape, type, uniqueness, or FK metadata is invalid.
 */
const validateRelation = (relation: AnyRelation, sourceName: string, relationName: string): void => {
  if (relation.fields.length === 0 || relation.fields.length !== relation.references.length) {
    throw new GuardError({ guard: "relation-definition", message: `Relation "${sourceName}.${relationName}" requires equal non-empty key tuples` })
  }
  if (relation.fields.some((field) => field.def.table !== sourceName)) {
    throw new GuardError({ guard: "relation-definition", message: `Relation "${sourceName}.${relationName}" has a source field from another table` })
  }
  const target = tableMeta(relation.target)
  if (target.alias) {
    throw new GuardError({ guard: "relation-definition", message: `Relation "${sourceName}.${relationName}" cannot target an aliased table` })
  }
  if (relation.references.some((reference) => reference.def.table !== target.name)) {
    throw new GuardError({ guard: "relation-definition", message: `Relation "${sourceName}.${relationName}" has a reference outside target "${target.name}"` })
  }
  for (let index = 0; index < relation.fields.length; index++) {
    if (relation.fields[index]!.def.dataType !== relation.references[index]!.def.dataType) {
      throw new GuardError({ guard: "relation-definition", message: `Relation "${sourceName}.${relationName}" key types differ at position ${index}` })
    }
  }

  const sourceNames = physicalNames(relation.fields)
  const referenceNames = physicalNames(relation.references)
  const targetForeignKeys = target.foreignKeys
  const hasForwardFk = relation.fields.every((field, index) => {
    const referenced = field.def.references?.column()
    return referenced?.def.table === target.name && referenced.def.name === relation.references[index]?.def.name
  })
  const hasReverseFk = targetForeignKeys.some((foreignKey) =>
    sameNames(foreignKey.columns, referenceNames) &&
    foreignKey.references.table === sourceName &&
    sameNames(foreignKey.references.columns, sourceNames))
  if (relation.kind === "one" && !hasForwardFk) {
    throw new GuardError({ guard: "relation-definition", message: `To-one relation "${sourceName}.${relationName}" must match a source foreign key` })
  }
  if (relation.kind === "many" && !hasReverseFk) {
    throw new GuardError({ guard: "relation-definition", message: `To-many relation "${sourceName}.${relationName}" must match a target foreign key` })
  }
  if (relation.kind === "one") {
    const uniqueColumn = relation.references.length === 1 && relation.references[0]!.def.unique
    const unique = uniqueColumn || sameNames(target.primaryKey, referenceNames) || target.uniqueConstraints.some((constraint) => sameNames(constraint.columns, referenceNames))
    if (!unique) {
      throw new GuardError({ guard: "relation-definition", message: `To-one relation "${sourceName}.${relationName}" must reference a primary or unique key` })
    }
  }
}

/**
 * Defines and validates a typed relation graph.
 *
 * @experimental
 * @typeParam Definitions - Literal graph shape.
 * @param definitions - Relations grouped by physical source-table name.
 * @returns A validated graph retained for query inference.
 */
export const defineRelations = <const Definitions extends RelationDefinitions>(definitions: Definitions): Relations<Definitions> => {
  for (const [sourceName, relations] of Object.entries(definitions)) {
    for (const [relationName, relation] of Object.entries(relations)) validateRelation(relation, sourceName, relationName)
  }
  return { _tag: "Relations", definitions }
}

type TableName<T extends AnyTable> = T extends Table<infer Name, any> ? Name : string
type DefinitionsFor<Graph extends RelationDefinitions, T extends AnyTable> =
  TableName<T> extends keyof Graph ? Graph[TableName<T>] : Readonly<Record<string, never>>
type RelationTarget<Relation> = Relation extends RelationDescriptor<any, any, infer Target, any> ? Target : never

/** @experimental Manual loader context, invoked once with all distinct source keys. */
export interface ManualRelationContext<Relation extends AnyRelation> {
  readonly keys: ReadonlyArray<ReadonlyArray<unknown>>
  readonly relation: Relation
}

/** @experimental Explicit strategy configuration for one relation edge. */
export type RelationLoad<Relation extends AnyRelation> =
  | { readonly strategy: "join" }
  | { readonly strategy: "query" }
  | {
      readonly strategy: "manual"
      readonly load: (
        context: ManualRelationContext<Relation>
      ) => Effect.Effect<ReadonlyArray<Select<RelationTarget<Relation>>>, QueryError, Database>
    }

/** @experimental Relation selections require an explicit strategy per included edge. */
export type RelationSelection<Definitions extends Readonly<Record<string, AnyRelation>>> = {
  readonly [Name in keyof Definitions]?: RelationLoad<Definitions[Name]>
}

type RelationValue<Relation> = Relation extends RelationDescriptor<"many", any, infer Target, any>
  ? ReadonlyArray<Select<Target>>
  : Relation extends RelationDescriptor<"one", any, infer Target, any>
  ? Select<Target> | null
  : never

/** @experimental Nested result inferred from the selected relation edges. */
export type RelationalRow<
  T extends AnyTable,
  Definitions extends Readonly<Record<string, AnyRelation>>,
  With extends RelationSelection<Definitions>
> = Select<T> & { readonly [Name in keyof With & keyof Definitions]: RelationValue<Definitions[Name]> }

type Row = Record<string, unknown>
type SelectedRelation = readonly [name: string, descriptor: AnyRelation, load: RelationLoad<AnyRelation>]

/** @param table - Table to inspect. @param physical - Physical column name. @returns Application property name. */
const applicationKey = (table: AnyTable, physical: string): string => {
  const entry = Object.entries(tableMeta(table).columns).find(([, column]) => column.def.name === physical)
  if (!entry) throw new GuardError({ guard: "relation-identity", message: `Column "${tableMeta(table).name}.${physical}" is not mapped` })
  return entry[0]
}

/** @param row - Decoded application row. @param table - Owning table. @param columns - Physical key columns. @returns Key tuple. */
const rowKey = (row: Row, table: AnyTable, columns: ReadonlyArray<AnyColumn>): ReadonlyArray<unknown> =>
  columns.map((column) => row[applicationKey(table, column.def.name)])

/**
 * @param key - Key tuple.
 * @returns Stable in-memory identity. Handles `bigint` (JSON cannot) and `Date`;
 *   the type prefix keeps a `bigint` from colliding with an equal-looking string.
 */
const keyId = (key: ReadonlyArray<unknown>): string =>
  JSON.stringify(key, (_, value) =>
    typeof value === "bigint"
      ? ` bigint:${value}`
      : value instanceof Date
        ? value.toISOString()
        : value)

/** @param key - Key tuple. @returns Whether SQL equality can match it. */
const matchableKey = (key: ReadonlyArray<unknown>): boolean => key.every((value) => value !== null && value !== undefined)

/** @param table - Table to select. @returns Application-keyed column selection. */
const columnsOf = (table: AnyTable): Record<string, AnyColumn> => ({ ...tableMeta(table).columns })

/** @param column - Compared column. @param value - Bound inline value. @param name - Diagnostic parameter name. @returns Equality expression. */
const equality = (column: AnyColumn, value: unknown, name: string): ExprNode => ({
  _tag: "Comparison",
  op: "=",
  left: columnRef(column),
  right: { _tag: "Param", name, codec: column.def.codec, value }
})

/** @param columns - Target key columns. @param keys - Source key tuples. @returns Batched predicate. */
const keysPredicate = (columns: ReadonlyArray<AnyColumn>, keys: ReadonlyArray<ReadonlyArray<unknown>>): ExprNode => {
  if (columns.length === 1) {
    return {
      _tag: "InList",
      expr: columnRef(columns[0]!),
      values: keys.map((key, index) => ({ _tag: "Param", name: `relation_${index}`, codec: columns[0]!.def.codec, value: key[0] })),
      negated: false
    }
  }
  return {
    _tag: "Logical",
    op: "or",
    operands: keys.map((key, keyIndex) => ({
      _tag: "Logical",
      op: "and",
      operands: columns.map((column, columnIndex) => equality(column, key[columnIndex], `relation_${keyIndex}_${columnIndex}`))
    }))
  }
}

/** @param relations - Declared source relations. @param withSelection - Untrusted requested selection. @returns Validated selected edges. */
const selectedRelations = (
  relations: Readonly<Record<string, AnyRelation>>,
  withSelection: unknown
): ReadonlyArray<SelectedRelation> => {
  if (typeof withSelection !== "object" || withSelection === null || Array.isArray(withSelection)) {
    throw new GuardError({ guard: "relation-strategy", message: "Relation findMany requires a with object" })
  }
  const selected: SelectedRelation[] = []
  for (const [name, raw] of Object.entries(withSelection)) {
    const descriptor = relations[name]
    if (!descriptor) throw new GuardError({ guard: "relation-graph", message: `Unknown relation "${name}"` })
    if (typeof raw !== "object" || raw === null || !("strategy" in raw)) {
      throw new GuardError({ guard: "relation-strategy", message: `Relation "${name}" requires an explicit strategy` })
    }
    const load = raw as RelationLoad<AnyRelation>
    if (load.strategy !== "join" && load.strategy !== "query" && load.strategy !== "manual") {
      throw new GuardError({ guard: "relation-strategy", message: `Relation "${name}" has an unknown strategy` })
    }
    if (load.strategy === "manual" && typeof load.load !== "function") {
      throw new GuardError({ guard: "relation-manual-loader", message: `Manual relation "${name}" requires one batch loader` })
    }
    if (load.strategy === "join" && tableMeta(descriptor.target).primaryKey.length === 0) {
      throw new GuardError({ guard: "relation-identity", message: `Joined relation "${name}" requires a target primary key` })
    }
    selected.push([name, descriptor, load])
  }
  return selected
}

/** @param prefix - Flat SQL alias prefix. @param table - Selected table. @returns Prefixed selection. */
const prefixedSelection = (prefix: string, table: AnyTable): Record<string, AnyColumn> =>
  Object.fromEntries(Object.entries(tableMeta(table).columns).map(([key, column]) => [`${prefix}__${key}`, column]))

/** @param row - Flat decoded row. @param prefix - Alias prefix. @param table - Source table. @returns Application row. */
const unprefix = (row: Row, prefix: string, table: AnyTable): Row =>
  Object.fromEntries(Object.keys(tableMeta(table).columns).map((key) => [key, row[`${prefix}__${key}`]]))

/** @param descriptor - Relation edge. @param target - Aliased target table. @returns Join predicate. */
const joinPredicate = (descriptor: AnyRelation, target: AnyTable): ExprNode => {
  const targetColumns = tableMeta(target).columns
  const comparisons = descriptor.fields.map((field, index) => {
    const physical = descriptor.references[index]!.def.name
    const targetColumn = Object.values(targetColumns).find((column) => column.def.name === physical)!
    return { _tag: "Comparison", op: "=", left: columnRef(field), right: columnRef(targetColumn) } satisfies ExprNode
  })
  return comparisons.length === 1 ? comparisons[0]! : { _tag: "Logical", op: "and", operands: comparisons }
}

/** @param rootTable - Root table. @param joins - Join-selected edges. @returns One query yielding nested root rows. */
const executeJoinedRoot = (
  rootTable: AnyTable,
  joins: ReadonlyArray<SelectedRelation>
): Effect.Effect<ReadonlyArray<Row>, QueryError, Database> => Effect.gen(function* () {
  const rootMeta = tableMeta(rootTable)
  if (rootMeta.primaryKey.length === 0) {
    return yield* Effect.fail(new GuardError({ guard: "relation-identity", message: `Joined root "${rootMeta.name}" requires a primary key` }))
  }
  const selection: Record<string, AnyColumn> = prefixedSelection("root", rootTable)
  const aliases = joins.map(([name, descriptor], index) => {
    const target = alias(descriptor.target, `thor_rel_${index}`)
    Object.assign(selection, prefixedSelection(`rel_${index}`, target))
    return { name, descriptor, target, prefix: `rel_${index}` }
  })
  let query: any = db.select(selection).from(rootTable)
  for (const item of aliases) query = query.leftJoin(item.target, joinPredicate(item.descriptor, item.target))
  const flat: ReadonlyArray<Row> = yield* (query.all() as Effect.Effect<ReadonlyArray<Row>, QueryError, Database>)
  const roots = new Map<string, Row>()
  const childSeen = new Map<string, Map<string, Set<string>>>()
  for (const flatRow of flat) {
    const root = unprefix(flatRow, "root", rootTable)
    const rootIdentity = keyId(rootMeta.primaryKey.map((physical) => root[applicationKey(rootTable, physical)]))
    let output = roots.get(rootIdentity)
    if (!output) {
      output = { ...root }
      for (const { name, descriptor } of aliases) output[name] = descriptor.kind === "many" ? [] : null
      roots.set(rootIdentity, output)
      childSeen.set(rootIdentity, new Map())
    }
    for (const { name, descriptor, prefix } of aliases) {
      const child = unprefix(flatRow, prefix, descriptor.target)
      const targetMeta = tableMeta(descriptor.target)
      const identityValues = targetMeta.primaryKey.map((physical) => child[applicationKey(descriptor.target, physical)])
      if (!matchableKey(identityValues)) continue
      const identity = keyId(identityValues)
      const byRelation = childSeen.get(rootIdentity)!
      let seen = byRelation.get(name)
      if (!seen) {
        seen = new Set()
        byRelation.set(name, seen)
      }
      if (seen.has(identity)) continue
      seen.add(identity)
      if (descriptor.kind === "many") (output[name] as Row[]).push(child)
      else output[name] = child
    }
  }
  return [...roots.values()]
})

/** @param table - Root table. @returns One ordinary decoded root query. */
const executeRoot = (table: AnyTable): Effect.Effect<ReadonlyArray<Row>, QueryError, Database> =>
  db.select(columnsOf(table)).from(table).all() as Effect.Effect<ReadonlyArray<Row>, QueryError, Database>

/** @param values - Values to chunk. @param size - Maximum chunk length. @returns Ordered chunks. */
const chunks = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const output: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

/** @param descriptor - Relation edge. @param keys - Distinct source keys. @returns Batched target rows. */
const executeQueryBatches = (
  descriptor: AnyRelation,
  keys: ReadonlyArray<ReadonlyArray<unknown>>
): Effect.Effect<ReadonlyArray<Row>, QueryError, Database> => {
  if (keys.length === 0) return Effect.succeed([])
  const batchSize = Math.max(1, Math.floor(800 / descriptor.references.length))
  return Effect.map(
    Effect.forEach(chunks(keys, batchSize), (batch) =>
      db.select(columnsOf(descriptor.target)).from(descriptor.target).where(keysPredicate(descriptor.references, batch)).all() as Effect.Effect<ReadonlyArray<Row>, QueryError, Database>,
    { concurrency: 1 }),
    (batches) => batches.flat()
  )
}

/** @param parents - Root rows. @param rootTable - Root table. @param selected - Query/manual edges. @returns Rows with loaded relations. */
const loadSeparateRelations = (
  parents: ReadonlyArray<Row>,
  rootTable: AnyTable,
  selected: ReadonlyArray<SelectedRelation>
): Effect.Effect<ReadonlyArray<Row>, QueryError, Database> => Effect.gen(function* () {
  for (const [name, descriptor, load] of selected) {
    const unique = new Map<string, ReadonlyArray<unknown>>()
    for (const parent of parents) {
      const key = rowKey(parent, rootTable, descriptor.fields)
      if (matchableKey(key)) unique.set(keyId(key), key)
    }
    const keys = [...unique.values()]
    const children: ReadonlyArray<Row> = load.strategy === "manual"
      ? yield* (load.load({ keys, relation: descriptor }) as Effect.Effect<ReadonlyArray<Row>, QueryError, Database>)
      : yield* executeQueryBatches(descriptor, keys)
    const byKey = new Map<string, Row[]>()
    for (const child of children) {
      const identity = keyId(rowKey(child, descriptor.target, descriptor.references))
      const existing = byKey.get(identity)
      if (existing) existing.push(child)
      else byKey.set(identity, [child])
    }
    for (const parent of parents) {
      const key = rowKey(parent, rootTable, descriptor.fields)
      const matches = matchableKey(key) ? byKey.get(keyId(key)) ?? [] : []
      parent[name] = descriptor.kind === "many" ? matches : matches[0] ?? null
    }
  }
  return parents
})

/**
 * @experimental Relation query bound to one table and graph.
 * @typeParam T - Root table.
 * @typeParam Definitions - Root relation definitions.
 */
export class RelationalQuery<T extends AnyTable, Definitions extends Readonly<Record<string, AnyRelation>>> {
  /** @param table - Root table. @param definitions - Relations available from it. */
  constructor(private readonly table: T, private readonly definitions: Definitions) {}

  /**
   * Executes an explicit relation plan without hidden N+1 behavior.
   *
   * @experimental
   * @typeParam With - Selected relation names and strategies.
   * @param options - Required explicit strategy for every included relation.
   * @returns An Effect yielding nested relation rows.
   */
  findMany<const With extends RelationSelection<Definitions>>(
    options: { readonly with: With }
  ): Effect.Effect<ReadonlyArray<RelationalRow<T, Definitions, With>>, QueryError, Database> {
    return Effect.flatMap(
      Effect.try({
        try: () => selectedRelations(this.definitions, options.with),
        catch: (cause) => cause instanceof GuardError
          ? cause
          : new GuardError({ guard: "relation-plan", message: `Relation planning failed: ${String(cause)}` })
      }),
      (selected) => {
        const joined = selected.filter(([, , load]) => load.strategy === "join")
        const separate = selected.filter(([, , load]) => load.strategy !== "join")
        const root = joined.length > 0 ? executeJoinedRoot(this.table, joined) : executeRoot(this.table)
        return Effect.map(
          Effect.flatMap(root, (parents) => loadSeparateRelations(parents.map((parent) => ({ ...parent })), this.table, separate)),
          (rows) => rows as ReadonlyArray<RelationalRow<T, Definitions, With>>
        )
      }
    )
  }
}

/**
 * @experimental Graph-bound relational database facade.
 * @typeParam Definitions - Relation graph definitions.
 */
export class RelationalDatabase<Definitions extends RelationDefinitions> {
  /** @param relations - Validated relation graph. */
  constructor(private readonly relations: Relations<Definitions>) {}

  /**
   * @experimental
   * @typeParam T - Root table.
   * @param table - Root table present in the graph.
   * @returns A typed relation query.
   */
  relation<T extends AnyTable>(table: T): RelationalQuery<T, DefinitionsFor<Definitions, T>> {
    const name = tableMeta(table).name
    return new RelationalQuery(table, (this.relations.definitions[name] ?? {}) as DefinitionsFor<Definitions, T>)
  }
}

/**
 * Binds a relation graph once and returns a typed relational facade.
 *
 * @experimental
 * @typeParam Definitions - Relation graph definitions.
 * @param relations - Validated relation graph.
 * @returns A graph-bound relational database.
 */
export const withRelations = <Definitions extends RelationDefinitions>(
  relations: Relations<Definitions>
): RelationalDatabase<Definitions> => new RelationalDatabase(relations)

/**
 * Creates one relation query without retaining a graph-bound facade.
 *
 * @experimental
 * @typeParam T - Root table.
 * @typeParam Definitions - Relation graph definitions.
 * @param table - Root table.
 * @param relations - Validated relation graph.
 * @returns A typed relation query.
 */
export const relation = <T extends AnyTable, Definitions extends RelationDefinitions>(
  table: T,
  relations: Relations<Definitions>
): RelationalQuery<T, DefinitionsFor<Definitions, T>> => withRelations(relations).relation(table)
