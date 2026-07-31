import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipWriter } from "../src/index.ts";

/**
 * The README claims `stream()` holds memory near the chunk size rather than the
 * entry size. Nothing else checks it, so a refactor that quietly started
 * buffering would pass every functional test. The `bytes()` contrast is what
 * proves the measurement is able to fail.
 *
 * Each measurement runs in its own process: rss belongs to the whole process, so
 * a sibling test file allocating at the wrong moment lands in the reading.
 */

const ENTRY_SIZE = 64 * 1024 * 1024;
let dir = "";
let archive = "";
let probe = "";

const PROBE = `
import { ZipReader } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};

const [archive, mode] = Bun.argv.slice(2);

async function read() {
  const entry = (await ZipReader.open(Bun.file(archive))).get("big.bin")!;
  if (mode === "bytes") return (await entry.bytes()).length;
  let counted = 0;
  for await (const chunk of (await entry.stream()) as unknown as AsyncIterable<Uint8Array>) {
    counted += chunk.length;
  }
  return counted;
}

// Warm up first: the earliest allocations of a process grow the heap on their
// own, which would be measured as this package holding memory.
await read();

Bun.gc(true);
const before = process.memoryUsage().rss;
let peak = 0;
// The sampler collects first — rss counts pages the allocator has not returned,
// and a loop this tight outruns the collector.
const sampler = setInterval(() => {
  Bun.gc(false);
  peak = Math.max(peak, process.memoryUsage().rss - before);
}, 5);
const counted = await read();
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss - before);

console.log(JSON.stringify({ counted, peak }));
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-zipper-memory-"));
  archive = join(dir, "big.zip");
  probe = join(dir, "probe.ts");
  await writeFile(probe, PROBE);

  // Streamed and stored, so building the fixture does not need it resident either.
  const writer = new ZipWriter(Bun.file(archive).writer());
  let sent = 0;
  await writer.add(
    "big.bin",
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= ENTRY_SIZE) return c.close();
        const chunk = new Uint8Array(Math.min(1024 * 1024, ENTRY_SIZE - sent));
        sent += chunk.length;
        c.enqueue(chunk);
      },
    }),
    { compression: "store" },
  );
  await writer.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function measure(mode: "stream" | "bytes"): Promise<{ counted: number; peak: number }> {
  const child = Bun.spawn([process.execPath, probe, archive, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) throw new Error(`probe failed: ${err}`);
  return JSON.parse(out);
}

test("stream() holds chunks, not the entry", async () => {
  const { counted, peak } = await measure("stream");
  expect(counted).toBe(ENTRY_SIZE);
  // Generous: runners are noisy and the shape is the point, not the constant.
  // Measured near 1 MB, and holding the entry would land at 64.
  expect(peak).toBeLessThan(ENTRY_SIZE / 8);
}, 120_000);

test("bytes() does hold the entry, so the check above can fail", async () => {
  const { counted, peak } = await measure("bytes");
  expect(counted).toBe(ENTRY_SIZE);
  expect(peak).toBeGreaterThan(ENTRY_SIZE / 4);
}, 120_000);
