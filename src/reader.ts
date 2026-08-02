import { ByteReader, toSafeInt } from "./binary.ts";
import {
  inflateBytes,
  inflateCapped,
  inflateTransform,
  worstCaseInflatedSize,
} from "./compress.ts";
import { decodeName } from "./cp437.ts";
import { Crc32, crc32 } from "./crc32.ts";
import { ZipCrcError, ZipFormatError, ZipSecurityError, ZipUnsupportedError } from "./errors.ts";
import {
  EOCD_SIZE,
  EXTRA_UNICODE_PATH,
  EXTRA_ZIP64,
  FLAG_ENCRYPTED,
  FLAG_UTF8,
  fromDosTime,
  LOCAL_HEADER_SIZE,
  MAX_COMMENT_SIZE,
  METHOD_DEFLATE,
  METHOD_STORE,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_LOCAL,
  SIG_ZIP64_EOCD,
  SIG_ZIP64_LOCATOR,
  ZIP64_EOCD_SIZE,
  ZIP64_LOCATOR_SIZE,
  ZIP64_SENTINEL_16,
  ZIP64_SENTINEL_32,
} from "./format.ts";
import { isDirectoryName } from "./path.ts";

export interface ZipLimits {
  maxEntries?: number;
  maxEntryUncompressedSize?: bigint;
  /**
   * Running total across an archive, so many small entries cannot add up past
   * the per-entry limit. Spent by `unzip` and `extractZip`; a caller iterating
   * `entries` itself gets the per-entry limits only.
   */
  maxTotalUncompressedSize?: bigint;
  /** Checked before decompressing, against the declared sizes. */
  maxCompressionRatio?: number;
}

export interface ZipReaderOptions {
  /**
   * Decoder for names without the UTF-8 flag. Defaults to CP437 per APPNOTE;
   * set to e.g. "euc-kr" or "shift_jis" for archives from CJK Windows tools.
   */
  filenameEncoding?: string;
  limits?: ZipLimits;
  /**
   * Bytes `bytes()` may allocate for a single inflate call. An entry is inflated
   * in one call when it fits, which is several times faster; anything larger is
   * streamed, holding peak memory near the chunk size instead.
   *
   * The check runs *before* inflating, against the largest output the compressed
   * bytes could possibly produce — `Bun.inflateSync` has no output ceiling, so
   * there is nothing to stop once it has started.
   *
   * `-1` removes the cap: every entry is inflated in one call, and a header that
   * under-reports its size can allocate whatever its payload dictates. `0`
   * streams everything. `stream()` always streams regardless.
   */
  maxInflateBuffer?: number;
  /**
   * Verify each entry's CRC-32 against the archive on read. On by default.
   *
   * Turning it off makes a stored entry roughly a copy, which is what readers
   * that skip the check are doing when they look faster. Corruption then reaches
   * the caller silently: the size check still runs, but a flipped byte does not
   * change the size. Only worth it for data you have already validated.
   */
  verifyCrc?: boolean;
  /**
   * Called instead of throwing when an entry's CRC-32 does not match. Return
   * `"accept"` to take the bytes anyway.
   *
   * A damaged backup is the case this exists for: `unzip`, 7-Zip and Python all
   * hand back what they could read and report the problem separately, and
   * refusing outright loses data the caller may still want.
   *
   * Reaches same-length damage only. Size is checked before the CRC on both
   * paths, so an entry that reads short throws `ZipFormatError` without ever
   * calling this. `stream()` is the recovery path there: it delivers the chunks
   * that arrived and errors at the end.
   *
   * `expected` is the central header's value and `local` the local header's copy,
   * which most writers fill in. Agreement between those two points at the data
   * being damaged; disagreement points at one of the headers.
   */
  onCrcMismatch?: (info: CrcMismatch) => "throw" | "accept";
}

