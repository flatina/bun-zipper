import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { extractZip, unzip, zip } from "../src/index.ts";

/**
 * Fixtures prove the cases someone thought of. These generate trees instead —
 * varying depth, count, size, entropy and name charset — and check that another
 * implementation reads what this one wrote and vice versa.
 *
 * Comparison is by names, bytes and CRC, never by archive bytes: two correct
 * writers legitimately produce different files.
 */

/**
 * Deterministic, so a failing tree is reproducible from its seed. Scrambled and
 * warmed first: seeded with 1, 2, 3… this LCG's first output barely moves, and
 * every "different" tree came out the same size.
 */
function random(seed: number): () => number {
  let s = ((seed >>> 0) * 2654435761) >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  next();
  next();
  next();
  return next;
}

const NAME_PARTS = ["a", "dir", "sub", "데이터", "テスト", "with space", "dots.in.name", "UPPER"];

/** A tree whose shape, contents and names all vary with the seed. */
function tree(seed: number): Record<string, Uint8Array> {
  const rng = random(seed);
  const files: Record<string, Uint8Array> = {};
  const count = 1 + Math.floor(rng() * 12);

  for (let i = 0; i < count; i++) {
    const depth = Math.floor(rng() * 3);
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) parts.push(NAME_PARTS[Math.floor(rng() * NAME_PARTS.length)]!);
    parts.push(`f${i}-${NAME_PARTS[Math.floor(rng() * NAME_PARTS.length)]}.bin`);
    const name = parts.join("/");
    if (name in files) continue;

    const size = Math.floor(rng() * 40_000);
    const data = new Uint8Array(size);
    // Entropy varies so both stored and deflated entries occur, and so the
    // compressor's choices differ between the two implementations.
    const entropy = rng();
    for (let b = 0; b < size; b++) {
      data[b] = entropy < 0.4 ? 0x41 + (b % 4) : Math.floor(rng() * 256);
    }
    files[name] = data;
  }
  return files;
}

function sameContents(a: Record<string, Uint8Array>, b: Record<string, Uint8Array>): void {
  expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  for (const [name, data] of Object.entries(a)) expect(b[name]).toEqual(data);
}

const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

describe("fflate reads what this writes", () => {
  test("every generated tree", async () => {
    for (const seed of SEEDS) {
      const files = tree(seed);
      const archive = await zip(files);
      const out = unzipSync(archive as Uint8Array<ArrayBuffer>);
      sameContents(files, out as unknown as Record<string, Uint8Array>);
    }
  });
});

describe("this reads what fflate writes", () => {
  test("every generated tree", async () => {
    for (const seed of SEEDS) {
      const files = tree(seed);
      const archive = zipSync(
        Object.fromEntries(
          Object.entries(files).map(([k, v]) => [k, v as Uint8Array<ArrayBuffer>]),
        ),
      );
      // fflate verifies no CRC on read, so its archives are the only side of this
      // comparison that could hide a bad checksum. Ours are checked either way.
      const out = await unzip(archive);
      sameContents(files, Object.fromEntries(out));
    }
  });
});

describe("extraction matches the archive", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-zipper-diff-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function walk(root: string): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = {};
    const pending = [root];
    while (pending.length > 0) {
      const at = pending.pop()!;
      for (const name of await readdir(at)) {
        const path = join(at, name);
        if ((await stat(path)).isDirectory()) pending.push(path);
        else out[relativePath(root, path).replaceAll("\\", "/")] = await Bun.file(path).bytes();
      }
    }
    return out;
  }

  /**
   * Names that are legal in a ZIP and mean different things per filesystem. The
   * verdict has to be the same everywhere, so these run on all three CI
   * platforms and the assertion is refusal, not a particular error.
   */
  const AMBIGUOUS = [
    ["A.txt", "a.txt"],
    ["A/x.txt", "a/y.txt"],
    ["dir/f.txt", "DIR/g.txt"],
    ["café.txt".normalize("NFC"), "café.txt".normalize("NFD")],
    ["x", "x/y.txt"],
    ["a/b", "a/b/c.txt"],
  ];

  test("names that fold together are refused, on whatever filesystem", async () => {
    for (const [first, second] of AMBIGUOUS) {
      const files: Record<string, string> = {};
      files[first!] = "1";
      files[second!] = "2";
      await expect(extractZip(await zip(files), join(dir, "x"))).rejects.toThrow();
      // Refused as a whole: a partial extraction is the outcome that differs by
      // platform, which is what makes it worse than failing.
      expect(await Bun.file(join(dir, "x")).exists()).toBe(false);
    }
  });

  test("what fflate wrote extracts to the same tree", async () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const files = tree(seed);
      const archive = zipSync(
        Object.fromEntries(
          Object.entries(files).map(([k, v]) => [k, v as Uint8Array<ArrayBuffer>]),
        ),
      );
      const into = join(dir, `s${seed}`);
      await extractZip(archive, into);
      sameContents(files, await walk(into));
    }
  });
});
