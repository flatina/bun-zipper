import { ByteWriter } from "./binary.ts";
import { type CompressionMethod, deflateBytes, deflateTransform, type Level } from "./compress.ts";
import { Crc32, crc32 } from "./crc32.ts";
import { ZipError, ZipUnsupportedError } from "./errors.ts";
import {
  CENTRAL_HEADER_SIZE,
  EXTRA_ZIP64,
  FLAG_DATA_DESCRIPTOR,
  FLAG_UTF8,
  LOCAL_HEADER_SIZE,
  METHOD_DEFLATE,
  METHOD_STORE,
  SIG_CENTRAL,
  SIG_DATA_DESCRIPTOR,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  toDosTime,
  ZIP64_SENTINEL_16,
  ZIP64_SENTINEL_32,
} from "./format.ts";

/**
 * Anything that accepts bytes in order. Bun's FileSink qualifies.
 * `Bun.write(path, new Response(stream))` does NOT work as an alternative —
 * it stalls on JS-constructed ReadableStreams (Bun 1.3.14).
 */
export interface ZipSink {
  write(chunk: Uint8Array): number | Promise<number>;
  end(): unknown;
}

export type EntryData = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface AddOptions {
  compression?: CompressionMethod;
  /** Ignored for ReadableStream input: the streaming compressor takes no level. */
  level?: Level;
  modifiedAt?: Date;
  comment?: string;
  /** Unix permission bits, e.g. 0o644. Stored in the high half of external attributes. */
  unixMode?: number;
  /**
   * Force Zip64 headers. Buffered entries enable this automatically once they
   * need it; a ReadableStream cannot, because the local header is written before
   * the size is known — set it when a stream may exceed 4 GiB.
   */
  zip64?: boolean;
}

export interface ZipWriterOptions {
  comment?: string;
  compression?: CompressionMethod;
  level?: Level;
  zip64?: boolean;
}

/**
 * A value at or above this cannot go in a 32-bit field: 0xFFFFFFFF itself is the
 * sentinel meaning "the real value is in the Zip64 extra field". The same applies
 * to 0xFFFF for the 16-bit entry count.
 */
const NEEDS_ZIP64_32 = 0xffffffffn;
const NEEDS_ZIP64_16 = BigInt(ZIP64_SENTINEL_16);
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;
const MADE_BY_UNIX = 3 << 8;
const DOS_ATTR_DIRECTORY = 0x10;

interface CentralEntry {
  nameBytes: Uint8Array;
  commentBytes: Uint8Array;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  localOffset: bigint;
  externalAttrs: number;
  madeBy: number;
  /** Local header declares Zip64. Fixed before the header is written, because a
   * reader infers the data descriptor's field width from it. */
  zip64: boolean;
}

const utf8 = new TextEncoder();

