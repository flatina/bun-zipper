import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, MemorySink, ZipSecurityError, ZipWriter, zip } from "../src/index.ts";

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
    await extractZip(await zip({ "a/keep.txt": "x" }), dir);
    await expect(extractZip(await zip({ a: "clobber" }), dir, { overwrite: true })).rejects.toThrow(
      /exists as a directory/,
    );
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
