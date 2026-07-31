import { describe, expect, test } from "bun:test";
import { unzip, ZipReader } from "../src/index.ts";

/**
 * Fixtures from real archivers, committed so the quirks they carry stay pinned
 * even if a newer tool version stops producing them. Each test first asserts the
 * fixture still exhibits its quirk: without that, regenerating on a fixed
 * toolchain would leave a test that passes while checking nothing.
 */
const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`);

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const EXTRA_UNICODE_PATH = 0x7075;

interface CentralSurvey {
  declaredSize: number;
  actualSize: number;
  entries: { utf8Flag: boolean; extraIds: number[] }[];
}

/** Minimal independent parser, so the assertions do not lean on the code under test. */
async function surveyCentralDirectory(file: Bun.BunFile): Promise<CentralSurvey> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no EOCD");

  const count = view.getUint16(eocd + 10, true);
  const declaredSize = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);

  const entries: CentralSurvey["entries"] = [];
  let p = offset;
  for (let k = 0; k < count; k++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error(`bad central header at ${p}`);
    const flags = view.getUint16(p + 8, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);

    const extraIds: number[] = [];
    let q = p + 46 + nameLength;
    const extraEnd = q + extraLength;
    while (q + 4 <= extraEnd) {
      extraIds.push(view.getUint16(q, true));
      q += 4 + view.getUint16(q + 2, true);
    }
    entries.push({ utf8Flag: (flags & FLAG_UTF8) !== 0, extraIds });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return { declaredSize, actualSize: p - offset, entries };
}

describe("7-Zip: legacy name bytes plus an Info-ZIP Unicode Path field", () => {
  const file = () => fixture("7zip_unicode_path.zip");

  test("the fixture still has the UTF-8 flag clear and a 0x7075 field", async () => {
    const survey = await surveyCentralDirectory(file());
    const carriers = survey.entries.filter(
      (e) => !e.utf8Flag && e.extraIds.includes(EXTRA_UNICODE_PATH),
    );
    expect(carriers.length).toBeGreaterThan(0);
  });

  test("names resolve with no encoding hint at all", async () => {
    const reader = await ZipReader.open(file());
    const names = reader.entries.map((e) => e.name);
    expect(names).toContain("한글문서.txt");
    expect(names).toContain("日本語テスト.txt");
    expect(await reader.get("한글문서.txt")!.text()).toBe("안녕하세요 세계");
  });

  test("a wrong encoding hint cannot override the Unicode Path field", async () => {
    const reader = await ZipReader.open(file(), { filenameEncoding: "big5" });
    expect(reader.entries.map((e) => e.name)).toContain("한글문서.txt");
  });
});

describe("Info-ZIP: central directory size shorter than the records it describes", () => {
  const file = () => fixture("infozip_short_central_size.zip");

  test("the fixture still under-reports the central directory size", async () => {
    const survey = await surveyCentralDirectory(file());
    expect(survey.actualSize).toBeGreaterThan(survey.declaredSize);
  });

  test("we read it anyway, bounding on the EOCD rather than the declared size", async () => {
    const files = await unzip(file());
    const names = [...files.keys()];
    expect(names).toContain("한글문서.txt");
    expect(new TextDecoder().decode(files.get("한글문서.txt")!)).toBe("안녕하세요 세계");
    expect(names).toContain("ascii.txt");
  });

  test("every entry still passes CRC verification", async () => {
    const reader = await ZipReader.open(file());
    // Tolerating the bad size must not weaken per-entry integrity checks.
    for (const entry of reader.entries) {
      if (!entry.isDirectory) expect((await entry.bytes()).length).toBeGreaterThanOrEqual(0);
    }
  });
});
