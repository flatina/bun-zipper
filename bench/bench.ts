/**
 * bun run bench/bench.ts
 *
 * Compares against fflate, which implements DEFLATE in JavaScript while this
 * package delegates to Bun's native zlib. Compression ratio is reported next to
 * throughput because a faster archiver that compresses worse is not faster at
 * the job. Both sides use their defaults, which are level 6 either way.
 */
import { unzipSync, zipSync } from "fflate";
import { loadCorpus } from "./corpus.ts";
import { unzip, zip } from "../src/index.ts";

interface Dataset {
  name: string;
  files: Record<string, Uint8Array>;
  bytes: number;
}

const utf8 = new TextEncoder();

function dataset(name: string, files: Record<string, Uint8Array>): Dataset {
  return { name, files, bytes: Object.values(files).reduce((n, b) => n + b.length, 0) };
}

/** Deterministic pseudo-random, so runs are comparable across machines. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Text with the redundancy of real source, around 3.5:1. A small vocabulary
 * compresses near 7:1 and stops measuring anything useful — at that redundancy
 * the implementations diverge on long-range matching rather than on throughput.
 */
function prose(sizeBytes: number, seed: number): Uint8Array {
  const rng = random(seed);
  const vocabulary: string[] = [];
  for (let i = 0; i < 400; i++) {
    let word = "";
    const length = 3 + Math.floor(rng() * 9);
    for (let k = 0; k < length; k++) word += String.fromCharCode(97 + Math.floor(rng() * 26));
    vocabulary.push(word);
  }

  const parts: string[] = [];
  let total = 0;
  while (total < sizeBytes) {
    // Occasional unique tokens, so not every byte has a match behind it.
    const line =
      rng() < 0.15
        ? `${Math.floor(rng() * 1e9).toString(36)} ${vocabulary[Math.floor(rng() * 400)]}`
        : Array.from({ length: 3 + Math.floor(rng() * 9) }, () => vocabulary[Math.floor(rng() * 400)]).join(" ");
    parts.push(line);
    total += line.length + 1;
  }
  return utf8.encode(parts.join("\n").slice(0, sizeBytes));
}

function incompressible(sizeBytes: number, seed: number): Uint8Array {
  const rng = random(seed);
  const out = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) out[i] = (rng() * 256) | 0;
  return out;
}

const manySmall: Record<string, Uint8Array> = {};
for (let i = 0; i < 500; i++) manySmall[`docs/file-${i}.txt`] = prose(2048, i + 1);

console.log("corpus:");
const real = await loadCorpus(["text", "smallImage", "image", "model3D"]);

const DATASETS: Dataset[] = [
  dataset("500 small text files", manySmall),
  dataset("one 20 MB text file", { "big.txt": prose(20 * 1024 * 1024, 7) }),
  dataset("10 MB incompressible", { "random.bin": incompressible(10 * 1024 * 1024, 11) }),
  // fflate's own corpus, so these rows are comparable to its published numbers.
  ...(real.text ? [dataset("Moby Dick (text)", { "moby.txt": real.text })] : []),
  ...(real.smallImage ? [dataset("Rainier.bmp (image)", { "rainier.bmp": real.smallImage })] : []),
  ...(real.image ? [dataset("Maltese.bmp (image)", { "maltese.bmp": real.image })] : []),
  ...(real.model3D ? [dataset("truck.3mf (compressed already)", { "truck.3mf": real.model3D })] : []),
];

// Enough samples that the sub-millisecond rows are not reporting allocator noise.
const RUNS = 15;

async function measure(fn: () => Promise<unknown> | unknown): Promise<number> {
  await fn(); // warm up
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = Bun.nanoseconds();
    await fn();
    samples.push((Bun.nanoseconds() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

const mib = (bytes: number, ms: number) => (bytes / 1024 / 1024 / (ms / 1000)).toFixed(0);
const pad = (s: string | number, n: number) => String(s).padStart(n);

console.log(`bun ${Bun.version} — median of ${RUNS} runs\n`);

for (const set of DATASETS) {
  console.log(`## ${set.name} (${(set.bytes / 1024 / 1024).toFixed(1)} MiB)`);

  const ours = await zip(set.files);
  const theirs = zipSync(set.files);

  const createOurs = await measure(() => zip(set.files));
  const createTheirs = await measure(() => zipSync(set.files));
  const readTheirs = await measure(() => unzipSync(theirs));

  // fflate's unzipSync does not verify CRC-32, so the headline read matches that
  // to compare like for like; the verified cost is reported next to it.
  const readAuto = await measure(() => unzip(ours, { verifyCrc: false }));
  const readVerified = await measure(() => unzip(ours));
  const readBuffered = await measure(() =>
    unzip(ours, { maxInflateBuffer: -1, verifyCrc: false }),
  );
  const readStreaming = await measure(() => unzip(ours, { maxInflateBuffer: 0, verifyCrc: false }));

  const row = (label: string, create: number | undefined, read: number, size?: number) =>
    console.log(
      `${pad(label, 20)} ${pad(create === undefined ? "-" : `${create.toFixed(1)}ms`, 9)} ` +
        `${pad(create === undefined ? "-" : mib(set.bytes, create), 7)} ` +
        `${pad(`${read.toFixed(1)}ms`, 9)} ${pad(mib(set.bytes, read), 7)} ` +
        `${pad(size === undefined ? "" : size, 10)}`,
    );

  console.log(
    `${pad("", 20)} ${pad("create", 9)} ${pad("MiB/s", 7)} ${pad("read", 9)} ${pad("MiB/s", 7)} ${pad("archive", 10)}`,
  );
  row("bun-zipper", createOurs, readAuto, ours.length);
  row("  · verifying CRC", undefined, readVerified);
  row("  · maxInflateBuffer -1", undefined, readBuffered);
  row("  · maxInflateBuffer 0", undefined, readStreaming);
  row("fflate", createTheirs, readTheirs, theirs.length);
  console.log(
    `${pad("vs fflate", 20)} ${pad(`${(createTheirs / createOurs).toFixed(2)}x`, 9)} ${pad("", 7)} ` +
      `${pad(`${(readTheirs / readAuto).toFixed(2)}x`, 9)} ${pad("", 7)} ` +
      `${pad(`${((ours.length / theirs.length - 1) * 100).toFixed(1)}%`, 10)}`,
  );
  console.log();
}
