import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByteWriter } from "../src/binary.ts";
import {
  extractZip,
  MemorySink,
  sanitizeEntryPath,
  ZipCrcError,
  ZipFormatError,
  ZipReader,
  ZipSecurityError,
  ZipUnsupportedError,
  ZipWriter,
  zip,
} from "../src/index.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;

describe("ByteWriter growth", () => {
  test("bytes() lands in the grown buffer, not the discarded one", () => {
    // #reserve replaces the backing array; taking the offset after the member
    // lookup wrote into the old one.
    const w = new ByteWriter(8);
    w.bytes(new Uint8Array(64).fill(7));
    const out = w.toBytes();
    expect(out).toHaveLength(64);
    expect(out.every((b) => b === 7)).toBe(true);
  });

  test("every numeric writer survives a growth mid-write", () => {
    // Start below the total so #reserve reallocates partway through, then check
    // that nothing landed in the discarded buffer.
    const w = new ByteWriter(4);
    for (let i = 0; i < 64; i++) w.u16(i);
    for (let i = 0; i < 64; i++) w.u32(i);
    for (let i = 0; i < 64; i++) w.u64(BigInt(i));

    const out = w.toBytes();
    expect(out).toHaveLength(64 * 2 + 64 * 4 + 64 * 8);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < 64; i++) expect(view.getUint16(i * 2, true)).toBe(i);
    for (let i = 0; i < 64; i++) expect(view.getUint32(128 + i * 4, true)).toBe(i);
    for (let i = 0; i < 64; i++) expect(view.getBigUint64(384 + i * 8, true)).toBe(BigInt(i));
  });

  test("an entry comment past the initial capacity round-trips", async () => {
    const comment = "주석".repeat(100);
    const reader = await ZipReader.open(await zip({ "a.txt": { data: "x", comment } }));
    expect(reader.entries[0]!.comment).toBe(comment);
  });
});

describe("Zip64 boundaries", () => {
  // 0xFFFF is the sentinel, so an archive holding exactly that many entries
  // needs the Zip64 records even though nothing overflowed.
  test("exactly 65535 entries stays readable", async () => {
    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    for (let i = 0; i < 65_535; i++) await writer.add(`e${i}.txt`, "", { compression: "store" });
    await writer.close();

    const reader = await ZipReader.open(sink.toBytes());
    expect(reader.entries).toHaveLength(65_535);
  }, 120_000);

  test("a forced-Zip64 entry declares it in the local header too", async () => {
    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    await writer.add("s.txt", streamOf("hello"), { zip64: true, compression: "store" });
    await writer.close();
    const bytes = sink.toBytes();
    const view = new DataView(bytes.buffer);

    const local = findSignature(bytes, SIG_LOCAL);
    expect(view.getUint16(local + 4, true)).toBe(45); // version needed
    expect(view.getUint16(local + 28, true)).toBeGreaterThan(0); // extra field present

    // Descriptor width follows the header's declaration, not the actual sizes.
    const dd = findSignature(bytes, SIG_DATA_DESCRIPTOR);
    const central = findSignature(bytes, SIG_CENTRAL);
    expect(central - dd).toBe(4 + 4 + 8 + 8);

    expect(await (await ZipReader.open(bytes)).get("s.txt")!.text()).toBe("hello");
  });

  test("a sentinel with no Zip64 extra field is malformed, not a literal size", async () => {
    const archive = (await zip({ "a.txt": "hello" })).slice();
    const view = new DataView(archive.buffer);
    const central = findSignature(archive, SIG_CENTRAL);
    view.setUint32(central + 24, 0xffffffff, true); // uncompressed size slot
    await expect(ZipReader.open(archive)).rejects.toThrow();
  });
});

describe("compression choice", () => {
  /** Random bytes: deflate cannot shrink these, it can only add framing. */
  function incompressible(size: number): Uint8Array {
    let s = 99 >>> 0;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      out[i] = (s >>> 24) & 0xff;
    }
    return out;
  }

  test("auto stores what deflate would only make bigger", async () => {
    const data = incompressible(200_000);
    const reader = await ZipReader.open(await zip({ "random.bin": data }));
    const entry = reader.entries[0]!;

    expect(entry.compressionMethod).toBe(0);
    // Storing must not cost size either: the payload is the input, verbatim.
    expect(entry.compressedSize).toBe(BigInt(data.length));
    expect(await entry.bytes()).toEqual(data);
  });

  test("auto still deflates what compresses", async () => {
    const reader = await ZipReader.open(await zip({ "text.txt": "hello ".repeat(10_000) }));
    const entry = reader.entries[0]!;
    expect(entry.compressionMethod).toBe(8);
    expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize);
  });

  test("an explicit deflate is honored even when it does not pay", async () => {
    const data = incompressible(200_000);
    const reader = await ZipReader.open(
      await zip({ "random.bin": { data, compression: "deflate" } }),
    );
    expect(reader.entries[0]!.compressionMethod).toBe(8);
    expect(await reader.entries[0]!.bytes()).toEqual(data);
  });
});

