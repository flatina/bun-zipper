import { describe, expect, test } from "bun:test";
import { unzip, ZipFormatError, ZipReader, ZipUnsupportedError } from "../src/index.ts";

/**
 * Archives from other implementations' conformance corpora. Everything here is
 * something no locally installed tool can produce — macOS and WinRAR output,
 * archives with data prepended or appended, and hand-built adversarial cases.
 * See vendor/*\/LICENSE and ATTRIBUTION.md.
 */
const go = (name: string) => Bun.file(`${import.meta.dir}/fixtures/vendor/go/${name}`);
const yauzl = (name: string) => Bun.file(`${import.meta.dir}/fixtures/vendor/yauzl/${name}`);

describe("UTF-8 names across archivers", () => {
  // Every one of these holds a single entry named 世界.
  for (const producer of ["osx", "winrar", "winzip"]) {
    test(`utf8-${producer}.zip`, async () => {
      const reader = await ZipReader.open(go(`utf8-${producer}.zip`));
      expect(reader.entries.map((e) => e.name)).toEqual(["世界"]);
    });
  }

  test("macOS leaves the UTF-8 flag clear, so the bytes alone must decide", async () => {
    const bytes = new Uint8Array(await go("utf8-osx.zip").arrayBuffer());
    const view = new DataView(bytes.buffer);
    // Locate the first central header and check general purpose bit 11.
    let central = -1;
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        central = i;
        break;
      }
    }
    expect(central).toBeGreaterThan(-1);
    expect(view.getUint16(central + 8, true) & 0x0800).toBe(0);
  });
});

describe("Zip64 written by other implementations", () => {
  for (const name of ["zip64.zip", "zip64-2.zip"]) {
    test(name, async () => {
      const files = await unzip(go(name));
      expect(new TextDecoder().decode(files.get("README")!)).toContain("This small file");
    });
  }
});

describe("data outside the ZIP proper", () => {
  const EXPECTED = ["test.txt", "gophercolor16x16.png"];

  test("bytes appended after the comment", async () => {
    const reader = await ZipReader.open(go("test-trailing-junk.zip"));
    expect(reader.entries.map((e) => e.name)).toEqual(EXPECTED);
    expect(reader.comment).toBe("This is a zipfile comment.");
    expect(await reader.get("test.txt")!.text()).toBe("This is a test text file.\n");
  });

  test("bytes prepended before the local headers", async () => {
    // Stored offsets are relative to the ZIP data, not the file, so they rebase.
    const reader = await ZipReader.open(go("test-prefix.zip"));
    expect(reader.entries.map((e) => e.name)).toEqual(EXPECTED);
    expect(await reader.get("test.txt")!.text()).toBe("This is a test text file.\n");
  });

  test("a truncated comment is refused instead of falling back to an earlier record", async () => {
    // Go issue 66869: this archive hides a second EOCD before the malformed one.
    // Skipping to it would extract a different file than other tools report.
    await expect(ZipReader.open(go("comment-truncated.zip"))).rejects.toThrow(ZipFormatError);
  });
});

describe("data descriptors", () => {
  test("descriptor carrying the optional signature", async () => {
    const files = await unzip(go("go-with-datadesc-sig.zip"));
    expect(new TextDecoder().decode(files.get("foo.txt")!)).toBe("foo\n");
    expect(new TextDecoder().decode(files.get("bar.txt")!)).toBe("bar\n");
  });

  test("descriptor without a signature", async () => {
    const reader = await ZipReader.open(go("dd.zip"));
    expect(await reader.get("filename")!.text()).toBe("This is a test textfile.\n");
  });
});

describe("platform metadata", () => {
  test("Unix mode bits survive, including a read-only entry", async () => {
    const reader = await ZipReader.open(go("unix.zip"));
    // Expectations taken from Go's own table for this archive.
    expect(reader.get("hello")!.unixMode! & 0o777).toBe(0o666);
    expect(reader.get("readonly")!.unixMode! & 0o777).toBe(0o444);
    expect(reader.get("dir/empty/")!.isDirectory).toBe(true);
    expect(await reader.get("hello")!.text()).toBe("world \r\n");
  });

  test("Windows XP archive exposes the same entries", async () => {
    const reader = await ZipReader.open(go("winxp.zip"));
    expect(reader.entries.map((e) => e.name)).toContain("hello");
  });

  test("a symlink entry is readable but marked by its mode", async () => {
    const reader = await ZipReader.open(go("symlink.zip"));
    const entry = reader.get("symlink")!;
    expect((entry.unixMode! & 0o170000) === 0o120000).toBe(true);
    // The reader surfaces it; extractZip is what refuses to create it.
    expect(await entry.text()).toBe("../target");
  });

  test("duplicate directory entries are all reported", async () => {
    const reader = await ZipReader.open(go("dupdir.zip"));
    expect(reader.entries.length).toBeGreaterThan(2);
  });
});

describe("adversarial cases from yauzl", () => {
  test("Unicode Path field is ignored when the UTF-8 flag is already set", async () => {
    // The name is raw bytes 0x00-0x0F, and two 0x7075 fields (one empty, one
    // version 2) are attached. Honoring either would corrupt the name.
    const reader = await ZipReader.open(yauzl("unicode-path-extra-field.zip"));
    const expected = String.fromCharCode(...Array.from({ length: 16 }, (_, i) => i));
    expect(reader.entries[0]!.name).toBe(expected);
  });

  test("a backslash in a name is not a path separator on read", async () => {
    const reader = await ZipReader.open(yauzl("sloppy-filenames.zip"));
    expect(reader.entries.map((e) => e.name)).toContain("a\\txt");
  });

  test("traditional encryption is refused", async () => {
    const reader = await ZipReader.open(yauzl("traditional-encryption.zip"));
    await expect(reader.entries[0]!.bytes()).rejects.toThrow(ZipUnsupportedError);
  });
});
