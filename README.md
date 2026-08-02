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

## Compression

`compression` defaults to `"auto"`: deflate, and keep the result only if it came
out smaller. Already-compressed data ends up stored, which is smaller and far
cheaper to read back. `"deflate"` and `"store"` force the choice.

`level` applies to buffered input only. `ReadableStream` goes through
`CompressionStream`, which takes no level and behaves as level 6.

Higher is not reliably smaller — see [Performance](#performance) for where the
default falls short.

## Security model

`extractZip` checks the whole archive against the destination before creating so
much as the destination directory, and refuses:

- `..` segments, absolute paths, drive letters, UNC paths, and NUL bytes
- backslash-based variants, since Windows treats `\` as a separator
- any entry whose resolved path would land outside the destination
- entries whose Unix mode marks them a symlink, encrypted entries, and
  compression methods it cannot read
- two entries that extract to the same path once case and Unicode normalization
  are folded, and one name used as both a file and a directory
- declared sizes over the per-entry, ratio, or archive-wide limits
- paths that pass through a symlink or junction already in the destination —
  directories are created one component at a time so none is followed
- targets that carry other hard links: installing replaces the name rather than
  the file, so the other names would silently stop tracking this one
- overwriting an existing file, unless `overwrite: true`

Each entry is written to a temporary file beside its target and put in place only
after its CRC and size verify. With `overwrite: false` the install is `link`,
which refuses rather than replacing, so the option holds even against something
racing it; with `overwrite: true` it is `rename`. On filesystems without hard
links — FAT, exFAT, many network mounts — the first falls back to `rename`, and
there the option is only as good as the check that precedes it. Either way
nothing is written through a symlink sitting at the target.

Peak memory per entry is a block, except where the payload itself cannot exceed
one: those are inflated in a single call, which is faster. The test is what the
compressed bytes could produce, never what the header declares.

That safety costs syscalls. Extraction went from roughly three per entry to
eight, and archives of many small files are about twice as slow as they were in
0.2: 2000 × 1 KB takes 1.9 s here where it took 1.0 s. Large entries are limited
by the decompressor rather than the syscalls and cost far less.

`limits` has safe defaults: `maxEntries`, `maxEntryUncompressedSize`,
`maxTotalUncompressedSize`, `maxCompressionRatio`. `unzip` and `extractZip`
additionally enforce the cumulative one — per-entry caps cannot stop an archive
that stays under them across many entries. A size mismatch always throws; a CRC
mismatch throws unless `onCrcMismatch` says otherwise.

What preflight cannot know is what only reading reveals: a CRC or size mismatch,
a corrupt deflate stream, a local header disagreeing with the central one, or an
IO error. `extractZip` is not atomic, so those leave the entries already written
in place. The error carries an `installed` array — every path the call created,
directories included, in the order it created them, so undoing it means walking
that backwards. Extract to a scratch directory if you need all-or-nothing.

Putting an entry in place replaces the inode rather than truncating a file, so
mode, ownership and ACLs come from the new file, readers holding the old one keep
seeing it, and on Windows a target another process holds open will fail. Nothing
is fsynced: this survives a crashing process, not a power cut.

`maxInflateBuffer` caps what one inflate call may allocate; larger entries
stream instead. Lowering `maxEntryUncompressedSize` tightens it too, and `-1`
removes it.

Errors are `ZipFormatError`, `ZipUnsupportedError`, `ZipSecurityError`, and
`ZipCrcError`, all extending `ZipError`, and carry the entry name and byte offset
where known.

A CRC mismatch throws by default. `onCrcMismatch` overrides that per entry:

```ts
// Salvage what a damaged backup still holds, rather than losing all of it.
const files = await unzip(Bun.file("damaged.zip"), {
  onCrcMismatch: ({ entry, computed, expected, local }) => {
    console.warn(`${entry}: CRC ${computed.toString(16)} != ${expected.toString(16)}`);
    return "accept";
  },
});
```

`expected` is the central header's CRC and `local` the local header's copy. When
they agree the damage is in the data; when they disagree one of the headers is
the corrupt part.

`verifyCrc: false` skips the check entirely, so corruption arrives silently.

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

Minified and gzipped, tree-shaken per entry point; fflate built from source the
same way. `bun run bench/size.ts` regenerates this table.

| You import | bun-zipper | fflate |
|---|---|---|
| create only | **3.3 kB** | 5.3 kB (`zipSync`) |
| read only | **5.6 kB** | 5.8 kB (`unzipSync`) |
| streaming both ways | **7.5 kB** | 7.8 kB (`Zip`/`Unzip` plus their entry classes) |
| everything | **9.9 kB** | 12.5 kB |

Shipping no DEFLATE cuts the cost of creating archives by a third. Reading barely gains:
Zip64, prepended and appended data, three filename-encoding paths, decompression
limits, and per-entry verification cost about what an INFLATE implementation does.

## Performance

Median of 15 runs on a Ryzen 7 9800X3D, Bun 1.3.14, over the datasets fflate
benchmarks against. Reproduce with `bun run bench/bench.ts`.

| dataset | create | read | archive size |
|---|---|---|---|
| Moby Dick, 1.2 MiB text | 2.2× | 6.7× | 1.6% smaller |
| Rainier.bmp, 5.9 MiB | 2.0× | 7.5× | 6.5% larger |
| Maltese.bmp, 15.7 MiB | 2.4× | 7.2× | 14.6% larger |
| truck.3mf, already compressed | 1.4× | 5.8× | 0.3% larger |
| 10 MB incompressible | 1.3× | 1.5× | same |

fflate's `unzipSync` does not verify CRC-32, so the read column uses
`verifyCrc: false` to compare the same work. Leaving the check on costs nothing
measurable on compressed entries, where inflate dominates, and takes a stored
10 MB entry from 0.4 ms to 1.3 ms.

Bitmap images are the weak spot: Bun's zlib at its default level lands 14.6%
behind fflate on Maltese.bmp. `level: 9` ends up 0.1% ahead of it, in 265 ms
against fflate's 343 ms.

`maxInflateBuffer` decides whether a compressed entry is inflated in one call or
streamed:

| dataset | `-1` (one call) | `0` (always stream) | default |
|---|---|---|---|
| Moby Dick | 1.8 ms | 3.8 ms | 1.5 ms |
| Maltese.bmp | 23.0 ms | 51.4 ms | 23.3 ms |

## License

MIT
