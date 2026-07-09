/**
 * Small deterministic hashing primitives shared by cache-key components.
 *
 * @module internal/hash
 */

/**
 * Computes a stable 32-bit FNV-1a digest.
 *
 * @param input - Text to hash.
 * @returns Eight-character lowercase hexadecimal digest.
 */
export const hashString = (input: string): string => {
  let value = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(16).padStart(8, "0")
}
