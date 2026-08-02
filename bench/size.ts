/**
 * Regenerates the size table in the README.
 *
 *   bun run bench/size.ts            # print the table
 *   bun run bench/size.ts --check    # fail if this package outgrew its ceiling
 *
 * Every entry point is built from source with the same flags, so the numbers
 * compare the libraries rather than their release pipelines. fflate therefore
 * builds from a source clone rather than node_modules' prebuilt ESM; point
 * `BUN_ZIPPER_FFLATE_SRC` at its `src/index.ts`. Without it the comparison
 * column is skipped and says so.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Gzipped bytes for the whole API. Raise deliberately; a silent drift is the thing to catch. */
const CEILING = 10_500;

const ROOT = join(import.meta.dir, "..");
const STAGING = join(ROOT, ".tmp/size-entries");
const FFLATE = process.env.BUN_ZIPPER_FFLATE_SRC;

/** Named exports per row, or `*` for the whole surface. */
const ROWS = [
  { label: "create only", ours: ["zip"], theirs: ["zipSync"] },
  { label: "read only", ours: ["unzip"], theirs: ["unzipSync"] },
  {
    label: "streaming both ways",
    ours: ["ZipWriter", "ZipReader"],
    // fflate's stream classes are unusable without these: Zip takes ZipDeflate
    // entries, and Unzip needs UnzipInflate registered before it yields data.
    theirs: ["Zip", "ZipDeflate", "Unzip", "UnzipInflate"],
  },
  { label: "everything", ours: ["*"], theirs: ["*"] },
] as const;

/** Referencing the imports through a global keeps the bundler from shaking them away. */
function entrySource(from: string, names: readonly string[]): string {
  if (names[0] === "*") {
    return `import * as api from ${JSON.stringify(from)};\nglobalThis.__keep = api;\n`;
  }
  const list = names.join(", ");
  return `import { ${list} } from ${JSON.stringify(from)};\nglobalThis.__keep = { ${list} };\n`;
}

async function measure(name: string, from: string, names: readonly string[]): Promise<number> {
  const entry = join(STAGING, `${name}.ts`);
  await writeFile(entry, entrySource(from, names));
  const built = await Bun.build({ entrypoints: [entry], minify: true, target: "bun" });
  if (!built.success) throw new AggregateError(built.logs, `could not build ${name}`);
  const code = await built.outputs[0]!.text();
  return Bun.gzipSync(new TextEncoder().encode(code), { level: 9 }).length;
}

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

await rm(STAGING, { recursive: true, force: true });
await mkdir(STAGING, { recursive: true });

const ours = join(ROOT, "src/index.ts");
const rows: { label: string; ours: number; theirs: number | undefined }[] = [];
for (const [i, row] of ROWS.entries()) {
  rows.push({
    label: row.label,
    ours: await measure(`ours-${i}`, ours, row.ours),
    theirs: FFLATE ? await measure(`theirs-${i}`, FFLATE, row.theirs) : undefined,
  });
}
await rm(STAGING, { recursive: true, force: true });

if (!FFLATE) {
  console.warn("SKIPPING the fflate column — set BUN_ZIPPER_FFLATE_SRC to its src/index.ts\n");
}

console.log("| | bun-zipper | fflate |");
console.log("|---|---|---|");
for (const row of rows) {
  const theirs = row.theirs === undefined ? "—" : kB(row.theirs);
  console.log(`| ${row.label} | **${kB(row.ours)}** | ${theirs} |`);
}

const total = rows.at(-1)!.ours;
if (process.argv.includes("--check")) {
  if (total > CEILING) {
    console.error(`\nthe whole API is ${total} B gzipped, over the ${CEILING} B ceiling`);
    process.exit(1);
  }
  console.log(`\nwhole API ${total} B gzipped, under the ${CEILING} B ceiling`);
}
