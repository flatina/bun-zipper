# bun-zipper

ZIP container reader and writer for Bun. Zero runtime dependencies, ESM only, MIT.

It does not implement DEFLATE. Compression is the runtime's (`CompressionStream`,
`Bun.deflateSync`), CRC-32 is `Bun.hash.crc32`, and this package is only the
container format: headers, central directory, Zip64, extra fields, encoding, and
the safety checks around them.

Requires **Bun >= 1.3.6**. It does not run on Node.

```sh
bun add @flatina/bun-zipper
```

## Use

```ts
import { zip, unzip, ZipReader, ZipWriter, extractZip } from "@flatina/bun-zipper";

// In memory — for small archives.
const archive = await zip({
  "hello.txt": "hello",
  "데이터/설정.json": JSON.stringify({ enabled: true }),
  "raw.bin": { data: new Uint8Array([1, 2, 3]), compression: "store" },
});
await Bun.write("out.zip", archive);

const files = await unzip(Bun.file("out.zip"));
new TextDecoder().decode(files.get("hello.txt")!);
```

Streaming write, which never holds the whole archive in memory:

```ts
const writer = new ZipWriter(Bun.file("out.zip").writer());
await writer.add("small.txt", "hello");
await writer.add("large.log", Bun.file("large.log").stream());
await writer.addDirectory("empty/");
await writer.close();
```

Zip64 switches on by itself for buffered entries. A stream cannot know its size in
advance, so pass `{ zip64: true }` when one may exceed 4 GiB; without it the writer
throws instead of emitting an unreadable entry.

Reading uses the central directory, so a single entry is fetched without scanning
the archive:

```ts
const reader = await ZipReader.open(Bun.file("out.zip"));
for (const entry of reader.entries) {
  if (entry.isDirectory) continue;
  console.log(entry.name, entry.uncompressedSize);
}
const bytes = await reader.get("hello.txt")!.bytes();
```

`stream()` reads in slices, so memory follows the chunk size, not the entry size.
`bytes()` and `text()` materialise the whole entry.

```ts
for await (const chunk of await reader.get("large.log")!.stream()) {
  // CRC and length are checked as the last chunk passes, so a corrupt entry
  // fails the stream rather than returning short.
}
```

Extraction validates every path before writing:

```ts
await extractZip(Bun.file("out.zip"), "./restored", { overwrite: false });
```

## Supported

| | |
|---|---|
| Methods | store (0), deflate (8) |
| Structures | local header, central directory, EOCD, data descriptor, Zip64 EOCD + locator + extra field |
| Names | UTF-8 flag, Info-ZIP Unicode Path (`0x7075`), CP437, caller-supplied legacy encoding |
| Metadata | DOS timestamps, Unix permissions, file and archive comments |
| Integrity | CRC-32 and size verified on every read, buffered and streamed |
| Safety | path traversal, symlink, and decompression-bomb limits |

## Not supported

Encryption (ZipCrypto, AES), Deflate64, bzip2, LZMA, Zstandard, split and
multi-disk archives, appending to an existing archive, and repairing damaged
archives. Each is rejected with a specific error rather than silently mishandled.

## Compression level

`level` is honored only when the input is buffered — a string, `Uint8Array`,
`ArrayBuffer`, or `Blob` — because that path uses `Bun.deflateSync`, which takes
a level. `ReadableStream` input goes through `CompressionStream`, which has no
level parameter and behaves as level 6. Passing a level with a stream input does
nothing.

Higher is not reliably smaller — on Bun 1.3.14, level 9 beat level 6 on some
inputs and lost on others. Measure rather than assume.

## Security model

`extractZip` refuses, before writing anything:

- `..` segments, absolute paths, drive letters, UNC paths, and NUL bytes
- backslash-based variants, since Windows treats `\` as a separator
- any entry whose resolved path would land outside the destination
- entries whose Unix mode marks them a symlink
- overwriting an existing file, unless `overwrite: true`

Limits apply with safe defaults, tunable through `limits`: `maxEntries`,
`maxEntryUncompressedSize`, `maxTotalUncompressedSize`, and
`maxCompressionRatio`. The cumulative one is enforced by `unzip` and
`extractZip`, since per-entry caps alone cannot stop an archive that stays under
them across many entries. CRC and size mismatches always throw.

`extractZip` is not atomic: when it rejects partway through, files written before
that point stay on disk. Extract to a scratch directory if you need all-or-nothing.

Errors are `ZipFormatError`, `ZipUnsupportedError`, `ZipSecurityError`, and
`ZipCrcError`, all extending `ZipError`, and carry the entry name and byte offset
where known.

## Filenames

ZIP records a non-ASCII name in one of three ways, and this package reads all
three, preferring them in this order:

1. **UTF-8 flag** (general purpose bit 11) — the APPNOTE standard.
2. **Info-ZIP Unicode Path extra field** (`0x7075`) — the name field holds legacy
   bytes and the real UTF-8 name rides alongside. 7-Zip, WinRAR, and WinZip write
   this, and it interoperates better across locales than bit 11 alone.
3. **Neither** — the bytes carry no marker at all. An explicit `filenameEncoding`
   (`"shift_jis"`, `"euc-kr"`, `"gbk"`, `"big5"`, …) always wins. Without one,
   bytes that form well-formed non-ASCII UTF-8 are read as UTF-8, because macOS
   Archive Utility writes UTF-8 names and never sets bit 11; anything else falls
   back to CP437 as APPNOTE specifies. `entry.rawName` always exposes the
   original bytes so callers can decode them another way.

Writing always uses UTF-8 with bit 11 set.

```ts
// A CP932 archive from a Japanese Windows tool, with no encoding marker.
const reader = await ZipReader.open(Bun.file("legacy.zip"), {
  filenameEncoding: "shift_jis",
});
```

## Interoperability

Archives written here are verified with `unzip -t`, `7z t`, Python's
`zipfile.testzip()`, and `ugrep -z`, buffered and streamed. Archives from 7-Zip,
Info-ZIP, Python, macOS, WinRAR, and WinZip are read back, including Korean,
Japanese, Chinese, Cyrillic, Greek, Hebrew, and emoji filenames.

Awkward real-world archives that work anyway:

- **7-Zip** names in a local codepage with the UTF-8 flag clear, the real name in
  a Unicode Path extra field.
- **macOS** names stored as UTF-8 with the flag never set.
- **Info-ZIP on Windows** under-reporting the central directory size alongside
  NTFS security data.
- Archives with data **prepended** (self-extracting stubs) or **appended**.

## Size

Measured with `bun build --minify` and `gzip -9`, tree-shaken per entry point.
fflate is built from source the same way, so the two columns are comparable.

| You import | bun-zipper | fflate |
|---|---|---|
| create only | **2.9 kB** | 5.3 kB (`zipSync`) |
| read only | **5.1 kB** | 5.8 kB (`unzipSync`) |
| streaming both ways | **8.0 kB** | 7.7 kB (`Zip`/`Unzip`) |
| everything | **8.0 kB** | 12.6 kB |

Shipping no DEFLATE halves the cost of creating archives. Reading barely gains,
which answers "why is it this big without an algorithm": Zip64, prepended and
appended data, three filename-encoding paths, decompression limits, and per-entry
CRC and size verification cost about what an INFLATE implementation costs. It is
logic rather than tables — deleting the CP437 table saves 44 bytes gzipped.

Import narrowly if size decides it: `zip` alone is 2.9 kB.

## License

MIT
