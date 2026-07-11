/**
 * Opaque lexical identities for query sources.
 *
 * @module ir/source-identity
 */

/** @returns A fresh immutable identity token for one table/query alias binding. @internal */
export const sourceIdentity = (): object => Object.freeze({})