describe("verifyCrc", () => {
  /** Stored entry with one payload byte flipped, so only the CRC can catch it. */
  async function corrupted(): Promise<Uint8Array> {
    const archive = (await zip({ "a.txt": { data: "hello world", compression: "store" } })).slice();
    const local = findSignature(archive, SIG_LOCAL);
    const view = new DataView(archive.buffer);
    const at = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    archive[at] = archive[at]! ^ 0xff;
    return archive;
  }

  test("on by default, so a flipped byte is caught", async () => {
    const reader = await ZipReader.open(await corrupted());
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipCrcError);
  });

  test("off returns the corrupt bytes, which is the point of the option", async () => {
    const reader = await ZipReader.open(await corrupted(), { verifyCrc: false });
    const bytes = await reader.entries[0]!.bytes();
    // Same length — a flipped byte is exactly what the size check cannot see.
    expect(bytes).toHaveLength(11);
    expect(new TextDecoder().decode(bytes)).not.toBe("hello world");
  });

  test("off still leaves the size check in place", async () => {
    const archive = (await zip({ "a.txt": "hello world" })).slice();
    const view = new DataView(archive.buffer);
    view.setUint32(findSignature(archive, SIG_CENTRAL) + 24, 999, true);
    const reader = await ZipReader.open(archive, { verifyCrc: false });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipFormatError);
  });

  test("streamed reads honor it too", async () => {
    const reader = await ZipReader.open(await corrupted(), { verifyCrc: false });
    let total = 0;
    for await (const chunk of (await reader.entries[0]!.stream()) as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
    }
    expect(total).toBe(11);
  });
});

describe("recovering from a damaged archive", () => {
  const ORIGINAL = "the quick brown fox ".repeat(200);

  /** A run of zeroed bytes, standing in for a bad sector. */
  async function damaged(): Promise<Uint8Array> {
    const archive = (await zip({ "data.txt": { data: ORIGINAL, compression: "store" } })).slice();
    const local = findSignature(archive, SIG_LOCAL);
    const view = new DataView(archive.buffer);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    for (let i = 0; i < 16; i++) archive[start + 1000 + i] = 0;
    return archive;
  }

  test("accepting the mismatch returns the salvaged bytes", async () => {
    const seen: string[] = [];
    const reader = await ZipReader.open(await damaged(), {
      onCrcMismatch: ({ entry }) => {
        seen.push(entry);
        return "accept";
      },
    });
    const bytes = await reader.entries[0]!.bytes();

    expect(seen).toEqual(["data.txt"]);
    expect(bytes).toHaveLength(ORIGINAL.length);
    // Salvaged, not repaired: the damaged run is still damaged.
    expect(new TextDecoder().decode(bytes)).not.toBe(ORIGINAL);
    expect(new TextDecoder().decode(bytes).slice(0, 100)).toBe(ORIGINAL.slice(0, 100));
  });

  test("the callback is given both header copies to judge with", async () => {
    let info: { computed: number; expected: number; local: number | undefined } | undefined;
    const reader = await ZipReader.open(await damaged(), {
      onCrcMismatch: (received) => {
        info = received;
        return "accept";
      },
    });
    await reader.entries[0]!.bytes();

    // Both headers agree, so the evidence points at the data, not at a header.
    expect(info!.local).toBe(info!.expected);
    expect(info!.computed).not.toBe(info!.expected);
  });

  test("returning throw keeps the default behavior", async () => {
    const reader = await ZipReader.open(await damaged(), { onCrcMismatch: () => "throw" });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipCrcError);
  });

  test("extraction writes the salvaged file when the mismatch is accepted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-zipper-salvage-"));
    try {
      const written = await extractZip(await damaged(), dir, {
        onCrcMismatch: () => "accept",
      });
      expect(written).toHaveLength(1);
      expect((await Bun.file(join(dir, "data.txt")).arrayBuffer()).byteLength).toBe(
        ORIGINAL.length,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a streamed read can be accepted too", async () => {
    const reader = await ZipReader.open(await damaged(), { onCrcMismatch: () => "accept" });
    let total = 0;
    for await (const chunk of (await reader.entries[0]!.stream()) as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
    }
    expect(total).toBe(ORIGINAL.length);
  });
});

