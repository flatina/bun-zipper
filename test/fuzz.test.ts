import { describe, expect, test } from "bun:test";
import { sanitizeEntryPath, unzip, ZipError, ZipSecurityError, zip } from "../src/index.ts";

/**
 * Hand-picked corrupt archives only prove the failures someone thought of. This
 * asserts the property instead: whatever the bytes say, reading them ends in a
 * `ZipError` or a clean read — never a raw TypeError, RangeError or hang.
 *
 * Seeds are fixed, so a failure reproduces. Promote one to `regression.test.ts`
 * as a fixed case rather than leaving the seed to carry it.
 */

/** Deterministic pseudo-random, so a failing case is nameable. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Deflated and stored entries, a directory, a comment, non-ASCII — several shapes to hit. */
function sample(): Promise<Uint8Array> {
  return zip({
    "a.txt": "hello world ".repeat(40),
    "dir/b.bin": new Uint8Array(300).fill(7),
    "한글.txt": "안녕하세요",
    "empty/": "",
  });
}

type Outcome = "read" | "refused";

async function readSurvives(bytes: Uint8Array, label: string): Promise<Outcome> {
  try {
    await unzip(bytes);
    return "read";
  } catch (error) {
    if (error instanceof ZipError) return "refused";
    const e = error as Error;
    throw new Error(`${label}: escaped as ${e.name}: ${e.message}`);
  }
}

/** Proves the loop ran and that the damage actually reached the parser. */
function expectSomeRefused(outcomes: Outcome[], total: number): void {
  expect(outcomes).toHaveLength(total);
  expect(outcomes.filter((o) => o === "refused").length).toBeGreaterThan(0);
}

describe("mutated archives", () => {
  test("single flipped bits", async () => {
    const archive = await sample();
    const outcomes: Outcome[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const rng = random(seed);
      const bytes = archive.slice();
      const at = Math.floor(rng() * bytes.length);
      bytes[at] = bytes[at]! ^ (1 << Math.floor(rng() * 8));
      outcomes.push(await readSurvives(bytes, `seed ${seed}`));
    }
    expectSomeRefused(outcomes, 300);
    // Slack bytes exist — comments, unused fields — so a mutation that changes
    // nothing observable is expected. All-refused would mean the damage never
    // varied and the run proved less than it looks.
    expect(outcomes.filter((o) => o === "read").length).toBeGreaterThan(0);
  });

  test("clobbered field-sized runs", async () => {
    // Whole fields at once, which is what produces absurd lengths and offsets —
    // the values a single flipped bit rarely reaches.
    const archive = await sample();
    const outcomes: Outcome[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const rng = random(seed);
      const bytes = archive.slice();
      const width = [2, 4, 8][Math.floor(rng() * 3)]!;
      const at = Math.floor(rng() * Math.max(bytes.length - width, 1));
      for (let i = 0; i < width; i++) bytes[at + i] = Math.floor(rng() * 256);
      outcomes.push(await readSurvives(bytes, `seed ${seed}`));
    }
    expectSomeRefused(outcomes, 300);
    // Slack bytes exist — comments, unused fields — so a mutation that changes
    // nothing observable is expected. All-refused would mean the damage never
    // varied and the run proved less than it looks.
    expect(outcomes.filter((o) => o === "read").length).toBeGreaterThan(0);
  });
});

describe("truncated archives", () => {
  test("every cut point", async () => {
    const archive = await sample();
    const outcomes: Outcome[] = [];
    for (let cut = 0; cut < archive.length; cut += 7) {
      outcomes.push(await readSurvives(archive.subarray(0, cut), `cut at ${cut}`));
    }
    expectSomeRefused(outcomes, outcomes.length);
  });

  test("trailing junk after a complete archive", async () => {
    const archive = await sample();
    const outcomes: Outcome[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const rng = random(seed);
      const junk = new Uint8Array(Math.floor(rng() * 200) + 1);
      for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rng() * 256);
      const bytes = new Uint8Array(archive.length + junk.length);
      bytes.set(archive);
      bytes.set(junk, archive.length);
      outcomes.push(await readSurvives(bytes, `seed ${seed}`));
    }
    // Junk past the EOCD is legal — self-extracting stubs do it — so these read.
    expect(outcomes.filter((o) => o === "read").length).toBeGreaterThan(0);
  });
});

describe("entry names", () => {
  // The characters that carry meaning to a filesystem, weighted to collide.
  const ALPHABET = [..."ab/\\.: <>|*?\0", "..", "C:", "//", "CON", "NUL.txt", "한"];

  test("a surviving name can only be relative and inside", async () => {
    let survived = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = random(seed);
      let name = "";
      const parts = 1 + Math.floor(rng() * 6);
      for (let i = 0; i < parts; i++) name += ALPHABET[Math.floor(rng() * ALPHABET.length)];

      let result: string;
      try {
        result = sanitizeEntryPath(name);
      } catch (error) {
        if (error instanceof ZipSecurityError) continue;
        throw new Error(`${JSON.stringify(name)}: escaped as ${(error as Error).name}`);
      }
      survived++;
      expect(result.split("/")).not.toContain("..");
      expect(result.startsWith("/")).toBe(false);
      expect(/^[a-zA-Z]:/.test(result)).toBe(false);
      expect(result).not.toContain("\\");
      expect(result).not.toContain("\0");
      expect(result).not.toBe("");
    }
    expect(survived).toBeGreaterThan(0);
  });
});

describe("caller input", () => {
  test("names and comments at the 16-bit boundary", async () => {
    // The axis a round-trip cannot cover: we would encode and decode our own
    // misunderstanding identically and see nothing wrong.
    for (const length of [0xfffe, 0xffff]) {
      await expect(zip({ ["x".repeat(length)]: "ok" })).resolves.toBeInstanceOf(Uint8Array);
    }
    for (const length of [0x10000, 0x10001]) {
      await expect(zip({ ["x".repeat(length)]: "ok" })).rejects.toThrow(ZipError);
    }
  });
});
