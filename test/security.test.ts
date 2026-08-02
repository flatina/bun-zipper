import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractZip,
  sanitizeEntryPath,
  unzip,
  ZipCrcError,
  ZipReader,
  ZipSecurityError,
  ZipUnsupportedError,
  zip,
} from "../src/index.ts";

describe("path traversal", () => {
  const rejected = [
    "../escape.txt",
    "../../escape.txt",
    "a/../../escape.txt",
    "/absolute.txt",
    "C:\\windows\\system32.txt",
    "C:/windows/system32.txt",
    "\\\\server\\share\\file.txt",
    "folder\\..\\..\\escape.txt",
    "a/b/../../../escape.txt",
    "with\0null.txt",
  ];

  for (const name of rejected) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(() => sanitizeEntryPath(name)).toThrow(ZipSecurityError);
    });
  }

  const accepted: Record<string, string> = {
    "a/b/c.txt": "a/b/c.txt",
    "./a.txt": "a.txt",
    "a//b.txt": "a/b.txt",
    "a/./b.txt": "a/b.txt",
    // Backslash is a separator on Windows, so it normalizes rather than staying literal.
    "dir\\file.txt": "dir/file.txt",
    "한글/문서.txt": "한글/문서.txt",
    "日本語/テスト.txt": "日本語/テスト.txt",
  };

  for (const [input, expected] of Object.entries(accepted)) {
    test(`normalizes ${JSON.stringify(input)}`, () => {
      expect(sanitizeEntryPath(input)).toBe(expected);
    });
  }

  test("a name that is only dots resolves to nothing and is rejected", () => {
    expect(() => sanitizeEntryPath("./././")).toThrow(ZipSecurityError);
  });
});

