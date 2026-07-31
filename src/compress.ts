import { ZipFormatError } from "./errors.ts";

export type CompressionMethod = "store" | "deflate";

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
 * Inflate with a hard output ceiling. `Bun.inflateSync` has no such cap, so an
 * entry that under-reports its size can expand to whatever the payload dictates
 * before any size check runs; streaming lets us stop at the limit instead.
 */
export async function inflateCapped(
  data: Uint8Array,
  cap: bigint,
  onOverflow: () => Error,
  entry?: string,
): Promise<Uint8Array> {
  const source = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  const reader = source.pipeThrough(inflateTransform()).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0n;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += BigInt(value.length);
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw onOverflow();
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name.startsWith("Zip")) throw cause;
    throw wrapInflateError(cause, entry);
  }

  const out = new Uint8Array(Number(total));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
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
