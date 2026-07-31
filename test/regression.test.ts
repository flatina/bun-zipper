import { describe, expect, test } from "bun:test";
import { ByteWriter } from "../src/binary.ts";
import {
  MemorySink,
  sanitizeEntryPath,
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
