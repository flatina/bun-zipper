import { describe, expect, test } from "bun:test";
import { ZipReader, zip } from "../src/index.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const FLAG_UTF8 = 0x0800;

/** "한글.txt" in CP949 — what Windows archivers store without the UTF-8 flag. */
const CP949_NAME = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb, 0x2e, 0x74, 0x78, 0x74]);
/** Same byte length, so it can be swapped in without moving any offsets. */
const PLACEHOLDER = "AABB.txt";

/**
 * Our writer always emits UTF-8 with the flag set, so a legacy-encoded archive
 * has to be built by patching: swap the name bytes and clear bit 11.
 */
async function legacyEncodedArchive(): Promise<Uint8Array> {
  const archive = (await zip({ [PLACEHOLDER]: "본문" })).slice();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const placeholderBytes = new TextEncoder().encode(PLACEHOLDER);

  let patchedNames = 0;
  let clearedFlags = 0;
  for (let i = 0; i + 4 <= archive.length; i++) {
    const sig = view.getUint32(i, true);
    const flagOffset = sig === SIG_LOCAL ? i + 6 : sig === SIG_CENTRAL ? i + 8 : -1;
    if (flagOffset < 0) continue;
    view.setUint16(flagOffset, view.getUint16(flagOffset, true) & ~FLAG_UTF8, true);
    clearedFlags++;
  }
  for (let i = 0; i + placeholderBytes.length <= archive.length; i++) {
    if (placeholderBytes.every((b, k) => archive[i + k] === b)) {
      archive.set(CP949_NAME, i);
      patchedNames++;
    }
  }
  // Guard the fixture itself: a silent no-op patch would make the tests vacuous.
  expect(clearedFlags).toBe(2);
  expect(patchedNames).toBe(2);
  return archive;
}

describe("names without the UTF-8 flag", () => {
  test("default decoding follows APPNOTE and uses CP437", async () => {
    const reader = await ZipReader.open(await legacyEncodedArchive());
    const entry = reader.entries[0]!;
    // CP437 cannot represent Hangul, so this is mojibake by design, not a bug.
    expect(entry.name).not.toBe("한글.txt");
    expect(entry.name.endsWith(".txt")).toBe(true);
    expect(entry.rawName).toEqual(CP949_NAME);
  });

  test("filenameEncoding recovers the real name", async () => {
    const reader = await ZipReader.open(await legacyEncodedArchive(), {
      filenameEncoding: "euc-kr",
    });
    expect(reader.entries[0]!.name).toBe("한글.txt");
    expect(await reader.entries[0]!.text()).toBe("본문");
  });

  test("raw bytes are always available for callers to decode themselves", async () => {
    const reader = await ZipReader.open(await legacyEncodedArchive());
    const decoded = new TextDecoder("euc-kr" as "utf-8").decode(reader.entries[0]!.rawName);
    expect(decoded).toBe("한글.txt");
  });
});

describe("names with the UTF-8 flag", () => {
  test("filenameEncoding is ignored when the flag is set", async () => {
    const archive = await zip({ "한글.txt": "x" });
    // A wrong hint must not corrupt a correctly flagged name.
    const reader = await ZipReader.open(archive, { filenameEncoding: "shift_jis" });
    expect(reader.entries[0]!.name).toBe("한글.txt");
  });
});

describe("Japanese fixtures", () => {
  const JAPANESE_NAMES = [
    "日本語.txt",
    "テスト/資料.txt",
    // Half-width katakana are single bytes in CP932's 0xA1-0xDF range.
    "半角ｶﾅ.txt",
    "長いファイル名_あいうえお_漢字.txt",
  ];

  const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`);

  test("UTF-8 flagged archive needs no hint", async () => {
    const reader = await ZipReader.open(fixture("japanese_filenames_utf8.zip"));
    expect(reader.entries.map((e) => e.name)).toEqual(JAPANESE_NAMES);
    for (const entry of reader.entries) expect((await entry.text()).length).toBeGreaterThan(0);
  });

  test("CP932 archive carries no encoding marker, so the default cannot recover it", async () => {
    const reader = await ZipReader.open(fixture("japanese_filenames_cp932_legacy.zip"));
    // CP437 is the specified default; these names are simply unrecoverable without a hint.
    expect(reader.entries.map((e) => e.name)).not.toEqual(JAPANESE_NAMES);
    expect(reader.entries).toHaveLength(4);
  });

  test("CP932 archive resolves with a shift_jis hint", async () => {
    const reader = await ZipReader.open(fixture("japanese_filenames_cp932_legacy.zip"), {
      filenameEncoding: "shift_jis",
    });
    expect(reader.entries.map((e) => e.name)).toEqual(JAPANESE_NAMES);
  });

  test("both fixtures hold identical content under their differing names", async () => {
    const utf8 = await ZipReader.open(fixture("japanese_filenames_utf8.zip"));
    const legacy = await ZipReader.open(fixture("japanese_filenames_cp932_legacy.zip"), {
      filenameEncoding: "shift_jis",
    });
    for (const name of JAPANESE_NAMES) {
      expect(await legacy.get(name)!.text()).toBe(await utf8.get(name)!.text());
    }
  });
});