export interface CrcMismatch {
  entry: string;
  computed: number;
  expected: number;
  /** Absent for entries written with a data descriptor. */
  local: number | undefined;
  /** The recovered bytes. Absent when streaming, where they are already delivered. */
  data: Uint8Array | undefined;
}

/** Slice size for streamed reads; trades syscalls against peak memory. */
const READ_CHUNK = 1024 * 1024;

/**
 * Chosen so entries that realistically fit in memory still take the fast path:
 * the worst-case bound is ~1032x, so this admits roughly 8 MB of compressed data.
 */
const DEFAULT_INFLATE_BUFFER = 2 ** 33;

const DEFAULT_LIMITS: Required<ZipLimits> = {
  maxEntries: 100_000,
  maxEntryUncompressedSize: 1n << 33n, // 8 GiB
  maxTotalUncompressedSize: 1n << 35n, // 32 GiB
  maxCompressionRatio: 1000,
};

/** Random-access byte source. Bun.file() satisfies this via Blob. */
interface Source {
  readonly size: number;
  read(start: number, length: number): Promise<Uint8Array>;
  /**
   * Whether `read` hands back memory the caller may keep. False for an in-memory
   * archive, where reads are views into the caller's own buffer and returning one
   * would alias it; true for a Blob, which allocates per read.
   */
  readonly ownsReads: boolean;
}

export type ZipInput = Uint8Array | ArrayBuffer | Blob;

function toSource(input: ZipInput): Source {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : undefined;
  if (bytes) {
    return {
      size: bytes.length,
      ownsReads: false,
      async read(start, length) {
        return bytes.subarray(start, start + length);
      },
    };
  }
  const blob = input as Blob & {
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  };
  return {
    size: blob.size,
    ownsReads: true,
    async read(start, length) {
      return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
    },
  };
}

export interface ZipEntry {
  readonly name: string;
  /** Raw name bytes, for archives whose encoding we could not determine. */
  readonly rawName: Uint8Array;
  readonly comment: string;
  /**
   * Whatever the archive declared. Only 0 (store) and 8 (deflate) can be read;
   * anything else is surfaced here and refused when the data is requested.
   */
  readonly compressionMethod: number;
  readonly compressedSize: bigint;
  readonly uncompressedSize: bigint;
  readonly crc32: number;
  readonly modifiedAt: Date | undefined;
  readonly isDirectory: boolean;
  readonly unixMode: number | undefined;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  stream(): Promise<ReadableStream<Uint8Array>>;
}

interface CentralRecord {
  name: string;
  rawName: Uint8Array;
  comment: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: bigint;
  uncompressedSize: bigint;
  localOffset: bigint;
  modifiedAt: Date | undefined;
  unixMode: number | undefined;
  madeByUnix: boolean;
}

export class ZipReader {
  readonly entries: readonly ZipEntry[];
  readonly comment: string;
  /**
   * Limits in effect, defaults filled in. Per-entry limits apply on read;
   * `unzip` and `extractZip` additionally enforce the cumulative one.
   */
  readonly limits: Required<ZipLimits>;

  private constructor(entries: ZipEntry[], comment: string, limits: Required<ZipLimits>) {
    this.entries = entries;
    this.comment = comment;
    this.limits = limits;
  }

  static async open(input: ZipInput, options: ZipReaderOptions = {}): Promise<ZipReader> {
    const source = toSource(input);
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const eocd = await findEndOfCentralDirectory(source);
    const directory = await readCentralDirectory(source, eocd, options, limits);
    return new ZipReader(
      directory.map((record) =>
        makeEntry(source, record, limits, {
          maxInflateBuffer: options.maxInflateBuffer ?? DEFAULT_INFLATE_BUFFER,
          verifyCrc: options.verifyCrc ?? true,
          onCrcMismatch: options.onCrcMismatch,
        }),
      ),
      eocd.comment,
      limits,
    );
  }

  get(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name);
  }

  [Symbol.iterator](): Iterator<ZipEntry> {
    return this.entries[Symbol.iterator]();
  }
}