export class ZipWriter {
  #sink: ZipSink;
  #options: ZipWriterOptions;
  #entries: CentralEntry[] = [];
  #names = new Set<string>();
  #offset = 0n;
  #closed = false;
  /** Serializes add()/close() so interleaved calls cannot corrupt offsets. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(sink: ZipSink, options: ZipWriterOptions = {}) {
    this.#sink = sink;
    this.#options = options;
  }

  add(name: string, data: EntryData, options: AddOptions = {}): Promise<void> {
    return this.#enqueue(() => this.#add(name, data, options));
  }

  addDirectory(
    name: string,
    options: Omit<AddOptions, "compression" | "level"> = {},
  ): Promise<void> {
    const dirName = name.endsWith("/") ? name : `${name}/`;
    return this.#enqueue(() =>
      this.#add(dirName, new Uint8Array(0), { ...options, compression: "store" }),
    );
  }

  close(): Promise<void> {
    return this.#enqueue(() => this.#close());
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    // Keep the chain alive after a failure so later calls still serialize.
    this.#tail = next.catch(() => {});
    return next;
  }

  async #write(chunk: Uint8Array): Promise<void> {
    await this.#sink.write(chunk);
    this.#offset += BigInt(chunk.length);
  }

  async #add(name: string, data: EntryData, options: AddOptions): Promise<void> {
    if (this.#closed) throw new ZipError("writer is closed", { entry: name });
    if (this.#names.has(name)) throw new ZipError(`duplicate entry name: ${name}`, { entry: name });
    this.#names.add(name);

    const isDirectory = name.endsWith("/");
    const compression = options.compression ?? this.#options.compression ?? "auto";
    // A directory entry has no data, so there is nothing to compress.
    const method = compression === "store" || isDirectory ? METHOD_STORE : METHOD_DEFLATE;
    const level = options.level ?? this.#options.level;
    const { time: dosTime, date: dosDate } = toDosTime(options.modifiedAt ?? new Date());

    // Names are always written as UTF-8 with the flag set, so non-ASCII names
    // survive regardless of the reader's locale.
    const nameBytes = utf8.encode(name);
    const commentBytes = options.comment ? utf8.encode(options.comment) : new Uint8Array(0);
    const localOffset = this.#offset;

    const unixMode = options.unixMode ?? (isDirectory ? 0o755 : 0o644);
    const externalAttrs = ((unixMode & 0xffff) << 16) | (isDirectory ? DOS_ATTR_DIRECTORY : 0);

    const entry: CentralEntry = {
      nameBytes,
      commentBytes,
      flags: FLAG_UTF8,
      method,
      dosTime,
      dosDate,
      crc: 0,
      compressedSize: 0n,
      uncompressedSize: 0n,
      localOffset,
      externalAttrs,
      madeBy: MADE_BY_UNIX | VERSION_DEFLATE,
      zip64: options.zip64 ?? this.#options.zip64 ?? false,
    };

    if (data instanceof ReadableStream) {
      await this.#addStreaming(entry, data);
    } else {
      await this.#addBuffered(entry, await toBytes(data), level, compression === "auto");
    }

    this.#entries.push(entry);
  }

  /** Sizes and CRC are known up front, so no data descriptor is needed. */
  async #addBuffered(
    entry: CentralEntry,
    bytes: Uint8Array,
    level: Level | undefined,
    keepOnlyIfSmaller: boolean,
  ): Promise<void> {
    entry.crc = crc32(bytes);
    entry.uncompressedSize = BigInt(bytes.length);

    let payload = bytes;
    if (entry.method === METHOD_DEFLATE) {
      const deflated = deflateBytes(bytes, level);
      if (keepOnlyIfSmaller && deflated.length >= bytes.length) {
        entry.method = METHOD_STORE;
      } else {
        payload = deflated;
      }
    }
    entry.compressedSize = BigInt(payload.length);
    entry.zip64 ||= zip64Shape(entry).sizes;

    await this.#write(localHeader(entry));
    if (payload.length > 0) await this.#write(payload);
  }

  /** Size is unknown until the source ends, so bit 3 + a trailing descriptor. */
  async #addStreaming(entry: CentralEntry, source: ReadableStream<Uint8Array>): Promise<void> {
    entry.flags |= FLAG_DATA_DESCRIPTOR;
    await this.#write(localHeader(entry));

    const crc = new Crc32();
    let uncompressed = 0n;
    let compressed = 0n;

    if (entry.method === METHOD_STORE) {
      for await (const chunk of source as AsyncIterable<Uint8Array>) {
        crc.update(chunk);
        uncompressed += BigInt(chunk.length);
        await this.#write(chunk);
      }
      compressed = uncompressed;
    } else {
      const transform = deflateTransform();
      const input = transform.writable.getWriter();
      const output = transform.readable.getReader();

      // Drain the compressor concurrently; otherwise its buffer stalls the feed.
      const drain = (async () => {
        for (;;) {
          const { done, value } = await output.read();
          if (done) break;
          compressed += BigInt(value.length);
          await this.#write(value);
        }
      })();

      try {
        for await (const chunk of source as AsyncIterable<Uint8Array>) {
          crc.update(chunk);
          uncompressed += BigInt(chunk.length);
          await input.write(chunk);
        }
        await input.close();
      } catch (error) {
        await input.abort(error).catch(() => {});
        throw error;
      }
      await drain;
    }

    entry.crc = crc.value;
    entry.uncompressedSize = uncompressed;
    entry.compressedSize = compressed;

    // The local header is already on the wire, so its Zip64 decision cannot be
    // revised. Emitting a 64-bit descriptor under a 32-bit header would produce
    // an entry no reader can parse; fail loudly instead.
    if (!entry.zip64 && zip64Shape(entry).sizes) {
      throw new ZipUnsupportedError(
        "streamed entry exceeded 4 GiB but its header was not written for Zip64; " +
          "pass { zip64: true } when the size is not known in advance",
        { entry: new TextDecoder().decode(entry.nameBytes) },
      );
    }
    await this.#write(dataDescriptor(entry));
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const centralOffset = this.#offset;
    for (const entry of this.#entries) await this.#write(centralHeader(entry));
    const centralSize = this.#offset - centralOffset;

    const comment = this.#options.comment ? utf8.encode(this.#options.comment) : new Uint8Array(0);
    const count = BigInt(this.#entries.length);
    const needsZip64 =
      count >= NEEDS_ZIP64_16 || centralOffset >= NEEDS_ZIP64_32 || centralSize >= NEEDS_ZIP64_32;

    if (needsZip64) {
      await this.#write(zip64End(count, centralSize, centralOffset, this.#offset));
    }
    await this.#write(
      endOfCentralDirectory(count, centralSize, centralOffset, comment, needsZip64),
    );
    await this.#sink.end();
  }
}

