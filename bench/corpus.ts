/**
 * The files fflate benchmarks against, so the numbers here line up with the ones
 * that project publishes. Fetched on demand and cached under .tmp/, never
 * committed — their licences are not ours to redistribute.
 *
 * The Gutenberg path fflate hardcodes now 404s; this uses the current one for
 * the same text.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const CACHE = join(import.meta.dir, "..", ".tmp", "bench-data");

const SOURCES: Record<string, string> = {
  text: "https://www.gutenberg.org/cache/epub/2701/pg2701.txt",
  smallImage: "https://hlevkin.com/hlevkin/TestImages/new/Rainier.bmp",
  image: "https://www.hlevkin.com/hlevkin/TestImages/new/Maltese.bmp",
  largeImage: "https://www.hlevkin.com/hlevkin/TestImages/new/Sunrise.bmp",
  model3D: "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/3mf/truck.3mf",
};

export type Corpus = Record<string, Uint8Array>;

/** Returns what could be fetched, and names what could not rather than pretending. */
export async function loadCorpus(names: readonly string[]): Promise<Corpus> {
  await mkdir(CACHE, { recursive: true });
  const out: Corpus = {};

  for (const name of names) {
    const url = SOURCES[name];
    if (!url) throw new Error(`unknown corpus entry: ${name}`);
    const path = join(CACHE, name);

    const cached = Bun.file(path);
    if (await cached.exists()) {
      out[name] = new Uint8Array(await cached.arrayBuffer());
      continue;
    }
    process.stdout.write(`  fetching ${name}... `);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await Bun.write(path, bytes);
      out[name] = bytes;
      console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);
    } catch (error) {
      console.log(`FAILED (${(error as Error).message}) — skipping`);
    }
  }
  return out;
}