interface Eocd {
  entryCount: number;
  centralSize: number;
  centralOffset: number;
  /**
   * Where the central directory must stop. Bounds parsing independently of the
   * declared size, which real archivers get wrong — Info-ZIP on Windows
   * under-reports it by the length of its NTFS security extra field.
   */
  directoryEnd: number;
  /** Bytes prepended before the ZIP data; every stored offset is short by this. */
  offsetDelta: number;
  comment: string;
}

async function findEndOfCentralDirectory(source: Source): Promise<Eocd> {
  if (source.size < EOCD_SIZE) {
    throw new ZipFormatError(`file is too small to be a ZIP archive (${source.size} bytes)`);
  }
  const tailLength = Math.min(source.size, EOCD_SIZE + MAX_COMMENT_SIZE);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  // Take the last record in the file, and take it or leave it. Bytes may follow
  // the comment (self-extracting stubs, concatenated files), so the comment need
  // not end at EOF — but if it runs past EOF, stop rather than searching further
  // back. An archive can hide a second record before a deliberately truncated
  // one, and skipping to it extracts a different file than every other tool
  // sees. (Go issue 66869.)
  let at = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    if (i + EOCD_SIZE + view.getUint16(i + 20, true) > tail.length) {
      throw new ZipFormatError("end of central directory record has a truncated comment", {
        offset: tailStart + i,
      });
    }
    at = i;
    break;
  }
  if (at < 0) {
    throw new ZipFormatError("end of central directory record not found");
  }

  const r = new ByteReader(tail.subarray(at), tailStart + at);
  r.skip(4, "EOCD signature");
  const diskNumber = r.u16("disk number");
  const centralDisk = r.u16("central directory disk");
  r.u16("entries on this disk");
  let entryCount: number = r.u16("total entries");
  let centralSize: number = r.u32("central directory size");
  let centralOffset: number = r.u32("central directory offset");
  const commentLength = r.u16("comment length");
  const comment = new TextDecoder().decode(r.bytes(commentLength, "archive comment"));

  const eocdOffset = tailStart + at;
  let directoryEnd = eocdOffset;
  const zip64Present =
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32;

  // Checked for every archive: a Zip64 one can name a foreign disk just as easily.
  if (
    (diskNumber !== 0 && diskNumber !== ZIP64_SENTINEL_16) ||
    (centralDisk !== 0 && centralDisk !== ZIP64_SENTINEL_16)
  ) {
    throw new ZipUnsupportedError("split and multi-disk archives are not supported");
  }

  if (zip64Present) {
    const zip64 = await readZip64End(source, eocdOffset);
    entryCount = zip64.entryCount;
    centralSize = zip64.centralSize;
    centralOffset = zip64.centralOffset;
    directoryEnd = zip64.recordOffset;
  }

  // An empty archive has no central header to locate, so there is nothing to rebase.
  const offsetDelta =
    entryCount === 0 ? 0 : await findPrefixDelta(source, centralOffset, directoryEnd, centralSize);
  centralOffset += offsetDelta;

  if (centralOffset > directoryEnd || centralOffset > source.size) {
    throw new ZipFormatError("central directory offset is out of range", {
      offset: centralOffset,
    });
  }
  return { entryCount, centralSize, centralOffset, directoryEnd, offsetDelta, comment };
}

/**
 * Offsets are relative to the start of the ZIP data, which is not the start of
 * the file when something is prepended — a self-extracting stub, or an archive
 * appended to another file. Everything shifts by the same delta.
 */
async function findPrefixDelta(
  source: Source,
  centralOffset: number,
  directoryEnd: number,
  centralSize: number,
): Promise<number> {
  if (await hasCentralSignature(source, centralOffset)) return 0;

  // The directory ends where the trailing records begin, so working back by its
  // declared size lands on its true start.
  const candidate = directoryEnd - centralSize;
  if (candidate > centralOffset && (await hasCentralSignature(source, candidate))) {
    return candidate - centralOffset;
  }
  throw new ZipFormatError("central directory is not where the archive says it is", {
    offset: centralOffset,
  });
}