/**
 * Which slots of an entry must become Zip64 sentinels. The two sizes move
 * together: writing one as a sentinel and the other literally is legal but
 * readers disagree about it, so they are kept paired.
 */
function zip64Shape(entry: CentralEntry): { sizes: boolean; offset: boolean } {
  return {
    sizes: entry.uncompressedSize >= NEEDS_ZIP64_32 || entry.compressedSize >= NEEDS_ZIP64_32,
    offset: entry.localOffset >= NEEDS_ZIP64_32,
  };
}

/** Zip64 extra field. Holds exactly the values whose 32-bit slot is a sentinel. */
function zip64Extra(entry: CentralEntry): Uint8Array | undefined {
  const shape = zip64Shape(entry);
  if (!shape.sizes && !shape.offset) return undefined;

  const w = new ByteWriter(28);
  w.u16(EXTRA_ZIP64).u16((shape.sizes ? 16 : 0) + (shape.offset ? 8 : 0));
  // Order is fixed by APPNOTE; a field is present only if its slot is a sentinel.
  if (shape.sizes) w.u64(entry.uncompressedSize).u64(entry.compressedSize);
  if (shape.offset) w.u64(entry.localOffset);
  return w.toBytes();
}

function localHeader(entry: CentralEntry): Uint8Array {
  const streaming = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  // A local Zip64 extra field always carries both sizes (APPNOTE 4.5.3). For a
  // streamed entry they are still zero here; the data descriptor supplies them.
  const extra = entry.zip64
    ? new ByteWriter(20)
        .u16(EXTRA_ZIP64)
        .u16(16)
        .u64(entry.uncompressedSize)
        .u64(entry.compressedSize)
        .toBytes()
    : undefined;
  const sentinel = entry.zip64 ? ZIP64_SENTINEL_32 : undefined;

  const w = new ByteWriter(LOCAL_HEADER_SIZE + entry.nameBytes.length + 20);
  w.u32(SIG_LOCAL)
    .u16(entry.zip64 ? VERSION_ZIP64 : VERSION_DEFLATE)
    .u16(entry.flags)
    .u16(entry.method)
    .u16(entry.dosTime)
    .u16(entry.dosDate)
    .u32(streaming ? 0 : entry.crc)
    .u32(streaming ? 0 : (sentinel ?? Number(entry.compressedSize)))
    .u32(streaming ? 0 : (sentinel ?? Number(entry.uncompressedSize)))
    .u16(entry.nameBytes.length)
    .u16(extra?.length ?? 0)
    .bytes(entry.nameBytes);
  if (extra) w.bytes(extra);
  return w.toBytes();
}

/**
 * Descriptor field width is not self-describing: a reader infers it from whether
 * the local header declared Zip64. It must follow that decision, not the sizes.
 */
function dataDescriptor(entry: CentralEntry): Uint8Array {
  const w = new ByteWriter(24);
  w.u32(SIG_DATA_DESCRIPTOR).u32(entry.crc);
  if (entry.zip64) w.u64(entry.compressedSize).u64(entry.uncompressedSize);
  else w.u32(Number(entry.compressedSize)).u32(Number(entry.uncompressedSize));
  return w.toBytes();
}

