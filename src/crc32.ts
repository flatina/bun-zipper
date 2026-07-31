import { ZipUnsupportedError } from "./errors.ts";

if (typeof Bun === "undefined" || typeof Bun.hash?.crc32 !== "function") {
  throw new ZipUnsupportedError(
    "bun-zipper requires Bun >= 1.3.6 (Bun.hash.crc32). There is no JS fallback by design.",
  );
}

/**
 * Rolling CRC-32. Bun.hash.crc32(chunk, seed) resumes from a previous digest,
 * so a multi-chunk digest equals the whole-buffer digest.
 */
export class Crc32 {
  #value = 0;

  update(chunk: Uint8Array): this {
    if (chunk.length > 0) this.#value = Bun.hash.crc32(chunk, this.#value);
    return this;
  }

  get value(): number {
    return this.#value >>> 0;
  }
}

export function crc32(data: Uint8Array): number {
  return Bun.hash.crc32(data) >>> 0;
}