describe("limits", () => {
  test("entry count ceiling", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = "x";
    const archive = await zip(files);

    await expect(ZipReader.open(archive, { limits: { maxEntries: 10 } })).rejects.toThrow(
      ZipSecurityError,
    );
    expect((await ZipReader.open(archive, { limits: { maxEntries: 20 } })).entries).toHaveLength(
      20,
    );
  });

  test("compression ratio ceiling catches a bomb-shaped entry", async () => {
    // Highly compressible: a small stored size expanding to a large one.
    const archive = await zip({ "bomb.txt": "0".repeat(500_000) });
    const reader = await ZipReader.open(archive, { limits: { maxCompressionRatio: 5 } });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipSecurityError);
  });

  test("per-entry size ceiling", async () => {
    const archive = await zip({ "big.txt": "x".repeat(10_000) });
    const reader = await ZipReader.open(archive, {
      limits: { maxEntryUncompressedSize: 1000n, maxCompressionRatio: Number.MAX_SAFE_INTEGER },
    });
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipSecurityError);
  });

  test("total extracted size ceiling", async () => {
    const archive = await zip({ "a.txt": "x".repeat(5000), "b.txt": "y".repeat(5000) });
    await expect(
      unzip(archive, {
        limits: { maxTotalUncompressedSize: 6000n, maxCompressionRatio: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toThrow(ZipSecurityError);
  });
});

describe("corrupt archives", () => {
  test("truncated archive has no EOCD", async () => {
    const archive = await zip({ "a.txt": "hello" });
    await expect(ZipReader.open(archive.slice(0, archive.length - 10))).rejects.toThrow();
  });

  test("empty input is rejected", async () => {
    await expect(ZipReader.open(new Uint8Array(0))).rejects.toThrow();
  });

  test("garbage is rejected", async () => {
    await expect(ZipReader.open(new Uint8Array(200).fill(0x41))).rejects.toThrow();
  });

  test("CRC mismatch is detected", async () => {
    const archive = await zip({ "a.txt": { data: "hello world", compression: "store" } });
    // Flip a byte inside the stored payload, past the local header and name.
    const corrupted = archive.slice();
    corrupted[40] = corrupted[40]! ^ 0xff;
    const reader = await ZipReader.open(corrupted);
    // Named, so a truncation or bounds error cannot pass for CRC detection.
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipCrcError);
  });

  test("a CRC that disagrees with intact data is still a mismatch", async () => {
    // The other direction: the bytes are fine and the header lies about them.
    const archive = (await zip({ "a.txt": "hello world" })).slice();
    const view = new DataView(archive.buffer);
    view.setUint32(findCentral(archive) + 16, 0xdeadbeef, true);
    const reader = await ZipReader.open(archive);
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipCrcError);
  });

  test("a corrupt deflate payload fails rather than returning short", async () => {
    const archive = (await zip({ "a.txt": "hello world ".repeat(500) })).slice();
    const local = findSignature(archive, 0x04034b50);
    const view = new DataView(archive.buffer);
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    // Mid-stream, so the decompressor gets far enough to produce output first.
    archive[dataStart + 20] = archive[dataStart + 20]! ^ 0xff;

    const reader = await ZipReader.open(archive);
    await expect(reader.entries[0]!.bytes()).rejects.toThrow();
  });

  test("streamed reads fail on a bad CRC too", async () => {
    // stream() checks at flush, a different path from bytes().
    const archive = (await zip({ "a.txt": { data: "hello world", compression: "store" } })).slice();
    archive[40] = archive[40]! ^ 0xff;
    const reader = await ZipReader.open(archive);

    const source = await reader.entries[0]!.stream();
    await expect(
      (async () => {
        for await (const _ of source as unknown as AsyncIterable<Uint8Array>) {
          // drain
        }
      })(),
    ).rejects.toThrow(ZipCrcError);
  });

  test("extraction leaves nothing behind when the CRC fails", async () => {
    const archive = (await zip({ "a.txt": { data: "hello world", compression: "store" } })).slice();
    archive[40] = archive[40]! ^ 0xff;
    const dir = await mkdtemp(join(tmpdir(), "bun-zipper-crc-"));
    try {
      await expect(extractZip(archive, dir)).rejects.toThrow(ZipCrcError);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a comment containing an EOCD signature does not fool the scan", async () => {
    const archive = await zip({ "a.txt": "hello" }, { comment: "PK\x05\x06 trailing junk" });
    const reader = await ZipReader.open(archive);
    expect(reader.entries).toHaveLength(1);
    expect(await reader.entries[0]!.text()).toBe("hello");
  });
});

describe("streamed reads are capped too", () => {
  /** Declares 100 uncompressed bytes over a payload that inflates to 64 MB. */
  async function understated(): Promise<Uint8Array> {
    const archive = (await zip({ "bomb.bin": new Uint8Array(64 * 1024 * 1024) })).slice();
    const view = new DataView(archive.buffer);
    // The compressed size stays honest — it is how many bytes get read off disk.
    view.setUint32(findSignature(archive, 0x04034b50) + 22, 100, true);
    view.setUint32(findCentral(archive) + 24, 100, true);
    return archive;
  }

  test("the cap applies per chunk, not at the end", async () => {
    const reader = await ZipReader.open(await understated());
    const stream = (await reader.entries[0]!.stream()) as unknown as AsyncIterable<Uint8Array>;

    let delivered = 0;
    // The ratio guard compares declared sizes, so this archive walks past it.
    // Without a running cap the whole 64 MB reaches the consumer — spent disk or
    // memory — and only the flush-time size check objects.
    await expect(
      (async () => {
        for await (const chunk of stream) delivered += chunk.length;
      })(),
    ).rejects.toThrow(ZipSecurityError);
    expect(delivered).toBeLessThan(1024 * 1024);
  });
});

describe("unsupported features", () => {
  test("encrypted entries are refused with a clear error", async () => {
    const archive = await zip({ "a.txt": "hello" });
    const patched = archive.slice();
    // The reader reads flags from the central header, so that is what must be set.
    const centralFlagOffset = findCentralFlagOffset(patched);
    patched[centralFlagOffset] = patched[centralFlagOffset]! | 0x01;
    const reader = await ZipReader.open(patched);
    expect(reader.entries).toHaveLength(1);
    // Surfaced rather than only thrown, so a caller can check an archive over
    // before committing to extracting any of it.
    expect(reader.entries[0]!.isEncrypted).toBe(true);
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipUnsupportedError);
  });

  test("unknown compression method is refused", async () => {
    const archive = await zip({ "a.txt": "hello" });
    const patched = archive.slice();
    const centralFlagOffset = findCentralFlagOffset(patched);
    // Method sits two bytes after the flags in the central header.
    patched[centralFlagOffset + 2] = 14; // LZMA
    const reader = await ZipReader.open(patched);
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipUnsupportedError);
  });
});

/** Offset of the first central directory header. */
function findCentral(archive: Uint8Array): number {
  return findSignature(archive, 0x02014b50);
}

function findSignature(archive: Uint8Array, signature: number): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let i = 0; i + 4 <= archive.length; i++) {
    if (view.getUint32(i, true) === signature) return i;
  }
  throw new Error("signature not found");
}

/** Offset of the flags field in the first central directory header. */
function findCentralFlagOffset(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let i = 0; i + 4 <= archive.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) return i + 8;
  }
  throw new Error("central header not found");
}