function centralHeader(entry: CentralEntry): Uint8Array {
  const shape = zip64Shape(entry);
  const extra = zip64Extra(entry);
  const w = new ByteWriter(CENTRAL_HEADER_SIZE + entry.nameBytes.length + 32);
  w.u32(SIG_CENTRAL)
    .u16(entry.madeBy)
    .u16(extra ? VERSION_ZIP64 : VERSION_DEFLATE)
    .u16(entry.flags)
    .u16(entry.method)
    .u16(entry.dosTime)
    .u16(entry.dosDate)
    .u32(entry.crc)
    .u32(shape.sizes ? ZIP64_SENTINEL_32 : Number(entry.compressedSize))
    .u32(shape.sizes ? ZIP64_SENTINEL_32 : Number(entry.uncompressedSize))
    .u16(entry.nameBytes.length)
    .u16(extra?.length ?? 0)
    .u16(entry.commentBytes.length)
    .u16(0)
    .u16(0)
    .u32(entry.externalAttrs)
    .u32(shape.offset ? ZIP64_SENTINEL_32 : Number(entry.localOffset))
    .bytes(entry.nameBytes);
  if (extra) w.bytes(extra);
  if (entry.commentBytes.length > 0) w.bytes(entry.commentBytes);
  return w.toBytes();
}

function zip64End(
  count: bigint,
  centralSize: bigint,
  centralOffset: bigint,
  zip64EocdOffset: bigint,
): Uint8Array {
  const w = new ByteWriter(76);
  w.u32(SIG_ZIP64_EOCD)
    .u64(44n) // size of the remainder of this record
    .u16(MADE_BY_UNIX | VERSION_ZIP64)
    .u16(VERSION_ZIP64)
    .u32(0)
    .u32(0)
    .u64(count)
    .u64(count)
    .u64(centralSize)
    .u64(centralOffset)
    .u32(SIG_ZIP64_LOCATOR)
    .u32(0)
    .u64(zip64EocdOffset)
    .u32(1);
  return w.toBytes();
}

function endOfCentralDirectory(
  count: bigint,
  centralSize: bigint,
  centralOffset: bigint,
  comment: Uint8Array,
  zip64: boolean,
): Uint8Array {
  const entries = zip64 ? ZIP64_SENTINEL_16 : Number(count);
  const w = new ByteWriter(22 + comment.length);
  w.u32(SIG_EOCD)
    .u16(0)
    .u16(0)
    .u16(entries)
    .u16(entries)
    .u32(zip64 ? ZIP64_SENTINEL_32 : Number(centralSize))
    .u32(zip64 ? ZIP64_SENTINEL_32 : Number(centralOffset))
    .u16(comment.length)
    .bytes(comment);
  return w.toBytes();
}

async function toBytes(data: Exclude<EntryData, ReadableStream<Uint8Array>>): Promise<Uint8Array> {
  if (typeof data === "string") return utf8.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

/** Collects output in memory. Used by `zip()`; suitable only for small archives. */
export class MemorySink implements ZipSink {
  #chunks: Uint8Array[] = [];
  #size = 0;

  write(chunk: Uint8Array): number {
    // Chunks may be views into buffers the caller reuses, so copy.
    this.#chunks.push(chunk.slice());
    this.#size += chunk.length;
    return chunk.length;
  }

  end(): number {
    return this.#size;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

export interface ZipOptions extends ZipWriterOptions {}

/** Builds a complete archive in memory. For large inputs use ZipWriter with a FileSink. */
export async function zip(
  files: Record<string, EntryData | (AddOptions & { data: EntryData })>,
  options: ZipOptions = {},
): Promise<Uint8Array> {
  const sink = new MemorySink();
  const writer = new ZipWriter(sink, options);
  for (const [name, value] of Object.entries(files)) {
    if (isEntrySpec(value)) {
      const { data, ...opts } = value;
      await writer.add(name, data, opts);
    } else {
      await writer.add(name, value);
    }
  }
  await writer.close();
  return sink.toBytes();
}

function isEntrySpec(value: unknown): value is AddOptions & { data: EntryData } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Blob) &&
    !(value instanceof ReadableStream)
  );
}
