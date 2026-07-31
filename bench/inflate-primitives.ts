/** Which inflate primitive is fastest, per payload shape. */
import { inflateSync as fflateInflate, deflateSync as fflateDeflate } from "fflate";

let s = 11 >>> 0;
const rng = () => {
  s = (s * 1664525 + 1013904223) >>> 0;
  return s / 0x100000000;
};

/** Bun's zlib bindings are typed against ArrayBuffer-backed views only. */
function incompressible(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 256) | 0;
  return out;
}
function prose(n: number): Uint8Array<ArrayBuffer> {
  const words = "the quick brown fox jumps over a lazy dog while parsing zip headers".split(" ");
  let text = "";
  while (text.length < n) text += `${words[Math.floor(rng() * words.length)]} `;
  return new TextEncoder().encode(text.slice(0, n));
}

const RUNS = 9;
async function measure(label: string, fn: () => unknown | Promise<unknown>): Promise<number> {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = Bun.nanoseconds();
    await fn();
    samples.push((Bun.nanoseconds() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  console.log(`    ${label.padEnd(30)} ${median.toFixed(3)}ms`);
  return median;
}

for (const [name, data] of [
  ["10 MB incompressible", incompressible(10 * 1024 * 1024)],
  ["20 MB text", prose(20 * 1024 * 1024)],
] as const) {
  // Raw deflate stream, the shape ZIP method 8 stores.
  const raw = Bun.deflateSync(data, { windowBits: -15 });
  console.log(`\n## ${name} — ${data.length} -> ${raw.length} bytes`);

  const bun = await measure("Bun.inflateSync", () =>
    Bun.inflateSync(raw as Uint8Array<ArrayBuffer>, { windowBits: -15 }),
  );
  const stream = await measure("DecompressionStream", async () => {
    const rs = new Blob([raw as Uint8Array<ArrayBuffer>]).stream();
    return new Response(rs.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  });
  const ff = await measure("fflate inflateSync", () => fflateInflate(raw));
  console.log(
    `    -> fastest: ${[
      ["Bun.inflateSync", bun],
      ["DecompressionStream", stream],
      ["fflate", ff],
    ].sort((a, b) => (a[1] as number) - (b[1] as number))[0]![0]}`,
  );

  // And the same for compression, since the writer has the mirror choice.
  console.log("  compress:");
  await measure("Bun.deflateSync", () => Bun.deflateSync(data, { windowBits: -15 }));
  await measure("fflate deflateSync", () => fflateDeflate(data));
}