async function hasCentralSignature(source: Source, at: number): Promise<boolean> {
  if (at < 0 || at + 4 > source.size) return false;
  const bytes = await source.read(at, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === SIG_CENTRAL;
}

async function readZip64End(
  source: Source,
  eocdOffset: number,
): Promise<{
  entryCount: number;
  centralSize: number;
  centralOffset: number;
  recordOffset: number;
}> {
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  if (locatorOffset < 0) {
    throw new ZipFormatError("Zip64 locator does not fit before the EOCD", { offset: eocdOffset });
  }
  const locator = new ByteReader(
    await source.read(locatorOffset, ZIP64_LOCATOR_SIZE),
    locatorOffset,
  );
  if (locator.u32("Zip64 locator signature") !== SIG_ZIP64_LOCATOR) {
    throw new ZipFormatError("Zip64 locator signature missing", { offset: locatorOffset });
  }
  locator.u32("Zip64 EOCD disk");
  const recordOffset = toSafeInt(
    locator.u64("Zip64 EOCD offset"),
    "Zip64 EOCD offset",
    locatorOffset,
  );
  const totalDisks = locator.u32("total disks");
  if (totalDisks > 1) {
    throw new ZipUnsupportedError("split and multi-disk archives are not supported");
  }
  if (recordOffset + ZIP64_EOCD_SIZE > source.size) {
    throw new ZipFormatError("Zip64 EOCD offset is out of range", { offset: recordOffset });
  }

  const record = new ByteReader(await source.read(recordOffset, ZIP64_EOCD_SIZE), recordOffset);
  if (record.u32("Zip64 EOCD signature") !== SIG_ZIP64_EOCD) {
    throw new ZipFormatError("Zip64 EOCD signature missing", { offset: recordOffset });
  }
  record.u64("Zip64 EOCD size");
  record.u16("version made by");
  record.u16("version needed");
  record.u32("disk number");
  record.u32("central directory disk");
  record.u64("entries on this disk");
  const entryCount = toSafeInt(record.u64("total entries"), "total entries", recordOffset);
  const centralSize = toSafeInt(
    record.u64("central directory size"),
    "central directory size",
    recordOffset,
  );
  const centralOffset = toSafeInt(
    record.u64("central directory offset"),
    "central directory offset",
    recordOffset,
  );
  return { entryCount, centralSize, centralOffset, recordOffset };
}

async function readCentralDirectory(
  source: Source,
  eocd: Eocd,
  options: ZipReaderOptions,
  limits: Required<ZipLimits>,
): Promise<CentralRecord[]> {
  if (eocd.entryCount > limits.maxEntries) {
    throw new ZipSecurityError(
      `archive declares ${eocd.entryCount} entries, over the ${limits.maxEntries} limit`,
    );
  }

  // Read to the directory's hard boundary rather than the declared size: the
  // count and per-record signatures are the reliable guides, and every entry is
  // CRC-checked on read regardless.
  const window = Math.min(eocd.directoryEnd, source.size) - eocd.centralOffset;
  const bytes = await source.read(eocd.centralOffset, Math.max(window, 0));
  const r = new ByteReader(bytes, eocd.centralOffset);
  const records: CentralRecord[] = [];

  for (let i = 0; i < eocd.entryCount; i++) {
    const recordOffset = r.base + r.pos;
    if (r.u32("central header signature") !== SIG_CENTRAL) {
      throw new ZipFormatError(`central directory entry ${i} has a bad signature`, {
        offset: recordOffset,
      });
    }
    const madeBy = r.u16("version made by");
    r.u16("version needed");
    const flags = r.u16("flags");
    const method = r.u16("compression method");
    const dosTime = r.u16("modification time");
    const dosDate = r.u16("modification date");
    const crc = r.u32("crc-32");
    let compressedSize = BigInt(r.u32("compressed size"));
    let uncompressedSize = BigInt(r.u32("uncompressed size"));
    const nameLength = r.u16("file name length");
    const extraLength = r.u16("extra field length");
    const commentLength = r.u16("file comment length");
    const diskStart = r.u16("disk number start");
    r.u16("internal attributes");
    const externalAttrs = r.u32("external attributes");
    let localOffset = BigInt(r.u32("local header offset"));
    const rawName = r.bytes(nameLength, "file name").slice();
    const extra = r.bytes(extraLength, "extra field");
    const rawComment = r.bytes(commentLength, "file comment");

    if (diskStart !== 0 && diskStart !== ZIP64_SENTINEL_16) {
      throw new ZipUnsupportedError("split and multi-disk archives are not supported", {
        offset: recordOffset,
      });
    }

    const parsed = parseExtra(extra, rawName, {
      uncompressedSize: uncompressedSize === BigInt(ZIP64_SENTINEL_32),
      compressedSize: compressedSize === BigInt(ZIP64_SENTINEL_32),
      localOffset: localOffset === BigInt(ZIP64_SENTINEL_32),
    });
    // A sentinel with nothing to replace it is malformed, not a literal 0xFFFFFFFF.
    for (const [value, replacement, what] of [
      [uncompressedSize, parsed.uncompressedSize, "uncompressed size"],
      [compressedSize, parsed.compressedSize, "compressed size"],
      [localOffset, parsed.localOffset, "local header offset"],
    ] as const) {
      if (value === BigInt(ZIP64_SENTINEL_32) && replacement === undefined) {
        throw new ZipFormatError(`${what} is a Zip64 sentinel with no Zip64 extra field`, {
          entry: undecodedName(rawName),
          offset: recordOffset,
        });
      }
    }
    if (parsed.uncompressedSize !== undefined) uncompressedSize = parsed.uncompressedSize;
    if (parsed.compressedSize !== undefined) compressedSize = parsed.compressedSize;
    if (parsed.localOffset !== undefined) localOffset = parsed.localOffset;
    localOffset += BigInt(eocd.offsetDelta);

    // Preference order: the UTF-8 flag, then the Unicode Path field, then the
    // caller's encoding hint, then CP437 as APPNOTE specifies.
    const utf8Flag = (flags & FLAG_UTF8) !== 0;
    const name = utf8Flag
      ? new TextDecoder().decode(rawName)
      : (parsed.unicodePath ?? decodeName(rawName, options.filenameEncoding));
    // The flag covers the comment too, so it follows the same rules as the name.
    const comment = utf8Flag
      ? new TextDecoder().decode(rawComment)
      : decodeName(rawComment, options.filenameEncoding);
    // Creator 3 is UNIX; 19 is Darwin, which every other reader also treats as UNIX.
    const madeByUnix = madeBy >> 8 === 3 || madeBy >> 8 === 19;

    records.push({
      name,
      rawName,
      comment,
      flags,
      method,
      crc32: crc >>> 0,
      compressedSize,
      uncompressedSize,
      localOffset,
      modifiedAt: fromDosTime(dosTime, dosDate),
      unixMode: madeByUnix ? (externalAttrs >>> 16) & 0xffff : undefined,
      madeByUnix,
    });
  }
  return records;
}

interface ParsedExtra {
  uncompressedSize?: bigint;
  compressedSize?: bigint;
  localOffset?: bigint;
  /** UTF-8 name from the Info-ZIP Unicode Path field, when it is valid. */
  unicodePath?: string;
}

function undecodedName(rawName: Uint8Array): string {
  return new TextDecoder().decode(rawName);
}

function parseExtra(
  extra: Uint8Array,
  rawName: Uint8Array,
  want: { uncompressedSize: boolean; compressedSize: boolean; localOffset: boolean },
): ParsedExtra {
  const out: ParsedExtra = {};
  const r = new ByteReader(extra);
  while (r.remaining >= 4) {
    const id = r.u16("extra field id");
    const size = r.u16("extra field size");
    if (r.remaining < size) {
      throw new ZipFormatError("extra field length runs past the record");
    }
    const field = new ByteReader(r.bytes(size, "extra field payload"));

    if (id === EXTRA_ZIP64) {
      // Fields are in a fixed order and, per APPNOTE, present only for slots that
      // hold a sentinel. Some writers (Apache Commons among them) emit all three
      // regardless, so the declared size decides how to read it: taking the
      // sentinel flags on faith would read the offset out of the size's bytes.
      if (size >= 24) {
        out.uncompressedSize = field.u64("Zip64 uncompressed size");
        out.compressedSize = field.u64("Zip64 compressed size");
        out.localOffset = field.u64("Zip64 local header offset");
      } else {
        if (want.uncompressedSize) out.uncompressedSize = field.u64("Zip64 uncompressed size");
        if (want.compressedSize) out.compressedSize = field.u64("Zip64 compressed size");
        if (want.localOffset) out.localOffset = field.u64("Zip64 local header offset");
      }
    } else if (id === EXTRA_UNICODE_PATH && size > 5) {
      // 7-Zip and Windows tools write locale-encoded names with the UTF-8 flag
      // clear, and put the real name here. The CRC guards against a name field
      // rewritten by a later tool that left this field stale.
      const version = field.u8("unicode path version");
      const nameCrc = field.u32("unicode path name CRC");
      if (version === 1 && nameCrc === crc32(rawName)) {
        out.unicodePath = new TextDecoder().decode(field.bytes(size - 5, "unicode path"));
      }
    }
  }
  return out;
}

function makeEntry(
  source: Source,
  record: CentralRecord,
  limits: Required<ZipLimits>,
  {
    maxInflateBuffer,
    verifyCrc,
    onCrcMismatch,
  }: {
    maxInflateBuffer: number;
    verifyCrc: boolean;
    onCrcMismatch?: (info: CrcMismatch) => "throw" | "accept";
  },
): ZipEntry {
  const isDirectory = isDirectoryName(record.name);

  const checkReadable = (): void => {
    if ((record.flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipUnsupportedError("entry is encrypted; encryption is not supported", {
        entry: record.name,
      });
    }
    if (record.method !== METHOD_STORE && record.method !== METHOD_DEFLATE) {
      throw new ZipUnsupportedError(
        `compression method ${record.method} is not supported (only store and deflate)`,
        { entry: record.name },
      );
    }
    if (record.uncompressedSize > limits.maxEntryUncompressedSize) {
      throw new ZipSecurityError(
        `entry is ${record.uncompressedSize} bytes, over the ${limits.maxEntryUncompressedSize} limit`,
        { entry: record.name },
      );
    }
    if (
      record.compressedSize > 0n &&
      Number(record.uncompressedSize) / Number(record.compressedSize) > limits.maxCompressionRatio
    ) {
      throw new ZipSecurityError(
        `compression ratio exceeds the ${limits.maxCompressionRatio}:1 limit`,
        { entry: record.name },
      );
    }
  };

  /**
   * Most output this entry may produce. The declared size is untrusted, so it
   * bounds nothing on its own — but an entry that exceeds what it declared is
   * lying either way, and the configured limit bounds the lie.
   */
  const outputCap = (): bigint =>
    record.uncompressedSize < limits.maxEntryUncompressedSize
      ? record.uncompressedSize
      : limits.maxEntryUncompressedSize;

  const locateData = async (): Promise<{ start: number; length: number; localCrc?: number }> => {
    const { start, localCrc } = await findDataStart(source, record);
    const length = toSafeInt(record.compressedSize, "compressed size");
    if (start + length > source.size) {
      throw new ZipFormatError("entry data extends past end of file", {
        entry: record.name,
        offset: start,
      });
    }
    return { start, length, localCrc };
  };

  const readCompressed = async (): Promise<Uint8Array> => {
    const { start, length } = await locateData();
    return source.read(start, length);
  };

  /** Pulls the entry's bytes in slices, so peak memory stays independent of its size. */
  const compressedStream = async (): Promise<ReadableStream<Uint8Array>> => {
    const { start, length } = await locateData();
    let at = 0;
    return new ReadableStream({
      async pull(controller) {
        if (at >= length) return controller.close();
        const size = Math.min(READ_CHUNK, length - at);
        controller.enqueue(await source.read(start + at, size));
        at += size;
      },
    });
  };

  const entry: ZipEntry = {
    name: record.name,
    rawName: record.rawName,
    comment: record.comment,
    compressionMethod: record.method,
    compressedSize: record.compressedSize,
    uncompressedSize: record.uncompressedSize,
    crc32: record.crc32,
    modifiedAt: record.modifiedAt,
    isDirectory,
    unixMode: record.unixMode,

    async bytes(): Promise<Uint8Array> {
      if (isDirectory) return new Uint8Array(0);
      checkReadable();
      const compressed = await readCompressed();
      const cap = outputCap();

      // Composed with the entry limit, so tightening that for safety cannot
      // silently cost the memory bound. Only -1 opts out entirely.
      const ceiling =
        BigInt(maxInflateBuffer) < limits.maxEntryUncompressedSize
          ? BigInt(maxInflateBuffer)
          : limits.maxEntryUncompressedSize;
      const buffered =
        maxInflateBuffer < 0 || worstCaseInflatedSize(record.compressedSize) <= ceiling;

      const out =
        record.method === METHOD_STORE
          ? // A view into the caller's own archive would alias it and pin the
            // whole buffer. A Blob read already allocated, so it can be handed on.
            source.ownsReads
            ? compressed
            : compressed.slice()
          : buffered
            ? inflateBytes(compressed, record.name)
            : await inflateCapped(
                compressed,
                cap,
                () =>
                  new ZipSecurityError(
                    `entry inflates past its declared size of ${record.uncompressedSize} bytes`,
                    { entry: record.name },
                  ),
                record.name,
                record.uncompressedSize,
              );

      if (BigInt(out.length) !== record.uncompressedSize) {
        throw new ZipFormatError(
          `entry size mismatch: header says ${record.uncompressedSize}, got ${out.length}`,
          { entry: record.name },
        );
      }
      if (verifyCrc) {
        const actual = new Crc32().update(out).value;
        if (actual !== record.crc32) {
          const verdict = onCrcMismatch?.({
            entry: record.name,
            computed: actual,
            expected: record.crc32,
            local: (await locateData()).localCrc,
            data: out,
          });
          if (verdict !== "accept") {
            throw new ZipCrcError(
              `CRC-32 mismatch: expected ${record.crc32.toString(16)}, got ${actual.toString(16)}`,
              { entry: record.name },
            );
          }
        }
      }
      return out;
    },

    async text(): Promise<string> {
      return new TextDecoder().decode(await entry.bytes());
    },

    async stream(): Promise<ReadableStream<Uint8Array>> {
      if (isDirectory) return new Blob([]).stream();
      checkReadable();
      const raw = await compressedStream();
      const plain = record.method === METHOD_STORE ? raw : raw.pipeThrough(inflateTransform());
      return plain.pipeThrough(verifyTransform(record, outputCap(), verifyCrc, onCrcMismatch));
    },
  };
  return entry;
}

/**
 * Local header name/extra lengths can differ from the central copy, so the data
 * offset has to come from the local header itself.
 */
async function findDataStart(
  source: Source,
  record: CentralRecord,
): Promise<{ start: number; localCrc: number | undefined }> {
  const localOffset = toSafeInt(record.localOffset, "local header offset");
  if (localOffset + LOCAL_HEADER_SIZE > source.size) {
    throw new ZipFormatError("local header offset is out of range", {
      entry: record.name,
      offset: localOffset,
    });
  }
  const r = new ByteReader(await source.read(localOffset, LOCAL_HEADER_SIZE), localOffset);
  if (r.u32("local header signature") !== SIG_LOCAL) {
    throw new ZipFormatError("local header signature missing", {
      entry: record.name,
      offset: localOffset,
    });
  }
  r.skip(2, "version needed");
  r.skip(2, "flags");
  const method = r.u16("compression method");
  if (method !== record.method) {
    throw new ZipFormatError(
      `local header compression method ${method} disagrees with central ${record.method}`,
      { entry: record.name, offset: localOffset },
    );
  }
  r.skip(4, "modification time");
  // Zero here means the real value rides in the data descriptor, not that the
  // entry has no checksum.
  const localCrc = r.u32("crc-32") >>> 0;
  r.skip(4, "compressed size");
  r.skip(4, "uncompressed size");
  const nameLength = r.u16("file name length");
  const extraLength = r.u16("extra field length");
  return {
    start: localOffset + LOCAL_HEADER_SIZE + nameLength + extraLength,
    localCrc: localCrc === 0 ? undefined : localCrc,
  };
}

function verifyTransform(
  record: CentralRecord,
  cap: bigint,
  verifyCrc: boolean,
  onCrcMismatch?: (info: CrcMismatch) => "throw" | "accept",
): TransformStream<Uint8Array, Uint8Array> {
  const crc = new Crc32();
  let total = 0n;
  return new TransformStream({
    transform(chunk, controller) {
      // Before the chunk goes out, not at flush: a consumer writing to disk has
      // already spent whatever it received, so noticing at the end is too late.
      if (total + BigInt(chunk.length) > cap) {
        controller.error(
          new ZipSecurityError(
            `entry inflates past its declared size of ${record.uncompressedSize} bytes`,
            { entry: record.name },
          ),
        );
        return;
      }
      if (verifyCrc) crc.update(chunk);
      total += BigInt(chunk.length);
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (total !== record.uncompressedSize) {
        controller.error(
          new ZipFormatError(
            `entry size mismatch: header says ${record.uncompressedSize}, got ${total}`,
            { entry: record.name },
          ),
        );
        return;
      }
      if (verifyCrc && crc.value !== record.crc32) {
        const verdict = onCrcMismatch?.({
          entry: record.name,
          computed: crc.value,
          expected: record.crc32,
          local: undefined,
          data: undefined,
        });
        if (verdict === "accept") return;
        controller.error(
          new ZipCrcError(
            `CRC-32 mismatch: expected ${record.crc32.toString(16)}, got ${crc.value.toString(16)}`,
            { entry: record.name },
          ),
        );
      }
    },
  });
}

/** Reads every entry into memory. For small archives. */
export async function unzip(
  input: ZipInput,
  options?: ZipReaderOptions,
): Promise<Map<string, Uint8Array>> {
  const reader = await ZipReader.open(input, options);
  const out = new Map<string, Uint8Array>();
  const budget = new TotalSizeBudget(reader.limits.maxTotalUncompressedSize);
  for (const entry of reader.entries) {
    if (entry.isDirectory) continue;
    const bytes = await entry.bytes();
    budget.spend(bytes.length, entry.name);
    out.set(entry.name, bytes);
  }
  return out;
}

/**
 * Per-entry limits cannot catch an archive that stays under them across many
 * entries, so anything that materializes a whole archive tracks the running sum.
 */
export class TotalSizeBudget {
  #spent = 0n;

  constructor(private readonly limit: bigint) {}

  spend(bytes: number, entry?: string): void {
    this.#spent += BigInt(bytes);
    if (this.#spent > this.limit) {
      throw new ZipSecurityError(
        `total extracted size exceeds the ${this.limit} byte limit`,
        entry === undefined ? undefined : { entry },
      );
    }
  }
}
