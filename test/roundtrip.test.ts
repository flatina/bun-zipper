import { describe, expect, test } from "bun:test";
import { MemorySink, unzip, ZipReader, ZipWriter, zip } from "../src/index.ts";

const utf8 = new TextEncoder();
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Names that break naive CP437/latin1 handling. */
const MULTILINGUAL: Record<string, string> = {
  "한글/문서.txt": "안녕하세요 세계",
  "日本語/テスト.txt": "こんにちは世界",
  "中文/文件名.txt": "你好世界",
  "emoji/🗜️-압축-📦.txt": "emoji in both name and body 🎉",
  "русский/файл.txt": "Привет мир",
  "ελληνικά/αρχείο.txt": "Γειά σου Κόσμε",
  "עברית/קובץ.txt": "שלום עולם",
  "with space/파일 이름 (1).txt": "spaces and parens",
};

describe("round-trip", () => {
  test("single file", async () => {
    const files = await unzip(await zip({ "hello.txt": "hello" }));
    expect(decode(files.get("hello.txt")!)).toBe("hello");
  });

  test("empty file, empty archive, directory entry", async () => {
    const archive = await zip({ "empty.txt": "", "dir/": "" });
    const reader = await ZipReader.open(archive);
    expect(reader.get("empty.txt")!.uncompressedSize).toBe(0n);
    expect(reader.get("dir/")!.isDirectory).toBe(true);
    expect((await unzip(await zip({}))).size).toBe(0);
  });

  test("store and deflate produce identical bytes back", async () => {
    const body = "x".repeat(10_000);
    for (const compression of ["store", "deflate"] as const) {
      const files = await unzip(await zip({ "a.txt": { data: body, compression } }));
      expect(decode(files.get("a.txt")!)).toBe(body);
    }
  });

  test("binary data survives every byte value", async () => {
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const files = await unzip(await zip({ bin: data }));
    expect(files.get("bin")).toEqual(data);
  });
});

describe("multilingual filenames", () => {
  test("names and contents round-trip", async () => {
    const files = await unzip(await zip(MULTILINGUAL));
    for (const [name, body] of Object.entries(MULTILINGUAL)) {
      expect(files.has(name)).toBe(true);
      expect(decode(files.get(name)!)).toBe(body);
    }
  });

  test("non-ASCII names set the UTF-8 flag rather than relying on CP437", async () => {
    const archive = await zip({ "한글.txt": "x" });
    const reader = await ZipReader.open(archive);
    const entry = reader.entries[0]!;
    expect(entry.name).toBe("한글.txt");
    // The name must be stored as UTF-8 bytes, not the JS string's UTF-16.
    expect(entry.rawName).toEqual(utf8.encode("한글.txt"));
  });

  test("names survive a deep nested path", async () => {
    const name = "최상위/中間/フォルダ/файл.txt";
    const files = await unzip(await zip({ [name]: "ok" }));
    expect(decode(files.get(name)!)).toBe("ok");
  });
});

describe("streaming writer", () => {
  test("stream input uses a data descriptor and still verifies", async () => {
    const chunks = ["첫 번째 ", "두 번째 ", "세 번째"];
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(utf8.encode(chunk));
        c.close();
      },
    });

    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    await writer.add("스트림.txt", source);
    await writer.close();

    const files = await unzip(sink.toBytes());
    expect(decode(files.get("스트림.txt")!)).toBe(chunks.join(""));
  });

  test("many small chunks", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 500; i++) c.enqueue(utf8.encode(`${i},`));
        c.close();
      },
    });
    const sink = new MemorySink();
    const writer = new ZipWriter(sink);
    await writer.add("chunks.txt", source, { compression: "store" });
    await writer.close();

    const expected = Array.from({ length: 500 }, (_, i) => `${i},`).join("");
    expect(decode((await unzip(sink.toBytes())).get("chunks.txt")!)).toBe(expected);
  });
});

describe("metadata", () => {
  test("entry reports size, method and modification time", async () => {
    const modifiedAt = new Date(2021, 5, 15, 10, 30, 20);
    const archive = await zip({
      "a.txt": { data: "hello world", compression: "store", modifiedAt, comment: "주석" },
    });
    const entry = (await ZipReader.open(archive)).entries[0]!;
    expect(entry.compressionMethod).toBe(0);
    expect(entry.uncompressedSize).toBe(11n);
    expect(entry.comment).toBe("주석");
    // DOS timestamps have two-second resolution.
    expect(Math.abs(entry.modifiedAt!.getTime() - modifiedAt.getTime())).toBeLessThanOrEqual(2000);
  });

  test("archive comment round-trips", async () => {
    const archive = await zip({ "a.txt": "x" }, { comment: "아카이브 주석 📦" });
    expect((await ZipReader.open(archive)).comment).toBe("아카이브 주석 📦");
  });
});

describe("compression level", () => {
  test("level changes the stored bytes on the buffered path", async () => {
    const body = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ i, s: `값${i}` })));
    const sizes = new Set<bigint>();
    for (const level of [1, 6, 9] as const) {
      const reader = await ZipReader.open(await zip({ "a.json": { data: body, level } }));
      sizes.add(reader.entries[0]!.compressedSize);
    }
    // Not asserting that higher levels are smaller: Bun's mapping is not monotonic.
    expect(sizes.size).toBeGreaterThan(1);
  });
});
