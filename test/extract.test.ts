import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractZip,
  MemorySink,
  ZipCrcError,
  ZipError,
  ZipSecurityError,
  ZipWriter,
  zip,
} from "../src/index.ts";

/** Offset of the first central directory header. */
function findCentralOffset(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let i = 0; i + 4 <= archive.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) return i;
  }
  throw new Error("central header not found");
}

/** First offset where `needle` occurs, for reaching into a built archive. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  throw new Error("not found");
}

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-zipper-extract-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("extractZip", () => {
  test("writes nested files and directories, including non-ASCII names", async () => {
    const archive = await zip({
      "한글/문서.txt": "안녕하세요",
      "日本語/テスト.txt": "こんにちは",
      "a/b/c/deep.txt": "deep",
      "root.txt": "root",
      "빈폴더/": "",
    });

    const written = await extractZip(archive, dir);
    expect(written).toHaveLength(4);

    expect(await Bun.file(join(dir, "한글/문서.txt")).text()).toBe("안녕하세요");
    expect(await Bun.file(join(dir, "日本語/テスト.txt")).text()).toBe("こんにちは");
    expect(await Bun.file(join(dir, "a/b/c/deep.txt")).text()).toBe("deep");
    expect(await Bun.file(join(dir, "root.txt")).text()).toBe("root");
    expect(await readdir(join(dir, "빈폴더"))).toEqual([]);
  });

  test("refuses to overwrite unless asked", async () => {
    const archive = await zip({ "a.txt": "second" });
    await Bun.write(join(dir, "a.txt"), "first");

    await expect(extractZip(archive, dir)).rejects.toThrow(ZipSecurityError);
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("first");

    await extractZip(archive, dir, { overwrite: true });
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("second");
  });

  test("the cumulative size limit applies, not just the per-entry one", async () => {
    // Each entry is well under any per-entry cap; only the running total catches this.
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = "x".repeat(2000);
    const archive = await zip(files);

    await expect(
      extractZip(archive, dir, {
        limits: {
          maxTotalUncompressedSize: 5000n,
          maxCompressionRatio: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).rejects.toThrow(ZipSecurityError);
  });

  test("a directory in the way reports the collision, not a raw fs error", async () => {
    // The subdirectory pushes the parent's POSIX link count to 3, which is what
    // made the hard-link check fire here instead of the collision one.
    await extractZip(await zip({ "a/keep.txt": "x", "a/sub/deep.txt": "y" }), dir);
    await expect(extractZip(await zip({ a: "clobber" }), dir, { overwrite: true })).rejects.toThrow(
      /exists as a directory/,
    );
  });

  test("a failed entry leaves neither a partial file nor a temp behind", async () => {
    // CRC is verified before anything is installed under its real name, and the
    // temp the bytes passed through has to go with the failure.
    const archive = (
      await zip({
        "ok.txt": { data: "first", compression: "store" },
        "bad.bin": { data: "x".repeat(4096), compression: "store" },
      })
    ).slice();

    // Local header: 30 fixed bytes, then the name. Find the name to reach the payload.
    const nameAt = indexOfBytes(archive, new TextEncoder().encode("bad.bin"));
    const view = new DataView(archive.buffer);
    const header = nameAt - 30;
    const payload = nameAt + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    archive[payload] = archive[payload]! ^ 0xff;

    await expect(extractZip(archive, dir)).rejects.toThrow(ZipCrcError);
    expect(await readdir(dir)).toEqual(["ok.txt"]);
  });

  test("nothing is left over when extraction succeeds", async () => {
    await extractZip(await zip({ "a.txt": "x", "d/b.txt": "y" }), dir);
    expect((await readdir(dir)).sort()).toEqual(["a.txt", "d"]);
    expect(await readdir(join(dir, "d"))).toEqual(["b.txt"]);
  });

  test("an entry past the block size round-trips through the streamed path", async () => {
    // Incompressible, so it stays over the block size on disk as well as in
    // memory and does not trip the ratio limit.
    const big = new Uint8Array(3 * 1024 * 1024);
    let s = 7;
    for (let i = 0; i < big.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      big[i] = (s >>> 24) & 0xff;
    }
    await extractZip(await zip({ "big.bin": big }), dir);
    expect(await Bun.file(join(dir, "big.bin")).bytes()).toEqual(big);
  });

  test("a bad entry stops the extraction before any entry is written", async () => {
    // The point of preflighting: entry 1 is fine, entry 2 is not, and neither
    // lands. The destination itself is not created either.
    const target = join(dir, "into");
    const archive = await zip({ "fine.txt": "x", "../escape.txt": "no" });
    await expect(extractZip(archive, target)).rejects.toThrow(ZipSecurityError);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("paths that collide only by case or normalization are refused", async () => {
    for (const names of [
      ["a.txt", "A.TXT"],
      ["café.txt".normalize("NFC"), "café.txt".normalize("NFD")],
    ]) {
      const sink = new MemorySink();
      const writer = new ZipWriter(sink);
      for (const name of names) await writer.add(name, "x");
      await writer.close();
      await expect(extractZip(sink.toBytes(), dir)).rejects.toThrow(/same path/);
    }
  });

  test("a deeply nested name costs its own length, not its length squared", async () => {
    // 16,000 components is a legal ZIP name. Keeping every growing prefix of it
    // cost the better part of a gigabyte for this one entry.
    const name = `${Array.from({ length: 16_000 }, () => "a").join("/")}/f.txt`;
    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    await writer.add(name, "x");
    // Refused during preflight, so the cost measured is deciding about the name
    // rather than creating 16,000 directories on disk.
    await writer.add("../escape.txt", "x");
    await writer.close();

    Bun.gc(true);
    const before = process.memoryUsage().rss;
    await expect(extractZip(sink.toBytes(), join(dir, "deep"))).rejects.toThrow(ZipSecurityError);
    expect(process.memoryUsage().rss - before).toBeLessThan(64 * 1024 * 1024);
  });

  test("a name used as both a file and a directory is refused", async () => {
    await expect(extractZip(await zip({ a: "file", "a/b.txt": "child" }), dir)).rejects.toThrow(
      /both a file and a directory/,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  test("an archive that declares more than the total limit never starts", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = "x".repeat(2000);
    await expect(
      extractZip(await zip(files), dir, {
        limits: { maxTotalUncompressedSize: 5000n, maxCompressionRatio: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toThrow(ZipSecurityError);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a mid-extraction failure reports the directories it made, not only files", async () => {
    // Corrupt the payload of the entry that sorts last, so the first one and the
    // directories are already on disk when it fails.
    const archive = (
      await zip({
        "d/first.txt": { data: "kept", compression: "store" },
        "d/second.bin": { data: "y".repeat(2048), compression: "store" },
      })
    ).slice();
    const nameAt = indexOfBytes(archive, new TextEncoder().encode("d/second.bin"));
    const view = new DataView(archive.buffer);
    const header = nameAt - 30;
    const payload = nameAt + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
    archive[payload] = archive[payload]! ^ 0xff;

    let error: ZipCrcError | undefined;
    await extractZip(archive, join(dir, "into")).catch((e) => {
      error = e as ZipCrcError;
    });

    // Cleaning up only the files would leave "into" and "into/d" behind.
    expect(error?.installed).toEqual([
      join(dir, "into"),
      join(dir, "into", "d"),
      join(dir, "into", "d", "first.txt"),
    ]);
  });

  test("a streamed entry that fails leaves nothing, not even the temp", async () => {
    // Over the block size, so this is the streaming arm — the other CRC tests
    // are all small enough to take the single-inflate one.
    const big = new Uint8Array(3 * 1024 * 1024);
    let s = 7;
    for (let i = 0; i < big.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      big[i] = (s >>> 24) & 0xff;
    }
    const archive = (await zip({ "big.bin": { data: big, compression: "store" } })).slice();
    const nameAt = indexOfBytes(archive, new TextEncoder().encode("big.bin"));
    const view = new DataView(archive.buffer);
    const payload =
      nameAt + view.getUint16(nameAt - 30 + 26, true) + view.getUint16(nameAt - 30 + 28, true);
    archive[payload + 1024] = archive[payload + 1024]! ^ 0xff;

    await expect(extractZip(archive, dir)).rejects.toThrow(ZipCrcError);
    expect(await readdir(dir)).toEqual([]);
  });

  test("the declared size does not decide how much memory an entry may take", async () => {
    // A tiny archive claiming a tiny entry, whose payload inflates to far more.
    // Choosing the buffered read on that claim hands the peak to the archive.
    const archive = (await zip({ "bomb.bin": new Uint8Array(32 * 1024 * 1024) })).slice();
    const view = new DataView(archive.buffer);
    view.setUint32(
      indexOfBytes(archive, new TextEncoder().encode("bomb.bin")) - 30 + 22,
      100,
      true,
    );
    view.setUint32(findCentralOffset(archive) + 24, 100, true);

    await expect(extractZip(archive, dir)).rejects.toThrow(ZipSecurityError);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a failure reports what it already wrote", async () => {
    await Bun.write(join(dir, "second.txt"), "existing");
    let error: ZipSecurityError | undefined;
    await extractZip(await zip({ "first.txt": "a", "second.txt": "b" }), dir).catch((e) => {
      error = e as ZipSecurityError;
    });
    // Refused at preflight, so nothing was written and nothing is claimed.
    expect(error?.installed ?? []).toEqual([]);
  });

  test("a destination reached through a symlink is legal", async () => {
    // macOS resolves /tmp through one, so refusing this would refuse the most
    // ordinary destination there is. Only components *under* the root are barred.
    const real = await mkdtemp(join(tmpdir(), "bun-zipper-real-"));
    try {
      await symlink(real, join(dir, "via"), "junction");
      await extractZip(await zip({ "a/b.txt": "x" }), join(dir, "via", "out"));
      expect(await Bun.file(join(real, "out", "a", "b.txt")).text()).toBe("x");
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });

  test("a destination several levels deep is created, and only then", async () => {
    const deep = join(dir, "one", "two", "three");
    await extractZip(await zip({ "f.txt": "x" }), deep);
    expect(await Bun.file(join(deep, "f.txt")).text()).toBe("x");
  });

  test("a destination that is a file is refused before anything else happens", async () => {
    await Bun.write(join(dir, "occupied"), "i am a file");
    await expect(extractZip(await zip({ "a.txt": "x" }), join(dir, "occupied"))).rejects.toThrow(
      /not a directory/,
    );
  });

  test("installed rides on whatever was thrown, and never replaces it", async () => {
    await Bun.write(join(dir, "occupied"), "x");
    // A ZipError from before the write loop.
    let refusal: ZipError | undefined;
    await extractZip(await zip({ "a.txt": "x" }), join(dir, "occupied")).catch((e) => {
      refusal = e as ZipError;
    });
    expect(refusal).toBeInstanceOf(ZipError);
    expect(refusal?.installed).toEqual([]);

    // Something the caller threw that cannot carry the annotation. Losing the
    // list is a nuisance; losing their error would hide why it stopped.
    const frozen = Object.freeze(new Error("from the filter"));
    let thrown: unknown;
    await extractZip(await zip({ "a.txt": "x" }), join(dir, "out"), {
      filter: () => {
        throw frozen;
      },
    }).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBe(frozen);
    expect((thrown as Error).message).toBe("from the filter");

    // And a primitive, which has nowhere to put it either.
    let primitive: unknown;
    await extractZip(await zip({ "a.txt": "x" }), join(dir, "out2"), {
      filter: () => {
        throw "a string";
      },
    }).catch((e) => {
      primitive = e;
    });
    expect(primitive).toBe("a string");
  });

  test("filter is consulted once per entry", async () => {
    const seen: string[] = [];
    await extractZip(await zip({ "a.txt": "1", "b.txt": "2" }), dir, {
      filter: (entry) => {
        seen.push(entry.name);
        return entry.name === "a.txt";
      },
    });
    expect(seen).toEqual(["a.txt", "b.txt"]);
  });

  test("filter skips entries", async () => {
    const archive = await zip({ "keep.txt": "yes", "skip.bin": "no" });
    const written = await extractZip(archive, dir, {
      filter: (entry) => entry.name.endsWith(".txt"),
    });
    expect(written).toHaveLength(1);
    expect(await Bun.file(join(dir, "skip.bin")).exists()).toBe(false);
  });
});

describe("extractZip rejects hostile archives", () => {
  /** The writer does not sanitize, so a traversal name can be built directly. */
  async function archiveWithName(name: string, unixMode?: number): Promise<Uint8Array> {
    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    await writer.add(name, "payload", unixMode === undefined ? {} : { unixMode });
    await writer.close();
    return sink.toBytes();
  }

  for (const name of ["../escape.txt", "../../escape.txt", "a/../../escape.txt"]) {
    test(`traversal via ${JSON.stringify(name)}`, async () => {
      await expect(extractZip(await archiveWithName(name), dir)).rejects.toThrow(ZipSecurityError);
    });
  }

  test("absolute path", async () => {
    await expect(extractZip(await archiveWithName("/etc/passwd"), dir)).rejects.toThrow(
      ZipSecurityError,
    );
  });

  test("backslash traversal", async () => {
    await expect(extractZip(await archiveWithName("a\\..\\..\\escape.txt"), dir)).rejects.toThrow(
      ZipSecurityError,
    );
  });

  test("symlink entry is refused rather than followed", async () => {
    // 0o120777: S_IFLNK plus permissions, the mode a symlink entry carries.
    const archive = await archiveWithName("link", 0o120777);
    await expect(extractZip(archive, dir)).rejects.toThrow(ZipSecurityError);
  });

  describe("links already in the destination", () => {
    let outside = "";

    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), "bun-zipper-outside-"));
    });

    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    // A junction is what Windows can create without privileges; the type
    // argument is ignored elsewhere, where this is a plain symlink. Both are
    // what a recursive mkdir would happily follow.
    const linkTo = (target: string, path: string) => symlink(target, path, "junction");

    test("a directory entry cannot build through a link", async () => {
      await linkTo(outside, join(dir, "link"));
      await expect(extractZip(await zip({ "link/newdir/": "" }), dir)).rejects.toThrow(
        ZipSecurityError,
      );
      expect(await readdir(outside)).toEqual([]);
    });

    test("a file entry cannot build its parents through a link", async () => {
      await linkTo(outside, join(dir, "link"));
      await expect(extractZip(await zip({ "link/deep/f.txt": "x" }), dir)).rejects.toThrow(
        ZipSecurityError,
      );
      expect(await readdir(outside)).toEqual([]);
    });

    test("a hard link to a file outside is refused rather than written through", async () => {
      // lstat cannot see where the other names for this inode are, and writing
      // through one edits all of them.
      const secret = join(outside, "secret.txt");
      await Bun.write(secret, "original");
      await link(secret, join(dir, "a.txt"));

      await expect(
        extractZip(await zip({ "a.txt": "payload" }), dir, { overwrite: true }),
      ).rejects.toThrow(ZipSecurityError);
      expect(await Bun.file(secret).text()).toBe("original");
    });

    test("a linked target path is refused rather than written through", async () => {
      await linkTo(outside, join(dir, "a"));
      // overwrite: true, so this is the link check refusing and not the clobber check.
      await expect(
        extractZip(await zip({ a: "payload" }), dir, { overwrite: true }),
      ).rejects.toThrow(ZipSecurityError);
      expect(await readdir(outside)).toEqual([]);
    });
  });

  test("nothing escaped the destination", async () => {
    for (const name of ["../escape.txt", "/etc/passwd", "a\\..\\..\\escape.txt"]) {
      await extractZip(await archiveWithName(name), dir).catch(() => {});
    }
    expect(await Bun.file(join(dir, "..", "escape.txt")).exists()).toBe(false);
  });
});
