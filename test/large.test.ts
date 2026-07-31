import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipReader, ZipWriter } from "../src/index.ts";

/**
 * Writes and reads a single entry past the 4 GiB boundary, the only place the
 * per-entry Zip64 path can be exercised for real. It moves several gigabytes
 * through deflate, so it is opt-in: `bun run test:large`.
 */
const ENABLED = process.env.BUN_ZIPPER_LARGE === "1";
if (!ENABLED) {
  console.warn("[large] SKIPPING >4 GiB Zip64 checks — set BUN_ZIPPER_LARGE=1 to run them");
}

const UINT32_MAX = 0xffffffffn;
/** Just over the boundary, so the test proves the crossing rather than a round number. */
const TARGET = UINT32_MAX + 1024n * 1024n;
const CHUNK = 1024 * 1024 * 8;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const EXTRA_ZIP64 = 0x0001;

let dir = "";

beforeAll(async () => {
  if (ENABLED) dir = await mkdtemp(join(tmpdir(), "bun-zipper-large-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * Compressible, but not so compressible that the archive stops resembling real
 * data: a fixed pattern with a varying byte keeps the ratio near 100:1 rather
 * than the ~1000:1 that a run of zeros would hit.
 */
function patternedSource(total: bigint): ReadableStream<Uint8Array> {
  let written = 0n;
  let counter = 0;
  return new ReadableStream({
    pull(controller) {
      if (written >= total) return controller.close();
      const size = Number(total - written < BigInt(CHUNK) ? total - written : BigInt(CHUNK));
      const chunk = new Uint8Array(size);
      for (let i = 0; i < size; i += 64) {
        chunk[i] = counter++ & 0xff;
      }
      written += BigInt(size);
      controller.enqueue(chunk);
    },
  });
}

describe.if(ENABLED)("entry larger than 4 GiB", () => {
  let archive = "";

  beforeAll(async () => {
    archive = join(dir, "large.zip");
    const writer = new ZipWriter(Bun.file(archive).writer({ highWaterMark: CHUNK }));
    await writer.add("big.bin", patternedSource(TARGET), { zip64: true });
    await writer.add("small.txt", "sentinel");
    await writer.close();
  }, 1_800_000);

  test("the archive is far smaller than the payload", async () => {
    const onDisk = (await stat(archive)).size;
    expect(BigInt(onDisk)).toBeLessThan(TARGET);
  });

  test("local header and central record both declare Zip64", async () => {
    const head = new Uint8Array(await Bun.file(archive).slice(0, 512).arrayBuffer());
    const view = new DataView(head.buffer);
    expect(view.getUint32(0, true)).toBe(SIG_LOCAL);
    expect(view.getUint16(4, true)).toBe(45);

    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(extraLength).toBeGreaterThan(0);
    expect(view.getUint16(30 + nameLength, true)).toBe(EXTRA_ZIP64);
  });

  test("sizes survive the round trip", async () => {
    const reader = await ZipReader.open(Bun.file(archive));
    const entry = reader.get("big.bin")!;
    expect(entry.uncompressedSize).toBe(TARGET);
    expect(entry.uncompressedSize).toBeGreaterThan(UINT32_MAX);
    // A 32-bit field would have wrapped this to a small number.
    expect(entry.compressedSize).toBeGreaterThan(0n);
    expect(await reader.get("small.txt")!.text()).toBe("sentinel");
  });

  test("the central record stores the size as a Zip64 sentinel", async () => {
    const size = (await stat(archive)).size;
    const tail = new Uint8Array(
      await Bun.file(archive)
        .slice(Math.max(0, size - 65_557), size)
        .arrayBuffer(),
    );
    const view = new DataView(tail.buffer);
    let central = -1;
    for (let i = 0; i + 4 <= tail.length; i++) {
      if (view.getUint32(i, true) === SIG_CENTRAL) {
        central = i;
        break;
      }
    }
    expect(central).toBeGreaterThan(-1);
    expect(view.getUint32(central + 24, true)).toBe(0xffffffff);
  });

  test("streaming the entry back verifies CRC over every byte", async () => {
    const reader = await ZipReader.open(Bun.file(archive), {
      limits: { maxEntryUncompressedSize: TARGET + 1n },
    });
    // stream() fails the stream on a CRC or length mismatch at flush time, so
    // draining it to completion is the verification.
    const source = await reader.get("big.bin")!.stream();
    let total = 0n;
    for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
      total += BigInt(chunk.length);
    }
    expect(total).toBe(TARGET);
  }, 1_800_000);

  test("external tools accept it", async () => {
    const sevenZip = Bun.which("7z");
    if (!sevenZip) {
      console.warn("[large] SKIPPING 7z verification: not installed");
      return;
    }
    const proc = Bun.spawn(["7z", "t", archive], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toContain("Everything is Ok");
  }, 1_800_000);
});

describe.if(ENABLED)("streaming past 4 GiB without opting into Zip64", () => {
  test("fails loudly instead of writing an entry no reader can parse", async () => {
    const path = join(dir, "overflow.zip");
    const writer = new ZipWriter(Bun.file(path).writer({ highWaterMark: CHUNK }));
    // No zip64 flag: the local header is already 32-bit by the time the size is known.
    await expect(writer.add("big.bin", patternedSource(TARGET))).rejects.toThrow(/zip64/i);
  }, 1_800_000);
});
