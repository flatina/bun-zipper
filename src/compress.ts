import { ZipFormatError } from "./errors.ts";

/**
 * `auto` deflates, then keeps the result only if it actually came out smaller.
 * Incompressible data ends up stored, which is smaller on disk and far cheaper
 * to read back — a deflate stream of already-random bytes still has to be
 * decoded, while a stored one is a copy.
 */
export type CompressionMethod = "auto" | "store" | "deflate";

/**
 * zlib deflate level. Honored only on the buffered path — CompressionStream
 * takes no level and behaves as level 6. Higher is not reliably smaller:
 * Bun's mapping is non-monotonic on some inputs.
 */
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** Raw deflate: no zlib wrapper, which is what ZIP method 8 stores. */
const RAW_WINDOW_BITS = -15;

/** Bun's zlib bindings are typed against ArrayBuffer-backed views only. */
type ZlibInput = Uint8Array<ArrayBuffer>;

export function deflateBytes(data: Uint8Array, level?: Level): Uint8Array {
  return Bun.deflateSync(data as ZlibInput, {
    windowBits: RAW_WINDOW_BITS,
    ...(level === undefined ? {} : { level }),
  });
}

export function inflateBytes(data: Uint8Array, entry?: string): Uint8Array {
  try {
    return Bun.inflateSync(data as ZlibInput, { windowBits: RAW_WINDOW_BITS });
  } catch (cause) {
    throw wrapInflateError(cause, entry);
  }
}

/**
 * Most DEFLATE can expand, bounded by the format itself: a maximal run of
 * back-references yields at most this many output bytes per input byte. When
 * `compressed * this` already fits the ceiling, no lie in the header can breach
 * it, so the fast synchronous path is safe.
 */
const MAX_DEFLATE_EXPANSION = 1032n;

/** Largest output the compressed bytes could produce, whatever the header claims. */
export function worstCaseInflatedSize(compressedSize: bigint): bigint {
  return compressedSize * MAX_DEFLATE_EXPANSION;
}

/**
 * Inflate with a hard output ceiling. `Bun.inflateSync` has no such cap, so an
 * entry that under-reports its size can expand to whatever the payload dictates
 * before any size check runs; streaming lets us stop at the limit instead.
 */
export async function inflateCapped(
  data: Uint8Array,
  cap: bigint,
  onOverflow: () => Error,
  entry?: string,
  expectedSize?: bigint,
): Promise<Uint8Array> {
  // Sizing from the declared length lets chunks land straight in the result. The
  // header is untrusted, so the buffer still grows on demand and the cap still
  // decides when to stop — the hint only saves the copy in the common case.
  const hint = expectedSize !== undefined && expectedSize <= cap ? expectedSize : 0n;
  let out = new Uint8Array(Number(hint));
  let total = 0;

  const source = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  const reader = source.pipeThrough(inflateTransform()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (BigInt(total) + BigInt(value.length) > cap) {
        await reader.cancel().catch(() => {});
        throw onOverflow();
      }
      if (total + value.length > out.length) {
        const grown = new Uint8Array(Math.max((total + value.length) * 2, 64 * 1024));
        grown.set(out.subarray(0, total));
        out = grown;
      }
      out.set(value, total);
      total += value.length;
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name.startsWith("Zip")) throw cause;
    throw wrapInflateError(cause, entry);
  }
  return total === out.length ? out : out.subarray(0, total).slice();
}

export function deflateTransform(): TransformStream<Uint8Array, Uint8Array> {
  return new CompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>;
}

export function inflateTransform(): TransformStream<Uint8Array, Uint8Array> {
  return new DecompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>;
}

/**
 * The runtime throws a bare TypeError with an empty message and a zlib `code`.
 * Note it never reports trailing garbage — only CRC and size checks catch that.
 */
export function wrapInflateError(cause: unknown, entry?: string): ZipFormatError {
  const code = (cause as { code?: string } | undefined)?.code;
  return new ZipFormatError(
    `deflate stream is corrupt or truncated${code ? ` (${code})` : ""}`,
    entry === undefined ? undefined : { entry },
  );
}