describe("decompression mode", () => {
  /** Honest archive, then both headers lie the uncompressed size down to 10. */
  async function lyingArchive(): Promise<Uint8Array> {
    const archive = (await zip({ "bomb.txt": "0".repeat(4_000_000) })).slice();
    const view = new DataView(archive.buffer);
    for (const [sig, offset] of [
      [SIG_LOCAL, 22],
      [SIG_CENTRAL, 24],
    ] as const) {
      view.setUint32(findSignature(archive, sig) + offset, 10, true);
    }
    return archive;
  }

  const limits = {
    maxEntryUncompressedSize: 1000n,
    maxCompressionRatio: Number.MAX_SAFE_INTEGER,
  };

  test("streaming stops at the ceiling", async () => {
    const reader = await ZipReader.open(await lyingArchive(), {
      limits,
      maxInflateBuffer: 0,
    });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipSecurityError);
  });

  test("a tightened entry limit forces streaming even without setting the buffer", async () => {
    const reader = await ZipReader.open(await lyingArchive(), { limits });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipSecurityError);
  });

  test("buffered inflates first and only then notices — the documented trade", async () => {
    const reader = await ZipReader.open(await lyingArchive(), {
      limits,
      maxInflateBuffer: -1,
    });
    // It still fails, but on the size mismatch after the allocation, not before it.
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipFormatError);
  });

  test("all three modes agree on honest archives", async () => {
    const files = { "a.txt": "hello", "b.bin": "x".repeat(100_000) };
    const archive = await zip(files);
    const results = await Promise.all(
      [undefined, -1, 0].map(async (maxInflateBuffer) => {
        const reader = await ZipReader.open(archive, { maxInflateBuffer });
        return reader.get("b.bin")!.text();
      }),
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("x".repeat(100_000));
  });
});

describe("limits are enforced against actual output", () => {
  test("an entry that under-reports its size cannot inflate past the cap", async () => {
    // Build an honest archive, then lie about the uncompressed size in both
    // headers. Checking only the declared value would let this expand freely.
    const payload = "0".repeat(4_000_000);
    const archive = (await zip({ "bomb.txt": payload })).slice();
    const view = new DataView(archive.buffer);
    for (const [sig, offset] of [
      [SIG_LOCAL, 22],
      [SIG_CENTRAL, 24],
    ] as const) {
      view.setUint32(findSignature(archive, sig) + offset, 10, true);
    }

    const reader = await ZipReader.open(archive, {
      limits: { maxEntryUncompressedSize: 1000n, maxCompressionRatio: Number.MAX_SAFE_INTEGER },
    });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipSecurityError);
  });
});

describe("returned bytes are owned", () => {
  test("mutating the result does not corrupt the source archive", async () => {
    const archive = await zip({ "a.txt": { data: "hello", compression: "store" } });
    const first = await (await ZipReader.open(archive)).entries[0]!.bytes();
    first[0] = 0x58;
    const second = await (await ZipReader.open(archive)).entries[0]!.bytes();
    expect(new TextDecoder().decode(second)).toBe("hello");
  });
});

describe("path rules that only bite on Windows", () => {
  const rejected = [
    "important.txt:evil", // alternate data stream, invisible to an exists() check
    "CON",
    "a/NUL.txt",
    "trailing. ",
    "trailing ",
    "wild*card.txt",
    'quo"te.txt',
  ];
  for (const name of rejected) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(() => sanitizeEntryPath(name)).toThrow(ZipSecurityError);
    });
  }

  test("ordinary names with dots and dashes still pass", () => {
    for (const name of ["v1.2.3.txt", "a-b_c.txt", "한글/문서.txt", "dir/file.txt"]) {
      expect(() => sanitizeEntryPath(name)).not.toThrow();
    }
  });

  test("UNC is reported as UNC, not as an absolute path", () => {
    expect(() => sanitizeEntryPath("//server/share/f.txt")).toThrow(/UNC/);
  });
});

describe("encoding option validation", () => {
  test("an unknown filenameEncoding surfaces as a ZipError", async () => {
    const archive = (await zip({ "a.txt": "x" })).slice();
    const view = new DataView(archive.buffer);
    for (const [sig, offset] of [
      [SIG_LOCAL, 6],
      [SIG_CENTRAL, 8],
    ] as const) {
      const at = findSignature(archive, sig) + offset;
      view.setUint16(at, view.getUint16(at, true) & ~0x0800, true);
    }
    await expect(
      ZipReader.open(archive, { filenameEncoding: "definitely-not-an-encoding" }),
    ).rejects.toThrow(ZipUnsupportedError);
  });
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (view.getUint32(i, true) === signature) return i;
  }
  throw new Error(`signature ${signature.toString(16)} not found`);
}
